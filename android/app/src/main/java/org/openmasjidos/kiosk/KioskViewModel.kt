// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk

import android.app.Application
import android.os.Build
import com.stripe.android.PaymentConfiguration
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.openmasjidos.kiosk.local.Campaign
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

/** The donor-facing giving flow (Paired phase). The kiosk now boots straight into [Amount] (no
 *  attract screen); [Idle] is retained only as a defensive default. Processing = the card was read
 *  and we're verifying with the server (so the tap is acknowledged immediately). */
enum class GivingStep { Idle, Amount, Details, Card, Processing, Thanks, Error }

/** How long a non-main campaign tab may sit idle before the kiosk returns to the main tab. */
const val KIOSK_AUTO_RETURN_MS = 45_000L

/** Whether a requested monthly subscription was set up (drives the thank-you wording). */
enum class MonthlyOutcome { None, Created, NotSupported }

/** A one-shot request for the UI to present Stripe's on-device card form (keyed/manual entry).
 *  When [GivingState.manual] is non-null, KioskRoot presents PaymentSheet and reports the result. */
data class ManualEntry(val piId: String, val clientSecret: String, val publishableKey: String)

/** Outcome the UI reports back after presenting the manual card form. */
enum class ManualResult { Completed, Canceled, Failed }

/** State of an in-progress donation. Amounts are integer MINOR units (validated server-side).
 *  The resting state is [GivingStep.Amount] — the kiosk idles on the giving screen (no attract). */
data class GivingState(
    val step: GivingStep = GivingStep.Amount,
    val amountMinor: Long = 0L,
    val monthly: Boolean = false,
    /** Donor opted to cover the estimated card fee (only offered when the campaign allows it). */
    val coverFees: Boolean = false,
    val donorName: String = "",
    val donorEmail: String = "",
    val busy: Boolean = false,
    val error: String? = null,
    val monthlyOutcome: MonthlyOutcome = MonthlyOutcome.None,
    /** Non-null → the UI should present Stripe's card form for keyed/manual entry, then report back. */
    val manual: ManualEntry? = null,
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
    /** The live campaigns the kiosk shows as tabs (main first). Derived from [config]. */
    val campaigns: List<Campaign> = emptyList(),
    /** The campaign whose giving screen is currently shown (the selected tab). */
    val selectedCampaignId: String = "",
    /** The resolved active campaign (selected, or the main one). */
    val activeCampaign: Campaign? = null,
    /** When non-null, a non-main tab is idling and will return to the main tab at this monotonic
     *  wall-clock deadline's *start* — the UI draws a visual-only countdown ring from here + [KIOSK_AUTO_RETURN_MS]. */
    val autoReturnStartedMs: Long? = null,
    /** When non-null, the UI should open this URL (the server's APK download) in the browser so a
     *  person can install the update, then call [KioskViewModel.consumeOpenUpdate]. */
    val openUpdateUrl: String? = null,
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
        /** The selected campaign tab ('' = fall back to the main campaign). */
        val selectedCampaignId: String = "",
        /** When a non-main tab is idling, when its return-to-main countdown started (null = off). */
        val autoReturnStartedMs: Long? = null,
        val latestAppVersion: String = "",
        // Set when the admin (webui) or a maintainer (7-tap menu) asks this kiosk to update; the UI
        // opens the APK link in the browser to install (Android can't update an ordinary app itself).
        val openUpdatePending: Boolean = false,
    )

    private val local = MutableStateFlow(Local(form = PairingForm(name = Build.MODEL ?: "Kiosk")))

    val ui: StateFlow<UiState> = combine(repo.pairing, repo.config, local, ReaderManager.state) { pairing, config, l, reader ->
        // Campaigns shown as tabs (main first — the server already orders them that way).
        val campaigns = config?.campaigns.orEmpty()
        val active = campaigns.firstOrNull { it.id == l.selectedCampaignId } ?: config?.mainCampaign
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
            campaigns = campaigns,
            selectedCampaignId = active?.id.orEmpty(),
            activeCampaign = active,
            autoReturnStartedMs = l.autoReturnStartedMs,
            openUpdateUrl = if (l.openUpdatePending && pairing != null)
                pairing.serverUrl.trimEnd('/') + "/download/openmasjidkiosk.apk" else null,
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
        // Always pull the latest config once on launch (not only when the version bumps): after an app
        // update this repopulates fields a newer app version persists (e.g. the giving screen), which
        // an unchanged config version would otherwise never trigger a re-fetch for.
        viewModelScope.launch { runCatching { repo.fetchConfig() } }
        viewModelScope.launch {
            repo.pairing.collect { pairing ->
                if (pairing != null) startHeartbeatLoop() else stopHeartbeatLoop()
            }
        }
        // Keep the kiosk's reader connected with no setup, as soon as a card-reader Location is
        // configured: a USB reader is plug-and-play; a Bluetooth reader the admin connected once is
        // remembered and auto-reconnected (on boot + on drop) by its serial.
        //
        // Re-arm ONLY when the card-reader location actually changes (distinctUntilChanged) — NOT on
        // every config write. Otherwise an unrelated write (a giving edit, or disconnect()'s own
        // "forget the reader" write) would re-emit the config flow and immediately re-enable
        // auto-connect right after the admin tapped Disconnect, reconnecting the reader they just let go.
        viewModelScope.launch {
            repo.config
                .map { it?.locationId.orEmpty() }
                .distinctUntilChanged()
                .collect { locationId ->
                    if (locationId.isNotBlank()) {
                        val last = repo.getLastReader()
                        if (last != null && last.first == ReaderTransport.Bluetooth.name) {
                            ReaderManager.enableAutoConnect(ReaderTransport.Bluetooth, last.second, locationId)
                        } else {
                            ReaderManager.enableAutoConnect(ReaderTransport.Usb, null, locationId)
                        }
                    }
                }
        }
        // Initialise Stripe (for the manual card sheet) EARLY with the publishable key from config —
        // PaymentSheet fails immediately if PaymentConfiguration wasn't set up before it's presented.
        viewModelScope.launch {
            repo.config
                .map { it?.publishableKey.orEmpty() to (it?.manualEntryEnabled == true) }
                .distinctUntilChanged()
                .collect { (pk, manual) ->
                    if (manual && pk.isNotBlank()) runCatching { PaymentConfiguration.init(appContext, pk) }
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

    // ---- App update (browser install) --------------------------------------------------
    // Android can't update an ordinary app itself, so "update" = open the server's APK link in the
    // browser (Chrome) so a person can download + install it — the same path used to install the app
    // the first time. Triggered either by a maintainer in the 7-tap menu or by the admin from the
    // webui (delivered on the heartbeat). Both just flip [Local.openUpdatePending]; the UI turns that
    // into [UiState.openUpdateUrl], opens the browser, then calls [consumeOpenUpdate].

    /** Maintainer tapped "Update app" in the maintenance screen. */
    fun requestAppUpdate() {
        repo.log("info", "app_update_open_browser", "maintenance")
        local.update { it.copy(openUpdatePending = true) }
    }

    /** The UI has opened the update URL in the browser — clear the one-shot flag. */
    fun consumeOpenUpdate() = local.update { it.copy(openUpdatePending = false) }

    // ---- Giving flow (donor-facing) ----------------------------------------------------

    private var givingJob: Job? = null

    private fun updateGiving(f: (GivingState) -> GivingState) = local.update { it.copy(giving = f(it.giving)) }

    private var autoReturnJob: Job? = null

    /** The active campaign (the selected tab, or the main campaign). */
    private fun activeCampaign(): Campaign? {
        val cfg = ui.value.config ?: return null
        return cfg.campaignById(local.value.selectedCampaignId) ?: cfg.mainCampaign
    }

    /** Download a campaign background/logo (cached). Returns null → the UI uses the default look. */
    suspend fun image(url: String) = repo.image(url)

    /** Switch to a campaign tab: reset the flow to a fresh amount screen for that campaign and
     *  (re)arm the return-to-main countdown when it's not the main tab. */
    fun selectCampaign(id: String) {
        if (id == local.value.selectedCampaignId && local.value.giving.step == GivingStep.Amount) {
            onUserActivity(); return
        }
        givingJob?.cancel()
        PaymentController.cancelCollect()
        ReaderManager.clearPrompt()
        local.update { it.copy(selectedCampaignId = id, giving = GivingState()) }
        rescheduleAutoReturn()
    }

    /** Any donor touch on a non-main tab resets its return-to-main countdown. */
    fun onUserActivity() {
        if (local.value.giving.step == GivingStep.Amount) rescheduleAutoReturn()
    }

    /** Return the giving flow to the resting amount screen (after cancel / thank-you / error). */
    private fun resetGiving() {
        updateGiving { GivingState() }
        rescheduleAutoReturn()
    }

    /** Cancel the flow and go back to the amount screen. */
    fun cancelGiving() {
        givingJob?.cancel()
        PaymentController.cancelCollect()
        ReaderManager.clearPrompt()
        resetGiving()
    }

    /** Arm/re-arm the "return to the main campaign after inactivity" timer — only on a non-main tab
     *  while idling on the amount screen. Starting a donation or selecting the main tab cancels it. */
    private fun rescheduleAutoReturn() {
        autoReturnJob?.cancel()
        val active = activeCampaign()
        val onNonMain = active != null && !active.isMain
        val idling = local.value.giving.step == GivingStep.Amount
        if (!onNonMain || !idling) {
            if (local.value.autoReturnStartedMs != null) local.update { it.copy(autoReturnStartedMs = null) }
            return
        }
        local.update { it.copy(autoReturnStartedMs = System.currentTimeMillis()) }
        autoReturnJob = viewModelScope.launch {
            delay(KIOSK_AUTO_RETURN_MS)
            val main = ui.value.config?.mainCampaign
            // Only return if we're still idling on the same non-main tab (no donation started meanwhile).
            if (main != null && local.value.selectedCampaignId != main.id && local.value.giving.step == GivingStep.Amount) {
                selectCampaign(main.id)
            }
        }
    }

    private fun cancelAutoReturn() {
        autoReturnJob?.cancel()
        if (local.value.autoReturnStartedMs != null) local.update { it.copy(autoReturnStartedMs = null) }
    }

    fun setDonorName(v: String) = updateGiving { it.copy(donorName = v.take(120)) }
    fun setDonorEmail(v: String) = updateGiving { it.copy(donorEmail = v.take(200)) }

    /** Choose one-time vs monthly on the amount screen (only when the campaign enabled monthly). */
    fun setMonthly(monthly: Boolean) {
        onUserActivity()
        updateGiving { it.copy(monthly = monthly, error = null) }
    }

    /** Toggle covering the estimated card fee (only offered when the campaign allows it). */
    fun setCoverFees(v: Boolean) {
        onUserActivity()
        updateGiving { it.copy(coverFees = v) }
    }

    /** Pick an amount (minor units). Goes to the details step when the admin asks for name/email —
     *  or always for monthly (which requires name + email) — otherwise straight to the card. */
    fun chooseAmount(amountMinor: Long) {
        if (amountMinor <= 0) return
        val cfg = ui.value.config
        val monthly = local.value.giving.monthly
        val wantsDetails = monthly || (cfg?.namePolicy ?: "off") != "off" || (cfg?.emailPolicy ?: "off") != "off"
        cancelAutoReturn() // a donation is starting — don't yank the donor back to the main tab
        updateGiving { it.copy(amountMinor = amountMinor, error = null, step = if (wantsDetails) GivingStep.Details else GivingStep.Card) }
        if (!wantsDetails) startCollect()
    }

    /** Continue from the details step (validating required name/email; both required for monthly). */
    fun submitDetails() {
        val cfg = ui.value.config
        val g = local.value.giving
        val nameRequired = g.monthly || cfg?.namePolicy == "required"
        val emailRequired = g.monthly || cfg?.emailPolicy == "required"
        when {
            nameRequired && g.donorName.isBlank() ->
                updateGiving { it.copy(error = "Please enter your name.") }
            emailRequired && !isEmail(g.donorEmail) ->
                updateGiving { it.copy(error = "Please enter a valid email for your receipt.") }
            g.donorEmail.isNotBlank() && !isEmail(g.donorEmail) ->
                updateGiving { it.copy(error = "That email doesn’t look right.") }
            else -> {
                updateGiving { it.copy(error = null, step = GivingStep.Card) }
                startCollect()
            }
        }
    }

    /** From the error screen, try again (back to the amount screen for this campaign). */
    fun retryGiving() = resetGiving()

    private fun startCollect() {
        val g = local.value.giving
        val campaign = activeCampaign()
        if (campaign == null) {
            updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "Giving isn’t set up yet.") }
            return
        }
        val readerConnected = ui.value.reader.conn == ReaderConn.Connected
        if (g.monthly) {
            // Monthly needs the reader — the reusable card comes from a card-present charge, so it
            // can't be set up by keyed entry or on a cross-account campaign.
            if (!campaign.readerCapable || !readerConnected) {
                updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "Monthly giving needs the card reader. Please give a one-time gift, or ask a volunteer.") }
                return
            }
            startReaderCollect(campaign)
            return
        }
        // Keyed entry when the campaign can't use the reader (a different Stripe account) OR no reader
        // is connected; otherwise collect on the reader (the keyed button is a fallback on the card step).
        if (!campaign.readerCapable || !readerConnected) startManualCollect() else startReaderCollect(campaign)
    }

    /** Collect on the M2 reader (card-present), verify server-side, record, thank the donor. */
    private fun startReaderCollect(campaign: Campaign) {
        val g = local.value.giving
        updateGiving { it.copy(step = GivingStep.Card, busy = true, error = null) }
        givingJob?.cancel()
        val monthly = g.monthly
        val kind = if (monthly) "monthly" else "one_time"
        givingJob = viewModelScope.launch {
            val name = g.donorName.trim().ifBlank { null }
            val email = g.donorEmail.trim().ifBlank { null }
            val idem = UUID.randomUUID().toString()
            repo.log("info", "donation_started", "${g.amountMinor} minor · $kind · ${campaign.title}")
            val pi = runCatching { repo.createPaymentIntent(g.amountMinor, campaign.id, name, email, monthly, manual = false, coverFees = g.coverFees, idem) }.getOrNull()
            if (pi == null) {
                repo.log("warn", "donation_create_failed", "$kind")
                updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "Couldn’t start the payment. Please try again.") }
                repo.flushLogs()
                return@launch
            }
            val piId = runCatching { PaymentController.collectAndConfirm(pi.clientSecret) }.getOrNull()
            ReaderManager.clearPrompt()
            if (piId == null) {
                repo.log("warn", "donation_collect_failed", pi.id)
                updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "That didn’t go through — no charge was made. Try again?") }
                repo.flushLogs()
                return@launch
            }
            // Card read — acknowledge the tap immediately while the server verifies + captures.
            updateGiving { it.copy(step = GivingStep.Processing, busy = true) }
            val result = runCatching { repo.completePaymentIntent(piId) }.getOrNull()
            if (result?.succeeded == true) {
                val outcome = when {
                    !result.monthlyRequested -> MonthlyOutcome.None
                    result.monthlyCreated -> MonthlyOutcome.Created
                    else -> MonthlyOutcome.NotSupported
                }
                repo.log("info", "donation_succeeded", "${result.amountMinor} ${result.currency} · $kind${if (result.monthlyRequested) " · monthly=${result.monthlyCreated}" else ""}")
                updateGiving { it.copy(step = GivingStep.Thanks, busy = false, monthlyOutcome = outcome) }
                viewModelScope.launch {
                    delay(THANKS_MS)
                    if (local.value.giving.step == GivingStep.Thanks) resetGiving()
                }
            } else {
                repo.log("warn", "donation_not_succeeded", "$kind · status=${result?.status ?: "unknown"}")
                updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "That didn’t complete. If your card was charged it will be refunded.") }
            }
            repo.flushLogs()
        }
    }

    /** Enter a card by hand (Stripe's on-device form) instead of the reader. Creates a keyed card
     *  PaymentIntent, then hands its client secret to the UI (KioskRoot) to present PaymentSheet. */
    private fun startManualCollect() {
        val g = local.value.giving
        val campaign = activeCampaign()
        updateGiving { it.copy(step = GivingStep.Card, busy = true, error = null, manual = null) }
        givingJob?.cancel()
        PaymentController.cancelCollect()
        ReaderManager.clearPrompt()
        givingJob = viewModelScope.launch {
            val name = g.donorName.trim().ifBlank { null }
            val email = g.donorEmail.trim().ifBlank { null }
            val idem = UUID.randomUUID().toString()
            repo.log("info", "donation_started", "${g.amountMinor} minor · manual · ${campaign?.title ?: ""}")
            val pi = runCatching { repo.createPaymentIntent(g.amountMinor, campaign?.id, name, email, monthly = false, manual = true, coverFees = g.coverFees, idem) }.getOrNull()
            if (pi == null || pi.clientSecret.isBlank() || pi.publishableKey.isNullOrBlank()) {
                repo.log("warn", "donation_create_failed", "manual")
                updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "Couldn’t start card entry. Please try again.") }
                repo.flushLogs()
                return@launch
            }
            updateGiving { it.copy(manual = ManualEntry(pi.id, pi.clientSecret, pi.publishableKey)) }
        }
    }

    /** From the Card step (with a reader connected) the donor chose to type their card instead. The
     *  button is only shown when manual entry is enabled, so this just starts the keyed flow. */
    fun enterManually() = startManualCollect()

    /** The UI finished presenting the manual card form — verify with Stripe + record, or handle a
     *  cancel/failure. Never trusts the sheet's word: a donation is recorded only after /complete. */
    fun onManualResult(result: ManualResult, detail: String? = null) {
        val m = local.value.giving.manual ?: return
        updateGiving { it.copy(manual = null) }
        when (result) {
            ManualResult.Canceled -> resetGiving()
            ManualResult.Failed -> {
                // Log the actual Stripe/PaymentSheet reason (Devices → Logs) so failures are diagnosable.
                repo.log("warn", "donation_manual_failed", detail?.takeIf { it.isNotBlank() } ?: m.piId)
                updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "That card didn’t go through — no charge was made. Try again?") }
                viewModelScope.launch { repo.flushLogs() }
            }
            ManualResult.Completed -> {
                updateGiving { it.copy(step = GivingStep.Processing, busy = true) }
                viewModelScope.launch {
                    val res = runCatching { repo.completePaymentIntent(m.piId) }.getOrNull()
                    if (res?.succeeded == true) {
                        repo.log("info", "donation_succeeded", "${res.amountMinor} ${res.currency} · manual")
                        updateGiving { it.copy(step = GivingStep.Thanks, busy = false, monthlyOutcome = MonthlyOutcome.None) }
                        viewModelScope.launch { delay(THANKS_MS); if (local.value.giving.step == GivingStep.Thanks) resetGiving() }
                    } else {
                        repo.log("warn", "donation_not_succeeded", "manual · status=${res?.status ?: "unknown"}")
                        updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "That didn’t complete. If your card was charged it will be refunded.") }
                    }
                    repo.flushLogs()
                }
            }
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
        // 10s: the heartbeat is also how "identify", config changes, the update ping and online
        // status reach the kiosk, and the server marks a kiosk offline after ~3 missed beats (~35s),
        // so a fallen kiosk shows offline quickly. Still trivial LAN traffic.
        const val HEARTBEAT_INTERVAL_MS = 10_000L
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
