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
import org.openmasjidos.kiosk.net.HeartbeatOutcome
import org.openmasjidos.kiosk.net.PairResult
import org.openmasjidos.kiosk.readers.PaymentController
import org.openmasjidos.kiosk.readers.ReaderConn
import org.openmasjidos.kiosk.readers.ReaderManager
import org.openmasjidos.kiosk.readers.ReaderTransport
import org.openmasjidos.kiosk.readers.ReaderUiState
import java.util.UUID
import org.openmasjidos.kiosk.work.HeartbeatWorker

/** Top-level screen the kiosk is showing. */
enum class Phase { Loading, Unpaired, Paired }

/** Overlay shown on top of the attract screen in the Paired phase. */
enum class Overlay { None, Pin, Maintenance }

/** The donor-facing giving flow (Paired phase). Idle = the attract screen. */
enum class GivingStep { Idle, Amount, Details, Card, Thanks, Error }

/** State of an in-progress donation. Amounts are integer MINOR units (validated server-side). */
data class GivingState(
    val step: GivingStep = GivingStep.Idle,
    val amountMinor: Long = 0L,
    val donorName: String = "",
    val donorEmail: String = "",
    val busy: Boolean = false,
    val error: String? = null,
)

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
    val giving: GivingState = GivingState(),
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
    private val startedAtMs = System.currentTimeMillis() // for the uptime stat in maintenance

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
        val giving: GivingState = GivingState(),
        val latestAppVersion: String = "",
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
            giving = l.giving,
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


    // ---- Giving flow (donor-facing) ----------------------------------------------------

    private var givingJob: Job? = null

    private fun updateGiving(f: (GivingState) -> GivingState) = local.update { it.copy(giving = f(it.giving)) }

    /** Donor tapped "Tap to donate" on the attract screen. */
    fun beginGiving() = updateGiving { GivingState(step = GivingStep.Amount) }

    /** Return to the attract screen; also cancels any in-progress card collection. */
    fun cancelGiving() {
        givingJob?.cancel()
        PaymentController.cancelCollect()
        ReaderManager.clearPrompt()
        updateGiving { GivingState() }
    }

    fun setDonorName(v: String) = updateGiving { it.copy(donorName = v.take(120)) }
    fun setDonorEmail(v: String) = updateGiving { it.copy(donorEmail = v.take(200)) }

    /** Pick an amount (minor units). Goes to the details step when the admin asks for name/email,
     *  otherwise straight to the card. */
    fun chooseAmount(amountMinor: Long) {
        if (amountMinor <= 0) return
        val cfg = ui.value.config
        val wantsDetails = (cfg?.namePolicy ?: "off") != "off" || (cfg?.emailPolicy ?: "off") != "off"
        updateGiving { it.copy(amountMinor = amountMinor, error = null, step = if (wantsDetails) GivingStep.Details else GivingStep.Card) }
        if (!wantsDetails) startCollect()
    }

    /** Continue from the details step (validating required name/email). */
    fun submitDetails() {
        val cfg = ui.value.config
        val g = local.value.giving
        when {
            cfg?.namePolicy == "required" && g.donorName.isBlank() ->
                updateGiving { it.copy(error = "Please enter your name.") }
            cfg?.emailPolicy == "required" && !isEmail(g.donorEmail) ->
                updateGiving { it.copy(error = "Please enter a valid email for your receipt.") }
            g.donorEmail.isNotBlank() && !isEmail(g.donorEmail) ->
                updateGiving { it.copy(error = "That email doesn’t look right.") }
            else -> {
                updateGiving { it.copy(error = null, step = GivingStep.Card) }
                startCollect()
            }
        }
    }

    /** From the error screen, try the same amount again. */
    fun retryGiving() = updateGiving { GivingState(step = GivingStep.Amount) }

    private fun startCollect() {
        val g = local.value.giving
        if (ui.value.reader.conn != ReaderConn.Connected) {
            updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "The card reader isn’t connected. Please tell a volunteer.") }
            return
        }
        updateGiving { it.copy(step = GivingStep.Card, busy = true, error = null) }
        givingJob?.cancel()
        givingJob = viewModelScope.launch {
            val name = g.donorName.trim().ifBlank { null }
            val email = g.donorEmail.trim().ifBlank { null }
            val idem = UUID.randomUUID().toString()
            val pi = runCatching { repo.createPaymentIntent(g.amountMinor, name, email, idem) }.getOrNull()
            if (pi == null) {
                repo.log("warn", "donation_create_failed")
                updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "Couldn’t start the payment. Please try again.") }
                return@launch
            }
            val piId = runCatching { PaymentController.collectAndConfirm(pi.clientSecret) }.getOrNull()
            ReaderManager.clearPrompt()
            if (piId == null) {
                repo.log("warn", "donation_collect_failed", pi.id)
                updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "That didn’t go through — no charge was made. Try again?") }
                return@launch
            }
            val result = runCatching { repo.completePaymentIntent(piId) }.getOrNull()
            if (result?.succeeded == true) {
                repo.log("info", "donation_succeeded", piId)
                updateGiving { it.copy(step = GivingStep.Thanks, busy = false) }
                viewModelScope.launch {
                    delay(THANKS_MS)
                    if (local.value.giving.step == GivingStep.Thanks) updateGiving { GivingState() }
                }
            } else {
                repo.log("warn", "donation_not_succeeded", piId)
                updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "That didn’t complete. If your card was charged it will be refunded.") }
            }
            repo.flushLogs()
        }
    }

    private fun isEmail(s: String): Boolean {
        val t = s.trim()
        return t.length in 3..200 && t.contains('@') && t.substringAfter('@').contains('.')
    }

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

    /** Records a rapid tap on the attract screen; 7 within 3s reveals the unlock/settings path. */
    fun onSecretTap() {
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
                        local.update {
                            it.copy(lastHeartbeatMs = System.currentTimeMillis(), online = true, latestAppVersion = outcome.latestAppVersion)
                        }
                        if (outcome.identify) flashIdentify()
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
        latestAppVersion = l.latestAppVersion,
        pinnedCertSha256 = pairing?.certSha256,
        deviceId = pairing?.deviceId,
        serverUrl = pairing?.serverUrl,
        lastHeartbeatMs = l.lastHeartbeatMs,
        online = l.online,
        uptimeMs = System.currentTimeMillis() - startedAtMs,
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
        // How long the thank-you screen stays up before returning to attract.
        const val THANKS_MS = 8_000L
        const val SECRET_TAPS = 7
        const val SECRET_WINDOW_MS = 3_000L
        const val FREE_ATTEMPTS = 3
        const val BACKOFF_BASE_SECONDS = 5L
        const val MAX_BACKOFF_SECONDS = 300L
    }
}
