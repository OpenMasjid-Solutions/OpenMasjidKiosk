// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.readers

import android.content.Context
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
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

    /** Readers from the current discovery round, kept so [connect] can resolve a serial → Reader. */
    private var lastDiscovered: List<Reader> = emptyList()
    private var discoveryCancelable: Cancelable? = null
    private var connectedSerial: String? = null

    /** Bumped on every scan start AND every cancel. A discovery round's listener/callback captures
     *  its generation and ignores late events once a newer round (or a cancel/connect) has moved on,
     *  so a stale onFailure can't clobber a fresh Discovering/Connecting state. */
    private var discoveryGen = 0

    // ---- Initialisation ----------------------------------------------------------------

    /** Idempotently create the Terminal instance. Safe to call from the main thread; it does not
     *  fetch a token or touch Bluetooth until discovery/connect actually runs. */
    fun ensureInitialized(context: Context, repository: KioskRepository) {
        repo = repository
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
     *  runtime permissions (see [org.openmasjidos.kiosk.readers.readerPermissions]). */
    fun startDiscovery(transport: ReaderTransport) {
        if (!Terminal.isInitialized()) {
            _state.update { it.copy(error = "Reader isn’t ready yet.") }
            return
        }
        // Don't disturb an in-flight connect/update — the admin would see a confusing bounce.
        if (_state.value.conn == ReaderConn.Connecting || _state.value.conn == ReaderConn.Updating) return
        cancelDiscovery()
        lastDiscovered = emptyList()
        val gen = ++discoveryGen
        repo?.log("info", "reader_scan_start", transport.name.lowercase())
        _state.update {
            it.copy(transport = transport, conn = ReaderConn.Discovering, discovered = emptyList(), error = null)
        }
        val config = when (transport) {
            ReaderTransport.Bluetooth -> BluetoothDiscoveryConfiguration(0, isSimulated = false)
            ReaderTransport.Simulated -> BluetoothDiscoveryConfiguration(0, isSimulated = true)
            ReaderTransport.Usb -> UsbDiscoveryConfiguration(0, isSimulated = false)
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
            }
        }
        discoveryCancelable = Terminal.getInstance().discoverReaders(
            config,
            listener,
            object : Callback {
                override fun onSuccess() { /* discovery ended (usually because we cancelled) */ }
                override fun onFailure(e: TerminalException) {
                    if (gen != discoveryGen) return
                    repo?.log("error", "reader_scan_failed", e.errorMessage)
                    _state.update { it.copy(conn = ReaderConn.Error, error = friendly(e)) }
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

    /** Surface a message on the reader card (used by the UI when a permission is denied). */
    fun reportError(message: String) = _state.update { it.copy(error = message) }

    // ---- Connect / disconnect ----------------------------------------------------------

    /** Connect the discovered reader with [serial] to [locationId] (Terminal readers must belong
     *  to a Location — configured in Admin → Payments and pushed to the kiosk in its config). */
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
        cancelDiscovery()
        repo?.log("info", "reader_connect_start", serial)
        _state.update { it.copy(conn = ReaderConn.Connecting, error = null) }
        // SDK 5.6.0 names the reader-listener param per transport (both take a MobileReaderListener).
        val config = if (_state.value.transport == ReaderTransport.Usb) {
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
                    repo?.log("info", "reader_connected", reader.serialNumber ?: "")
                    _state.update {
                        it.copy(conn = ReaderConn.Connected, connectedLabel = labelFor(reader), discovered = emptyList(), error = null)
                    }
                }

                override fun onFailure(e: TerminalException) {
                    repo?.log("error", "reader_connect_failed", e.errorMessage)
                    _state.update { it.copy(conn = ReaderConn.Error, error = friendly(e)) }
                }
            },
        )
    }

    fun disconnect() {
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
            _state.update { it.copy(conn = ReaderConn.NotConnected, connectedLabel = null, battery = null) }
        }

        override fun onReaderReconnectStarted(reader: Reader, cancelReconnect: Cancelable, reason: DisconnectReason) {
            _state.update { it.copy(conn = ReaderConn.Connecting) }
        }

        override fun onReaderReconnectSucceeded(reader: Reader) {
            _state.update { it.copy(conn = ReaderConn.Connected, error = null) }
        }

        override fun onReaderReconnectFailed(reader: Reader) {
            connectedSerial = null
            _state.update { it.copy(conn = ReaderConn.NotConnected, connectedLabel = null, error = "The reader disconnected. Reconnect it below.") }
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

    private fun friendly(e: TerminalException): String =
        e.errorMessage.ifBlank { "Something went wrong with the reader. Try again." }

    /** Turn an SDK ReaderDisplayMessage enum name (e.g. "INSERT_OR_SWIPE_CARD") into readable text
     *  without hard-coding the enum values (which vary by SDK version). */
    private fun prettifyReaderMessage(raw: String): String =
        raw.lowercase().replace('_', ' ').replaceFirstChar { it.uppercase() }
}
