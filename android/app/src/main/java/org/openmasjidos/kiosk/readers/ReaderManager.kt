// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.readers

import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.stripe.stripeterminal.Terminal
import com.stripe.stripeterminal.external.callable.Callback
import com.stripe.stripeterminal.external.callable.Cancelable
import com.stripe.stripeterminal.external.callable.ConnectionTokenCallback
import com.stripe.stripeterminal.external.callable.ConnectionTokenProvider
import com.stripe.stripeterminal.external.callable.DiscoveryListener
import com.stripe.stripeterminal.external.callable.MobileReaderListener
import com.stripe.stripeterminal.external.callable.ReaderCallback
import com.stripe.stripeterminal.external.callable.TerminalListener
import com.stripe.stripeterminal.external.models.BatteryStatus
import com.stripe.stripeterminal.external.models.ConnectionConfiguration.BluetoothConnectionConfiguration
import com.stripe.stripeterminal.external.models.ConnectionConfiguration.UsbConnectionConfiguration
import com.stripe.stripeterminal.external.models.ConnectionStatus
import com.stripe.stripeterminal.external.models.ConnectionTokenException
import com.stripe.stripeterminal.external.models.DisconnectReason
import com.stripe.stripeterminal.external.models.DiscoveryConfiguration.BluetoothDiscoveryConfiguration
import com.stripe.stripeterminal.external.models.DiscoveryConfiguration.UsbDiscoveryConfiguration
import com.stripe.stripeterminal.external.models.PaymentStatus
import com.stripe.stripeterminal.external.models.Reader
import com.stripe.stripeterminal.external.models.ReaderDisplayMessage
import com.stripe.stripeterminal.external.models.ReaderInputOptions
import com.stripe.stripeterminal.external.models.ReaderSoftwareUpdate
import com.stripe.stripeterminal.external.models.TerminalException
import com.stripe.stripeterminal.log.LogLevel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.openmasjidos.kiosk.net.KioskRepository

/** How the tablet talks to the reader. Simulated uses Stripe's built-in mock reader (no hardware). */
enum class ReaderTransport { Bluetooth, Usb, Simulated }

/** Coarse connection state for the maintenance UI + heartbeat. */
enum class ReaderConn { NotConnected, Discovering, Connecting, Connected, Updating, Error }

/** A reader the UI can list and pick (the real [Reader] is held internally by serial). */
data class DiscoveredReader(val serial: String, val label: String)

/** Immutable snapshot the maintenance screen renders. */
data class ReaderUiState(
    val initialized: Boolean = false,
    val transport: ReaderTransport = ReaderTransport.Bluetooth,
    val conn: ReaderConn = ReaderConn.NotConnected,
    val discovered: List<DiscoveredReader> = emptyList(),
    val connectedLabel: String? = null,
    val battery: Int? = null,          // 0..100
    val charging: Boolean? = null,
    val updateProgress: Int? = null,   // 0..100 while an update installs
    val updateAvailable: Boolean = false,
    val error: String? = null,
    // Reader prompt text ("Insert or tap card", …). Populated during the slice-6 collect flow.
    val prompt: String? = null,
)

/** What the heartbeat reports to the server ({@code readerStatus/readerSerial/readerBattery}). */
data class ReaderStatusSnapshot(val status: String, val serial: String?, val battery: Int?)

/**
 * The single owner of all Stripe Terminal SDK interaction (M2 reader over Bluetooth AND USB, plus
 * Stripe's simulated reader for testing without hardware). Isolating every Terminal call here keeps
 * the SDK's surface in one place and off the rest of the app.
 *
 * A process singleton because [Terminal] itself is a singleton: the maintenance UI and the
 * background heartbeat both read the current reader status from here.
 *
 * SECURITY: the only Stripe credential this ever holds is a short-lived **connection token**,
 * fetched server-side via [KioskRepository.getConnectionToken] (which mints it from the secret key
 * that never leaves the server). Card data is handled entirely by the reader + SDK; our code never
 * sees a PAN.
 */
object ReaderManager {

    private val _state = MutableStateFlow(ReaderUiState())
    val state: StateFlow<ReaderUiState> = _state.asStateFlow()

    /** The repository the connection-token provider calls. Set on first init. */
    @Volatile private var repo: KioskRepository? = null
    /** App context, kept so the auto-connect path can check its own runtime permissions. */
    @Volatile private var appContext: Context? = null
    /** Log the "needs location permission" warning only once, not every retry. */
    private var loggedPermWarning = false
    /** Fire-and-forget scope for persisting the remembered reader (so boot can reconnect it). */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Readers from the current discovery round, kept so [connect] can resolve a serial → Reader. */
    private var lastDiscovered: List<Reader> = emptyList()
    private var discoveryCancelable: Cancelable? = null
    private var connectedSerial: String? = null
    /** Which transport the current/last connection used — drives whether a drop auto-reconnects. */
    @Volatile private var connectedTransport: ReaderTransport? = null

    // ---- Auto-connect: keep the kiosk's reader connected with no interaction --------------------
    // A USB reader is plug-and-play (connect the one that's attached). A Bluetooth reader, once the
    // admin connects it in settings, is REMEMBERED (by serial) and gets the same treatment: connect
    // it on boot and reconnect it whenever it drops. The remembered choice is persisted so a reboot
    // reconnects the right reader.
    @Volatile private var autoEnabled = false
    @Volatile private var autoTransport: ReaderTransport = ReaderTransport.Usb
    @Volatile private var autoSerial: String? = null // Bluetooth: the specific reader to reconnect
    @Volatile private var autoLocationId = ""
    @Volatile private var autoConnecting = false // guards against double-connecting within a round
    private var autoFailures = 0                  // for reconnect backoff after repeated failures
    private val mainHandler = Handler(Looper.getMainLooper())
    private val reconnectRunnable = Runnable { tryAutoConnect() }

    /** Bumped on every scan start AND every cancel. A discovery round's listener/callback captures
     *  its generation and ignores late events once a newer round (or a cancel/connect) has moved on,
     *  so a stale onFailure can't clobber a fresh Discovering/Connecting state. */
    private var discoveryGen = 0

    // ---- Initialisation ----------------------------------------------------------------

    /** Idempotently create the Terminal instance. Safe to call from the main thread; it does not
     *  fetch a token or touch Bluetooth until discovery/connect actually runs. */
    fun ensureInitialized(context: Context, repository: KioskRepository) {
        repo = repository
        appContext = context.applicationContext
        if (Terminal.isInitialized()) {
            _state.update { it.copy(initialized = true) }
            return
        }
        Terminal.init(
            context.applicationContext,
            LogLevel.ERROR,
            connectionTokenProvider,
            terminalListener,
            null,
        )
        _state.update { it.copy(initialized = true) }
    }

    private val connectionTokenProvider = object : ConnectionTokenProvider {
        override fun fetchConnectionToken(callback: ConnectionTokenCallback) {
            // Called by the SDK on its own worker thread, so blocking here is fine.
            val r = repo
            if (r == null) {
                callback.onFailure(ConnectionTokenException("Reader isn’t set up yet."))
                return
            }
            try {
                val token = runBlocking { r.getConnectionToken() }
                r.log("info", "reader_token_ok")
                callback.onSuccess(token)
            } catch (e: Exception) {
                // Surfaces the SERVER's reason (e.g. "Payments aren't set up yet.") in Devices → Logs,
                // which is the usual cause of "the reader won't connect".
                val why = e.message ?: "server unreachable"
                r.log("error", "reader_token_failed", why)
                callback.onFailure(ConnectionTokenException("Couldn’t get a reader token: $why", e))
            }
        }
    }

    private val terminalListener = object : TerminalListener {
        override fun onConnectionStatusChange(status: ConnectionStatus) {
            if (status == ConnectionStatus.NOT_CONNECTED) {
                connectedSerial = null
                _state.update { it.copy(conn = ReaderConn.NotConnected, connectedLabel = null, battery = null) }
            }
        }

        override fun onPaymentStatusChange(status: PaymentStatus) { /* used by the slice-6 flow */ }
    }

    // ---- Discovery ---------------------------------------------------------------------

    /** Start scanning for readers over [transport]. Callers must have already obtained the needed
     *  runtime permissions (see [org.openmasjidos.kiosk.readers.readerPermissions]). When [auto] is
     *  true (USB startup path), the first reader found is connected automatically with no UI. */
    fun startDiscovery(transport: ReaderTransport, auto: Boolean = false) {
        if (!Terminal.isInitialized()) {
            _state.update { it.copy(error = "Reader isn’t ready yet.") }
            return
        }
        // Don't disturb an in-flight connect/update — the admin would see a confusing bounce.
        if (_state.value.conn == ReaderConn.Connecting || _state.value.conn == ReaderConn.Updating) return
        cancelDiscovery()
        lastDiscovered = emptyList()
        autoConnecting = false
        val gen = ++discoveryGen
        repo?.log("info", "reader_scan_start", if (auto) "${transport.name.lowercase()} (auto)" else transport.name.lowercase())
        _state.update {
            it.copy(transport = transport, conn = ReaderConn.Discovering, discovered = emptyList(), error = null)
        }
        // Manual scans run until stopped (timeout 0); the USB auto-scan is time-bounded so it ends
        // (and goes idle) instead of "looking forever" on a kiosk that actually uses Bluetooth.
        val timeout = if (auto) 15 else 0
        val config = when (transport) {
            ReaderTransport.Bluetooth -> BluetoothDiscoveryConfiguration(timeout, isSimulated = false)
            ReaderTransport.Simulated -> BluetoothDiscoveryConfiguration(timeout, isSimulated = true)
            ReaderTransport.Usb -> UsbDiscoveryConfiguration(timeout, isSimulated = false)
        }
        var lastLoggedCount = -1
        // Listener + completion callback both capture `gen` and no-op once superseded.
        val listener = object : DiscoveryListener {
            override fun onUpdateDiscoveredReaders(readers: List<Reader>) {
                if (gen != discoveryGen) return
                lastDiscovered = readers
                if (readers.size != lastLoggedCount) {
                    lastLoggedCount = readers.size
                    repo?.log("info", "reader_found", "${readers.size} reader(s)")
                }
                _state.update {
                    it.copy(discovered = readers.map { r -> DiscoveredReader(r.serialNumber ?: "", labelFor(r)) })
                }
                // Auto path: connect once, with no interaction. USB connects the attached reader;
                // Bluetooth connects the remembered one (by serial) so we don't grab a stranger's.
                if (auto && !autoConnecting && autoLocationId.isNotBlank()) {
                    val target = autoSerial?.takeIf { it.isNotBlank() }
                        ?.let { s -> readers.firstOrNull { it.serialNumber == s } }
                        ?: if (transport == ReaderTransport.Usb) readers.firstOrNull() else null
                    if (target != null) {
                        autoConnecting = true
                        repo?.log("info", "reader_auto_connect", target.serialNumber ?: "")
                        connectReaderInternal(target, autoLocationId, transport)
                    }
                }
            }
        }
        discoveryCancelable = Terminal.getInstance().discoverReaders(
            config,
            listener,
            object : Callback {
                override fun onSuccess() {
                    // Discovery ended. For the timed USB auto-scan, if nothing connected, drop back to
                    // idle rather than sitting on "Discovering" forever (don't re-loop — a disconnect
                    // or a config change is what re-arms it).
                    if (gen == discoveryGen && auto && !autoConnecting && _state.value.conn == ReaderConn.Discovering) {
                        _state.update { it.copy(conn = ReaderConn.NotConnected) }
                    }
                }
                override fun onFailure(e: TerminalException) {
                    if (gen != discoveryGen) return
                    repo?.log("error", "reader_scan_failed", "${e.errorCode} · ${e.errorMessage}")
                    _state.update { it.copy(conn = ReaderConn.Error, error = friendly(e)) }
                    if (auto && autoEnabled) scheduleReconnect(fresh = false)
                }
            },
        )
    }

    fun stopDiscovery() {
        val wasDiscovering = _state.value.conn == ReaderConn.Discovering
        cancelDiscovery()
        if (wasDiscovering) {
            _state.update { it.copy(conn = ReaderConn.NotConnected) }
        }
    }

    private fun cancelDiscovery() {
        discoveryGen++ // invalidate any in-flight round's listener/callback
        discoveryCancelable?.let { c ->
            runCatching {
                if (!c.isCompleted) c.cancel(object : Callback {
                    override fun onSuccess() {}
                    override fun onFailure(e: TerminalException) {}
                })
            }
        }
        discoveryCancelable = null
    }

    /** Cancel any in-flight discovery and invoke [onDone] only AFTER it has actually stopped (plus a
     *  small settle delay so the BLE stack is quiet), with a hard fallback so we never hang. Used
     *  before connect — connecting while a scan is still tearing down drops the reader. */
    private fun cancelDiscoveryThen(onDone: () -> Unit) {
        discoveryGen++ // invalidate any in-flight round's listener/callback
        val c = discoveryCancelable
        discoveryCancelable = null
        var done = false
        val finish = {
            if (!done) {
                done = true
                onDone()
            }
        }
        if (c == null || c.isCompleted) {
            mainHandler.postDelayed({ finish() }, 250)
            return
        }
        runCatching {
            c.cancel(object : Callback {
                override fun onSuccess() { mainHandler.postDelayed({ finish() }, 250) }
                override fun onFailure(e: TerminalException) { mainHandler.postDelayed({ finish() }, 250) }
            })
        }.onFailure { mainHandler.postDelayed({ finish() }, 250) }
        // Hard fallback: proceed even if the cancel callback never fires.
        mainHandler.postDelayed({ finish() }, 1_500)
    }

    /** Surface a message on the reader card (used by the UI when a permission is denied). */
    fun reportError(message: String) = _state.update { it.copy(error = message) }

    // ---- Connect / disconnect ----------------------------------------------------------

    /** Connect the discovered reader with [serial] to [locationId] (Terminal readers must belong
     *  to a Location — configured in Admin → Payments and pushed to the kiosk in its config). Used
     *  by the manual (Bluetooth) settings flow; auto-connect uses [enableAutoConnect]. A successful
     *  connect here is remembered so the reader auto-reconnects on boot + on drop. */
    fun connect(serial: String, locationId: String) {
        if (locationId.isBlank()) {
            _state.update { it.copy(error = "No card-reader location set. Ask an admin to finish Payments setup.") }
            return
        }
        val reader = lastDiscovered.firstOrNull { it.serialNumber == serial }
        if (reader == null) {
            _state.update { it.copy(error = "That reader is no longer nearby. Scan again.") }
            return
        }
        connectReaderInternal(reader, locationId, _state.value.transport, manual = true)
    }

    /** Shared connect: used by the manual picker and the USB/BLE auto-connect path.
     *
     *  IMPORTANT: we FULLY STOP discovery and wait for it to finish BEFORE calling connectReader.
     *  Connecting to the M2 while a BLE scan is still tearing down is the textbook trigger for
     *  "Bluetooth unexpectedly disconnected during operation" (Stripe issue #83/#348), and it's
     *  deterministic because the old code cancelled fire-and-forget and connected on the next line.
     *  We also re-bind to the FRESHEST discovered object for this serial (Stripe: never connect a
     *  stale reader object). */
    private fun connectReaderInternal(reader: Reader, locationId: String, transport: ReaderTransport, manual: Boolean = false) {
        repo?.log("info", "reader_connect_start", reader.serialNumber ?: "")
        _state.update { it.copy(conn = ReaderConn.Connecting, error = null) }
        val targetSerial = reader.serialNumber
        cancelDiscoveryThen {
            // Re-resolve to the newest object for this serial (discovery may have re-reported it).
            val fresh = targetSerial?.let { s -> lastDiscovered.firstOrNull { it.serialNumber == s } } ?: reader
            doConnectReader(fresh, locationId, transport, manual)
        }
    }

    private fun doConnectReader(reader: Reader, locationId: String, transport: ReaderTransport, manual: Boolean) {
        // SDK 5.6.0 names the reader-listener param per transport (both take a MobileReaderListener).
        val config = if (transport == ReaderTransport.Usb) {
            UsbConnectionConfiguration(locationId, autoReconnectOnUnexpectedDisconnect = true, usbReaderListener = readerListener)
        } else {
            BluetoothConnectionConfiguration(locationId, autoReconnectOnUnexpectedDisconnect = true, bluetoothReaderListener = readerListener)
        }
        Terminal.getInstance().connectReader(
            reader,
            config,
            object : ReaderCallback {
                override fun onSuccess(reader: Reader) {
                    connectedSerial = reader.serialNumber
                    connectedTransport = transport
                    autoConnecting = false
                    autoFailures = 0
                    manualConnectRetries = 0
                    repo?.log("info", "reader_connected", reader.serialNumber ?: "")
                    // Remember this reader (real transports only, not the test reader) so it auto-
                    // reconnects on drop and on boot — Bluetooth is tracked by serial, USB by "attached".
                    if (transport != ReaderTransport.Simulated) {
                        autoEnabled = true
                        autoTransport = transport
                        autoSerial = if (transport == ReaderTransport.Bluetooth) reader.serialNumber else null
                        autoLocationId = locationId
                        val r = repo
                        scope.launch { runCatching { r?.saveLastReader(transport.name, reader.serialNumber) } }
                    }
                    _state.update {
                        it.copy(conn = ReaderConn.Connected, connectedLabel = labelFor(reader), discovered = emptyList(), error = null)
                    }
                }

                override fun onFailure(e: TerminalException) {
                    autoConnecting = false
                    // Log the errorCode too (not just the message) so a BLUETOOTH_DISCONNECTED can be
                    // told apart from an update/location/permission failure in Devices → Logs.
                    repo?.log("error", "reader_connect_failed", "${e.errorCode} · ${e.errorMessage}")
                    // A first connect that drops with a transient Bluetooth error usually succeeds on a
                    // clean retry (fresh discovery, no stale object). Retry a couple of times before
                    // surfacing the error + operational guidance to the admin.
                    if (manual && isRetriableConnectError(e) && manualConnectRetries < MAX_MANUAL_CONNECT_RETRIES) {
                        manualConnectRetries++
                        repo?.log("warn", "reader_connect_retry", "attempt $manualConnectRetries")
                        _state.update { it.copy(conn = ReaderConn.Discovering, error = null) }
                        val serial = connectRetrySerial ?: reader.serialNumber
                        mainHandler.postDelayed({ rediscoverAndConnect(serial, locationId, transport) }, 2_000L * manualConnectRetries)
                        return
                    }
                    manualConnectRetries = 0
                    _state.update { it.copy(conn = ReaderConn.Error, error = friendly(e)) }
                    // Auto path: keep trying so the reader eventually comes up on its own (backoff).
                    if (autoEnabled && transport == autoTransport) scheduleReconnect(fresh = false)
                }
            },
        )
    }

    // The serial we're (re)trying to connect manually, so a retry can re-find it after a clean scan.
    @Volatile private var connectRetrySerial: String? = null
    @Volatile private var manualConnectRetries = 0

    /** Retry a manual connect the clean way: run a fresh short discovery for [serial], then connect
     *  the newly-found object (never a cached one). Used after a transient Bluetooth connect drop. */
    private fun rediscoverAndConnect(serial: String?, locationId: String, transport: ReaderTransport) {
        if (serial.isNullOrBlank() || !Terminal.isInitialized()) {
            _state.update { it.copy(conn = ReaderConn.Error, error = "Couldn’t reach the reader. Scan again.") }
            return
        }
        if (Terminal.getInstance().connectedReader != null) return
        connectRetrySerial = serial
        cancelDiscoveryThen {
            val gen = ++discoveryGen
            _state.update { it.copy(conn = ReaderConn.Discovering, error = null) }
            val config = if (transport == ReaderTransport.Usb) UsbDiscoveryConfiguration(12, isSimulated = false)
            else BluetoothDiscoveryConfiguration(12, isSimulated = false)
            var connecting = false
            val listener = object : DiscoveryListener {
                override fun onUpdateDiscoveredReaders(readers: List<Reader>) {
                    if (gen != discoveryGen) return
                    lastDiscovered = readers
                    val target = readers.firstOrNull { it.serialNumber == serial }
                    if (target != null && !connecting) {
                        connecting = true
                        connectReaderInternal(target, locationId, transport, manual = true)
                    }
                }
            }
            discoveryCancelable = Terminal.getInstance().discoverReaders(config, listener, object : Callback {
                override fun onSuccess() {
                    if (gen == discoveryGen && !connecting && _state.value.conn == ReaderConn.Discovering) {
                        _state.update { it.copy(conn = ReaderConn.Error, error = "The reader didn’t answer. Move it closer, make sure it’s on, and try again.") }
                    }
                }
                override fun onFailure(e: TerminalException) {
                    if (gen != discoveryGen) return
                    repo?.log("error", "reader_scan_failed", "${e.errorCode} · ${e.errorMessage}")
                    _state.update { it.copy(conn = ReaderConn.Error, error = friendly(e)) }
                }
            })
        }
    }

    /** A connect drop we should retry cleanly (a transient Bluetooth teardown), vs a hard error we
     *  should surface (auth, location off, permission). */
    private fun isRetriableConnectError(e: TerminalException): Boolean {
        val s = "${e.errorCode} ${e.errorMessage}".lowercase()
        return "bluetooth" in s || "disconnect" in s || "unexpected" in s || "timeout" in s || "timed out" in s
    }

    /**
     * Turn on auto-connect for [transport] (USB = the attached reader; Bluetooth = the remembered
     * one, by [serial]): connect it now and reconnect it whenever it drops, with no UI. Called on
     * startup once a card-reader [locationId] is known (Payments set up). Safe to call repeatedly —
     * it no-ops when already connected/connecting.
     */
    fun enableAutoConnect(transport: ReaderTransport, serial: String?, locationId: String) {
        val changed = autoTransport != transport || autoSerial != serial || autoLocationId != locationId
        autoEnabled = true
        autoTransport = transport
        autoSerial = serial?.takeIf { it.isNotBlank() }
        autoLocationId = locationId
        if (changed) { autoFailures = 0; loggedPermWarning = false }
        tryAutoConnect()
    }

    /** Re-attempt auto-connect (e.g. after the location/Bluetooth permission was just granted). */
    fun retryAutoConnect() {
        autoFailures = 0
        loggedPermWarning = false
        tryAutoConnect()
    }

    /** Discovery needs runtime permission (location for USB; +Bluetooth on 31+). Device-owner setup
     *  grants it silently; a non-owner tablet is asked at startup / when scanning BLE in settings. If
     *  it's still missing we must NOT start discovery (it would fail and spin a retry loop) — fail
     *  soft and wait to be re-armed by [retryAutoConnect]. */
    private fun hasAutoPermission(): Boolean {
        val ctx = appContext ?: return false
        return readerPermissions(autoTransport).all {
            ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun tryAutoConnect() {
        if (!autoEnabled || autoLocationId.isBlank()) return
        if (!Terminal.isInitialized()) return
        if (Terminal.getInstance().connectedReader != null) return
        when (_state.value.conn) {
            ReaderConn.Connecting, ReaderConn.Updating, ReaderConn.Connected -> return
            // Don't hijack a manual scan the admin started in settings for a different transport.
            ReaderConn.Discovering -> if (_state.value.transport != autoTransport) return
            else -> Unit
        }
        if (!hasAutoPermission()) {
            // No permission yet → don't scan (and don't schedule a retry — that would loop forever).
            // Re-armed by retryAutoConnect() when the permission is granted, or on next config change.
            if (!loggedPermWarning) {
                loggedPermWarning = true
                repo?.log("warn", "reader_no_permission", "grant location/Bluetooth so the reader can connect")
            }
            return
        }
        startDiscovery(autoTransport, auto = true)
    }

    /** Schedule a reconnect. [fresh] (an unexpected drop) retries fast; repeated connect failures
     *  back off (1.5s → capped 30s) so a wedged reader can't spin a tight loop. */
    private fun scheduleReconnect(fresh: Boolean) {
        if (!autoEnabled) return
        autoFailures = if (fresh) 0 else (autoFailures + 1).coerceAtMost(4)
        val delay = (1_500L shl autoFailures).coerceAtMost(30_000L)
        mainHandler.removeCallbacks(reconnectRunnable)
        mainHandler.postDelayed(reconnectRunnable, delay)
    }

    fun disconnect() {
        // Deliberate disconnect (admin, in settings): stop auto-connect and clear the transport FIRST
        // so the resulting onDisconnect callback doesn't treat it as a drop and immediately reconnect.
        autoEnabled = false
        autoSerial = null
        connectedTransport = null
        mainHandler.removeCallbacks(reconnectRunnable)
        scope.launch { runCatching { repo?.saveLastReader("", null) } } // forget the remembered reader
        if (!Terminal.isInitialized() || Terminal.getInstance().connectedReader == null) {
            connectedSerial = null
            _state.update { it.copy(conn = ReaderConn.NotConnected, connectedLabel = null, battery = null) }
            return
        }
        Terminal.getInstance().disconnectReader(object : Callback {
            override fun onSuccess() {
                connectedSerial = null
                _state.update { it.copy(conn = ReaderConn.NotConnected, connectedLabel = null, battery = null, updateAvailable = false) }
            }
            override fun onFailure(e: TerminalException) {
                _state.update { it.copy(error = friendly(e)) }
            }
        })
    }

    /** Install a firmware update the reader reported. The reader is unusable while it installs. */
    fun installUpdate() {
        if (Terminal.isInitialized()) runCatching { Terminal.getInstance().installAvailableUpdate() }
    }

    private val readerListener = object : MobileReaderListener {
        override fun onReportAvailableUpdate(update: ReaderSoftwareUpdate) {
            // A required firmware update on connect is the usual reason a reader "won't connect" —
            // it needs ≥50% battery and can take a few minutes. Log it so it's visible.
            repo?.log("warn", "reader_update_available")
            _state.update { it.copy(updateAvailable = true) }
        }

        override fun onStartInstallingUpdate(update: ReaderSoftwareUpdate, cancelable: Cancelable?) {
            repo?.log("warn", "reader_update_installing", "keep powered — can take a few minutes")
            _state.update { it.copy(conn = ReaderConn.Updating, updateProgress = 0, updateAvailable = true) }
        }

        override fun onReportReaderSoftwareUpdateProgress(progress: Float) {
            _state.update { it.copy(updateProgress = (progress * 100).toInt().coerceIn(0, 100)) }
        }

        override fun onFinishInstallingUpdate(update: ReaderSoftwareUpdate?, e: TerminalException?) {
            repo?.log(if (e != null) "error" else "info", "reader_update_finished", e?.errorMessage ?: "ok")
            val connected = Terminal.isInitialized() && Terminal.getInstance().connectedReader != null
            _state.update {
                it.copy(
                    conn = if (connected) ReaderConn.Connected else ReaderConn.NotConnected,
                    updateProgress = null,
                    updateAvailable = false,
                    error = e?.let { ex -> friendly(ex) },
                )
            }
        }

        override fun onReportLowBatteryWarning() {
            repo?.log("warn", "reader_low_battery", "charge the reader to ≥50% for firmware updates")
        }

        override fun onBatteryLevelUpdate(batteryLevel: Float, batteryStatus: BatteryStatus, isCharging: Boolean) {
            _state.update { it.copy(battery = (batteryLevel * 100).toInt().coerceIn(0, 100), charging = isCharging) }
        }

        override fun onDisconnect(reason: DisconnectReason) {
            repo?.log("warn", "reader_disconnected", reason.toString())
            connectedSerial = null
            val wasAuto = connectedTransport == autoTransport
            connectedTransport = null
            _state.update { it.copy(conn = ReaderConn.NotConnected, connectedLabel = null, battery = null) }
            // The reader is a fixed kiosk fitting — repair the moment it drops (cable jiggle, BT blip,
            // power dip). Applies to whichever transport we're auto-managing (USB or the paired BLE).
            if (autoEnabled && wasAuto) scheduleReconnect(fresh = true)
        }

        override fun onReaderReconnectStarted(reader: Reader, cancelReconnect: Cancelable, reason: DisconnectReason) {
            _state.update { it.copy(conn = ReaderConn.Connecting) }
        }

        override fun onReaderReconnectSucceeded(reader: Reader) {
            autoFailures = 0
            _state.update { it.copy(conn = ReaderConn.Connected, error = null) }
        }

        override fun onReaderReconnectFailed(reader: Reader) {
            connectedSerial = null
            val wasAuto = connectedTransport == autoTransport
            connectedTransport = null
            _state.update { it.copy(conn = ReaderConn.NotConnected, connectedLabel = null, error = "The reader disconnected. Reconnecting…") }
            // The SDK's own auto-reconnect gave up — re-discover + reconnect ourselves.
            if (autoEnabled && wasAuto) scheduleReconnect(fresh = true)
        }

        // During a payment the reader tells us what to show the donor ("Insert or tap card",
        // "Remove card", …). The giving flow surfaces `prompt` on the card screen.
        override fun onRequestReaderInput(options: ReaderInputOptions) {
            _state.update { it.copy(prompt = "Tap, insert or swipe your card") }
        }

        override fun onRequestReaderDisplayMessage(message: ReaderDisplayMessage) {
            _state.update { it.copy(prompt = prettifyReaderMessage(message.toString())) }
        }
    }

    /** Clear the transient reader prompt (called when a donation flow ends/resets). */
    fun clearPrompt() = _state.update { it.copy(prompt = null) }

    // ---- Heartbeat snapshot ------------------------------------------------------------

    /** Current reader status for the heartbeat. Reads local state only (no SDK call), so it's safe
     *  to call from the WorkManager backstop even before the Terminal is initialised. */
    fun statusForHeartbeat(): ReaderStatusSnapshot {
        val s = _state.value
        val status = when (s.conn) {
            ReaderConn.Connected -> "connected"
            ReaderConn.Connecting -> "connecting"
            ReaderConn.Discovering -> "discovering"
            ReaderConn.Updating -> "updating"
            ReaderConn.Error -> "error"
            ReaderConn.NotConnected -> "not_connected"
        }
        return ReaderStatusSnapshot(status, connectedSerial, s.battery)
    }

    fun clearError() = _state.update { it.copy(error = null) }

    // ---- Helpers -----------------------------------------------------------------------

    private fun labelFor(reader: Reader): String {
        val serial = reader.serialNumber?.takeIf { it.isNotBlank() }
        return if (serial != null) "Card reader ($serial)" else "Card reader"
    }

    private fun friendly(e: TerminalException): String {
        val msg = e.errorMessage
        val low = msg.lowercase()
        // The M2's most common Bluetooth failure — "Bluetooth unexpectedly disconnected during
        // operation" — is almost always one of two operational causes, so guide the admin to the fix
        // rather than showing a bare error. (Stripe: don't pair via Android Bluetooth settings; a
        // first-connect firmware update needs ≥50% battery.)
        if ("bluetooth" in low && ("disconnect" in low || "shutdown" in low || "unexpected" in low)) {
            return "The Bluetooth reader dropped. Two things fix this almost every time: 1) do NOT pair " +
                "the reader in the tablet's Bluetooth settings — if you did, tap Forget there — and connect " +
                "it only from here; 2) charge the reader to at least 50% (its first connection may install a " +
                "required update). Then keep it close and tap Find again."
        }
        return msg.ifBlank { "Something went wrong with the reader. Try again." }
    }

    /** Turn an SDK ReaderDisplayMessage enum name (e.g. "INSERT_OR_SWIPE_CARD") into readable text
     *  without hard-coding the enum values (which vary by SDK version). */
    private fun prettifyReaderMessage(raw: String): String =
        raw.lowercase().replace('_', ' ').replaceFirstChar { it.uppercase() }
}
