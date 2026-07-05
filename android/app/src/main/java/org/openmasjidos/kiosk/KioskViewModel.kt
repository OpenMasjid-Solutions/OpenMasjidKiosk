// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.openmasjidos.kiosk.local.Diagnostics
import org.openmasjidos.kiosk.local.KioskConfig
import org.openmasjidos.kiosk.local.PairingRecord
import org.openmasjidos.kiosk.kiosk.DeviceStatus
import org.openmasjidos.kiosk.kiosk.KioskController
import org.openmasjidos.kiosk.net.HeartbeatOutcome
import org.openmasjidos.kiosk.net.PairResult
import org.openmasjidos.kiosk.readers.ReaderManager
import org.openmasjidos.kiosk.readers.ReaderTransport
import org.openmasjidos.kiosk.readers.ReaderUiState
import org.openmasjidos.kiosk.work.HeartbeatWorker

/** Top-level screen the kiosk is showing. */
enum class Phase { Loading, Unpaired, Paired }

/** Overlay shown on top of the attract screen in the Paired phase. */
enum class Overlay { None, Pin, Maintenance }

/**
 * Why the kiosk is demanding a re-pair (a fail-closed lockout that blocks everything).
 * Currently only a changed server certificate triggers this; a *revoke* instead wipes the
 * pairing and drops straight back to the pairing screen (no lockout needed).
 */
enum class RePairReason { CertChanged }

/** The pairing form the volunteer fills in (URL + 6-digit code + a friendly name). */
data class PairingForm(
    val url: String = "https://",
    val code: String = "",
    val name: String = "",
    val busy: Boolean = false,
    val error: PairResult.Reason? = null,
)

/** Transient PIN-pad state (attempts + exponential backoff live in memory for slice 4). */
data class PinState(
    val verifying: Boolean = false,
    val wrong: Boolean = false,
    val attempts: Int = 0,
    val lockedUntilMs: Long = 0L,
)

/** The single immutable snapshot the UI renders. */
data class UiState(
    val phase: Phase = Phase.Loading,
    val config: KioskConfig? = null,
    val form: PairingForm = PairingForm(),
    val overlay: Overlay = Overlay.None,
    val rePair: RePairReason? = null,
    val pin: PinState = PinState(),
    val identify: Boolean = false,
    val diagnostics: Diagnostics = Diagnostics(),
    val reader: ReaderUiState = ReaderUiState(),
    // Leaving kiosk mode requires a VERIFIED exit PIN this session — not merely a blank local
    // pinHash (which can just mean config hasn't synced yet). Maintenance stays reachable for
    // reader setup/diagnostics without a PIN, but "Exit kiosk" is gated on this.
    val exitAllowed: Boolean = false,
)

/**
 * Drives the whole kiosk state machine: Loading → (Unpaired ⇄ pairing) → Paired, plus the
 * PIN/maintenance overlays and the re-pair lockout. Persistent truth (pairing + config) is
 * observed reactively from the store; ephemeral UI (form, overlay, pin backoff, identify pulse,
 * live diagnostics) lives in [local]. The two are combined into one [UiState].
 */
class KioskViewModel(app: Application) : AndroidViewModel(app) {

    private val repo = (app as KioskApp).repository
    private val appContext = app.applicationContext

    /** Ephemeral, in-memory UI that never needs persisting. */
    private data class Local(
        val form: PairingForm,
        val overlay: Overlay = Overlay.None,
        val rePair: RePairReason? = null,
        val pin: PinState = PinState(),
        val identify: Boolean = false,
        val battery: Int? = null,
        val charging: Boolean? = null,
        val lastHeartbeatMs: Long? = null,
        val online: Boolean = false,
        val maintUnlockedViaPin: Boolean = false,
    )

    private val local = MutableStateFlow(Local(form = PairingForm(name = Build.MODEL ?: "Kiosk")))

    val ui: StateFlow<UiState> = combine(repo.pairing, repo.config, local, ReaderManager.state) { pairing, config, l, reader ->
        UiState(
            phase = if (pairing == null) Phase.Unpaired else Phase.Paired,
            config = config,
            form = l.form,
            overlay = l.overlay,
            rePair = l.rePair,
            pin = l.pin,
            identify = l.identify,
            diagnostics = buildDiagnostics(pairing, l, reader),
            reader = reader,
            exitAllowed = l.maintUnlockedViaPin,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000L), UiState())

    private var heartbeatLoop: Job? = null

    /** Called once from the activity: schedule the backstop and run the loop while paired. */
    fun start() {
        HeartbeatWorker.schedule(appContext)
        // Create the Terminal instance up front (no Bluetooth/token work happens until an admin
        // actually scans/connects in maintenance) so the reader section is ready and the heartbeat
        // can report reader status.
        runCatching { ReaderManager.ensureInitialized(appContext, repo) }
        viewModelScope.launch {
            repo.pairing.collect { pairing ->
                if (pairing != null) startHeartbeatLoop() else stopHeartbeatLoop()
            }
        }
    }

    // ---- Card reader (maintenance screen) ----------------------------------------------

    /** Begin discovery over [transport]. Permissions are requested by the UI first. */
    fun scanForReaders(transport: ReaderTransport) {
        ReaderManager.ensureInitialized(appContext, repo)
        ReaderManager.startDiscovery(transport)
        repo.log("info", "reader_scan", transport.name.lowercase())
    }

    fun stopReaderScan() = ReaderManager.stopDiscovery()

    fun connectReader(serial: String) {
        val locationId = ui.value.config?.locationId.orEmpty()
        ReaderManager.connect(serial, locationId)
        repo.log("info", "reader_connect", serial)
    }

    fun disconnectReader() {
        ReaderManager.disconnect()
        repo.log("info", "reader_disconnect")
    }

    fun installReaderUpdate() {
        ReaderManager.installUpdate()
        repo.log("info", "reader_update_install")
    }

    fun dismissReaderError() = ReaderManager.clearError()

    /** The volunteer denied a reader permission — tell them how to recover (silent no-op otherwise). */
    fun onReaderPermissionDenied() =
        ReaderManager.reportError(appContext.getString(R.string.reader_permission_denied))

    // ---- Pairing form actions ----------------------------------------------------------

    fun onUrlChange(value: String) = local.update { it.copy(form = it.form.copy(url = value, error = null)) }

    fun onCodeChange(value: String) {
        val digits = value.filter(Char::isDigit).take(6)
        local.update { it.copy(form = it.form.copy(code = digits, error = null)) }
    }

    fun onNameChange(value: String) = local.update { it.copy(form = it.form.copy(name = value)) }

    fun pair() {
        val form = local.value.form
        if (form.busy) return
        viewModelScope.launch {
            local.update { it.copy(form = it.form.copy(busy = true, error = null)) }
            when (val result = repo.pair(form.url, form.code, form.name)) {
                is PairResult.Success ->
                    local.update { it.copy(form = it.form.copy(busy = false)) }
                is PairResult.Failed ->
                    local.update { it.copy(form = it.form.copy(busy = false, error = result.reason)) }
            }
        }
    }

    // ---- Hidden gesture / PIN ----------------------------------------------------------

    private val cornerTaps = ArrayDeque<Long>()

    /** Records a tap in the hidden top-start corner; 5 within 3s reveals the unlock path. */
    fun onSecretCornerTap() {
        val now = System.currentTimeMillis()
        cornerTaps.addLast(now)
        while (cornerTaps.isNotEmpty() && now - cornerTaps.first() > SECRET_WINDOW_MS) cornerTaps.removeFirst()
        if (cornerTaps.size >= SECRET_TAPS) {
            cornerTaps.clear()
            // If no exit PIN is set locally, still open maintenance (so a fresh kiosk isn't bricked
            // for reader setup/diagnostics) — but WITHOUT exit rights: leaving kiosk mode requires a
            // verified PIN, so a not-yet-synced PIN can't be bypassed by catching this window.
            val hasPin = ui.value.config?.pinHash?.isNotBlank() == true
            local.update {
                it.copy(overlay = if (hasPin) Overlay.Pin else Overlay.Maintenance, maintUnlockedViaPin = false)
            }
        }
    }

    fun submitPin(pin: String) {
        val state = local.value
        val now = System.currentTimeMillis()
        if (state.pin.verifying || now < state.pin.lockedUntilMs) return
        val hash = ui.value.config?.pinHash.orEmpty()
        viewModelScope.launch {
            local.update { it.copy(pin = it.pin.copy(verifying = true, wrong = false)) }
            val ok = hash.isNotBlank() && repo.verifyPin(pin, hash)
            if (ok) {
                repo.log("info", "kiosk_unlocked")
                local.update { it.copy(overlay = Overlay.Maintenance, pin = PinState(), maintUnlockedViaPin = true) }
            } else {
                local.update {
                    val attempts = it.pin.attempts + 1
                    it.copy(pin = it.pin.copy(verifying = false, wrong = true, attempts = attempts, lockedUntilMs = backoffUntil(attempts)))
                }
                repo.log("warn", "pin_failed")
            }
        }
    }

    fun closeOverlay() = local.update {
        it.copy(overlay = Overlay.None, pin = it.pin.copy(wrong = false), maintUnlockedViaPin = false)
    }

    /** Wipe the local pairing and return to the pairing screen (re-pair / after revoke). */
    fun rePair() {
        viewModelScope.launch {
            repo.clearPairing()
            local.update {
                it.copy(
                    overlay = Overlay.None,
                    rePair = null,
                    pin = PinState(),
                    form = PairingForm(name = Build.MODEL ?: "Kiosk"),
                )
            }
        }
    }

    // ---- Heartbeat loop ----------------------------------------------------------------

    private fun startHeartbeatLoop() {
        if (heartbeatLoop?.isActive == true) return
        heartbeatLoop = viewModelScope.launch {
            while (isActive) {
                val battery = DeviceStatus.battery(appContext)
                local.update { it.copy(battery = battery.level, charging = battery.charging) }
                val reader = ReaderManager.statusForHeartbeat()
                when (val outcome = repo.heartbeat(
                    battery.level,
                    battery.charging,
                    readerStatus = reader.status,
                    readerSerial = reader.serial,
                    readerBattery = reader.battery,
                )) {
                    is HeartbeatOutcome.Ok -> {
                        local.update { it.copy(lastHeartbeatMs = System.currentTimeMillis(), online = true) }
                        if (outcome.identify) flashIdentify()
                        if (outcome.reboot) {
                            repo.log("warn", "reboot_requested")
                            repo.flushLogs() // best-effort deliver the log before we go down
                            KioskController.reboot(appContext)
                        }
                    }
                    HeartbeatOutcome.Revoked ->
                        // repo already wiped the pairing → the pairing flow flips us to Unpaired,
                        // returning the volunteer to the pairing screen (no lockout for a revoke).
                        local.update { it.copy(online = false) }
                    HeartbeatOutcome.CertMismatch ->
                        local.update { it.copy(rePair = RePairReason.CertChanged, online = false) }
                    HeartbeatOutcome.NetworkError ->
                        local.update { it.copy(online = false) }
                    HeartbeatOutcome.NotPaired -> return@launch
                }
                repo.flushLogs()
                delay(HEARTBEAT_INTERVAL_MS)
            }
        }
    }

    private fun stopHeartbeatLoop() {
        heartbeatLoop?.cancel()
        heartbeatLoop = null
    }

    private var identifyJob: Job? = null

    private fun flashIdentify() {
        identifyJob?.cancel()
        identifyJob = viewModelScope.launch {
            local.update { it.copy(identify = true) }
            delay(IDENTIFY_MS)
            local.update { it.copy(identify = false) }
        }
    }

    // ---- Helpers -----------------------------------------------------------------------

    private fun buildDiagnostics(pairing: PairingRecord?, l: Local, reader: ReaderUiState) = Diagnostics(
        battery = l.battery,
        charging = l.charging,
        readerStatus = ReaderManager.statusForHeartbeat().status,
        appVersion = DeviceStatus.appVersion(appContext),
        pinnedCertSha256 = pairing?.certSha256,
        deviceId = pairing?.deviceId,
        serverUrl = pairing?.serverUrl,
        lastHeartbeatMs = l.lastHeartbeatMs,
        online = l.online,
    )

    /** Exponential backoff after repeated wrong PINs; no lockout for the first few attempts. */
    private fun backoffUntil(attempts: Int): Long {
        if (attempts < FREE_ATTEMPTS) return 0L
        val steps = attempts - FREE_ATTEMPTS
        val seconds = (BACKOFF_BASE_SECONDS shl steps).coerceAtMost(MAX_BACKOFF_SECONDS)
        return System.currentTimeMillis() + seconds * 1000L
    }

    private companion object {
        // 15s (not 45s): with no server→tablet push, the heartbeat is also how "identify",
        // config changes and online status reach the kiosk — 45s made "flash to locate" feel
        // broken (nothing happened for most of a minute). 15s is still trivial LAN traffic.
        const val HEARTBEAT_INTERVAL_MS = 15_000L
        // Flash long enough to actually spot across a room and to span heartbeat jitter.
        const val IDENTIFY_MS = 12_000L
        const val SECRET_TAPS = 5
        const val SECRET_WINDOW_MS = 3_000L
        const val FREE_ATTEMPTS = 3
        const val BACKOFF_BASE_SECONDS = 5L
        const val MAX_BACKOFF_SECONDS = 300L
    }
}
