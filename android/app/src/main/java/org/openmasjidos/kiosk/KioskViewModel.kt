// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
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
import kotlinx.coroutines.withContext
import org.openmasjidos.kiosk.local.Campaign
import org.openmasjidos.kiosk.local.Diagnostics
import org.openmasjidos.kiosk.local.KioskConfig
import org.openmasjidos.kiosk.local.PairingRecord
import org.openmasjidos.kiosk.kiosk.DeviceStatus
import org.openmasjidos.kiosk.net.HeartbeatOutcome
import org.openmasjidos.kiosk.net.PairResult
import org.openmasjidos.kiosk.net.TuitionPay
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
enum class GivingStep { Idle, Amount, LargeAmount, Details, Card, Processing, Thanks, Error, TuitionConfirm, TuitionInvoices }

/** How long a non-main campaign tab may sit idle before the kiosk returns to the main tab. */
const val KIOSK_AUTO_RETURN_MS = 45_000L

/** Whether a requested monthly subscription was set up (drives the thank-you wording). */
enum class MonthlyOutcome { None, Created, NotSupported }

/** A one-shot request for the UI to present Stripe's on-device card form (keyed/manual entry).
 *  When [GivingState.manual] is non-null, KioskRoot presents PaymentSheet and reports the result. */
data class ManualEntry(
    val piId: String,
    val clientSecret: String,
    val publishableKey: String,
    val chargeMinor: Long = 0L,
    val currency: String = "",
)

/** Outcome the UI reports back after presenting the manual card form. */
enum class ManualResult { Completed, Canceled, Failed }

/** One LINE of a bill (contract 0.43.0): "Monthly tuition £200", "Book fee £50", "Bursary −£30".
 *  [payable] is the only thing the tick logic cares about — a settled line and a credit line are both
 *  shown (a part-paid bill should say what is already dealt with) but neither can be chosen. */
data class TuitionItemUi(
    val id: String,
    val label: String,
    val kind: String,
    val amountMinor: Long,
    val balanceMinor: Long,
) {
    val payable: Boolean get() = balanceMinor > 0
    val isCredit: Boolean get() = kind == "credit" || amountMinor < 0
}

/** An open invoice a parent can pay (display + the opaque id used for selection). [studentName] is
 *  whose bill it is — blank for an only child (contract v2: one bill per student). [items] is what the
 *  bill is made of; empty against a Students older than 0.43.0, and then the bill is one tickable row
 *  exactly as before. */
data class TuitionInvoiceUi(
    val id: String,
    val label: String,
    val dueDate: String,
    val balanceMinor: Long,
    val studentName: String = "",
    val items: List<TuitionItemUi> = emptyList(),
) {
    /** The lines a parent can actually choose. */
    val payableItems: List<TuitionItemUi> get() = items.filter { it.payable }

    /** What ticking THIS bill selects: its lines when it has them, else the bill itself. One or the
     *  other — a charge that mixes the two can't be expressed on the wire (the provider takes `lines`
     *  or `allocations`, and a partial `lines[]` is a hard rejection). */
    val unitIds: List<String> get() = if (items.isEmpty()) listOf(id) else payableItems.map { it.id }
}

/** One CHILD's part of the account: their name, their own balance and credit, and their own bills.
 *  [key] is the opaque per-session handle for "pay towards this child" — the school's internal id
 *  never reaches the tablet. Blank on the (defensive) unattributed section, which therefore offers no
 *  per-child button. */
data class TuitionStudentUi(
    val key: String,
    val name: String,
    val balanceMinor: Long,
    val creditMinor: Long,
    val invoices: List<TuitionInvoiceUi> = emptyList(),
)

/** State of the tuition (students/billing) shell — the Student ID entry, the "is this your child?"
 *  confirmation, then the family's balance + invoices to pay. Only set when the active campaign is a
 *  `tuition` campaign. Holds nothing beyond what's on screen and is cleared whenever the flow resets,
 *  so no family's balance lingers for the next person (contract §6).
 *
 *  Contract v2 (Students 0.39.0 §11.0): there is no PIN. The Student ID alone identifies the child and
 *  the parent confirms the name we echo back — that confirmation is what catches a mistyped ID. */
data class TuitionState(
    val schoolName: String = "",
    val tagline: String = "",
    val available: Boolean = true,      // Students info.enabled; false → the tile shows "unavailable"
    val studentCode: String = "",       // the ID printed on the statement, e.g. YUS1234
    val identifiedName: String = "",    // the child `identify` matched — shown for confirmation
    val looking: Boolean = false,       // an identify/lookup is in flight
    val notFound: Boolean = false,      // uniform "couldn't find that"
    val error: String? = null,          // e.g. temporarily unavailable / choose an item
    val session: String = "",           // opaque server session id (set after a successful lookup)
    val familyLabel: String = "",
    val balanceMinor: Long = 0L,
    /** Money already paid ahead (0.41.0). At most one of balance/credit is non-zero; without this a
     *  zero balance can't be told apart from "you're paid up ahead". */
    val creditMinor: Long = 0L,
    val currency: String = "",
    /** The account CHILD BY CHILD. One flat list of bills was unreadable the moment a family had two
     *  children with the same month's label, and it could not say who was in credit. */
    val students: List<TuitionStudentUi> = emptyList(),
    val payFull: Boolean = true,
    /** Ticked units when !payFull — bill LINE ids where the provider gave us lines, else invoice ids
     *  (see [TuitionInvoiceUi.unitIds]). */
    val selected: Set<String> = emptySet(),
    /** The school takes money when nothing is due (pay a term up front). Drives the amount pad. */
    val allowAdvance: Boolean = false,
    /** Floor for a typed amount — the school's, never below the kiosk's own £1/$1 minimum. */
    val minAmountMinor: Long = 100L,
) {
    /** Every open bill across the family, for the totals and the pay-selection maths. */
    val invoices: List<TuitionInvoiceUi> get() = students.flatMap { it.invoices }

    /** What is actually PAYABLE — the open bills added up.
     *
     *  NOT [balanceMinor]. The household figure is a NET: one child's credit cancels another's bill
     *  in it, so a family with Yusuf £340 ahead and Yunus £160 behind reports a £0 balance and £180
     *  of credit while £160 is genuinely owed. Gating the pay controls on the balance left the
     *  parent staring at three of Yunus's bills with no way to pay any of them. Credit belongs to
     *  the child holding it and never pays a sibling's bill, so the bills are the honest total. */
    val dueMinor: Long get() = invoices.sumOf { it.balanceMinor }.takeIf { it > 0 } ?: balanceMinor

    /** True when EVERY open bill came with lines. The two selections can't be mixed in one charge (the
     *  provider takes `lines` or `allocations`, and a `lines[]` covering only part of the charge is a
     *  hard rejection), so this decides which one the WHOLE screen uses — rendering included. */
    val itemised: Boolean get() = invoices.isNotEmpty() && invoices.all { it.items.isNotEmpty() }

    /** What ticking this bill selects, honouring that whole-screen choice: its lines only when every
     *  bill has them, else the bill itself. */
    fun unitsOf(inv: TuitionInvoiceUi): List<String> = if (itemised) inv.unitIds else listOf(inv.id)

    /** What a ticked unit id is worth, whichever kind of unit it is. */
    fun unitAmount(id: String): Long =
        invoices.firstOrNull { it.id == id }?.balanceMinor
            ?: invoices.firstNotNullOfOrNull { inv -> inv.items.firstOrNull { it.id == id } }?.balanceMinor
            ?: 0L
}

/** State of an in-progress donation. Amounts are integer MINOR units (validated server-side).
 *  The resting state is [GivingStep.Amount] — the kiosk idles on the giving screen (no attract).
 *  A `tuition` campaign rests on [GivingStep.Amount] too, but the UI renders the tuition lookup shell
 *  there (see GivingScreen) and drives it through [tuition]. */
data class GivingState(
    val step: GivingStep = GivingStep.Amount,
    val amountMinor: Long = 0L,
    val monthly: Boolean = false,
    /** Donor opted to cover the estimated card fee (only offered when the campaign allows it). */
    val coverFees: Boolean = false,
    /** The authoritative amount the SERVER will charge (base + any cover-fee, incl. a forced Zakat
     *  fee), returned when the PaymentIntent is created. 0 until then. The card/processing/thank-you
     *  screens display this — never a locally-estimated total — so the tablet can never show one
     *  amount while Stripe charges another (e.g. a kiosk whose Zakat config hasn't synced yet). */
    val serverChargeMinor: Long = 0L,
    val donorName: String = "",
    val donorEmail: String = "",
    val busy: Boolean = false,
    val error: String? = null,
    val monthlyOutcome: MonthlyOutcome = MonthlyOutcome.None,
    /** Non-null → the UI should present Stripe's card form for keyed/manual entry, then report back. */
    val manual: ManualEntry? = null,
    /** True while we're creating the keyed-entry PaymentIntent (before [manual] is ready). Lets the
     *  card screen show a calm "opening card entry" state instead of the reader's tap prompt, so
     *  switching to keyed entry is seamless. */
    val preparingManual: Boolean = false,
    /** Tuition (students/billing) shell state — non-null only for a `tuition` campaign. */
    val tuition: TuitionState? = null,
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
    /** When non-null, a donation is under way (details/card) and will return to the menu on inactivity;
     *  drives the same countdown ring. */
    val idleReturnStartedMs: Long? = null,
    /** When non-null, the UI should open this URL (the server's APK download) in the browser so a
     *  person can install the update, then call [KioskViewModel.consumeOpenUpdate]. Only used as a
     *  FALLBACK when the in-app download ([installApkPath]) failed. */
    val openUpdateUrl: String? = null,
    /** A downloaded APK is ready to install IN-APP (no browser): the UI hands this path to the system
     *  installer, then calls [KioskViewModel.consumeInstallApk]. */
    val installApkPath: String? = null,
    /** True while the update APK is downloading, so the maintenance button can show progress. */
    val updating: Boolean = false,
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
        /** When a donation is under way, when its return-to-menu countdown started (null = off). */
        val idleReturnStartedMs: Long? = null,
        val latestAppVersion: String = "",
        // Set when the admin (webui) or a maintainer (10-tap menu) asks this kiosk to update; the UI
        // opens the APK link in the browser to install (FALLBACK when the in-app download failed).
        val openUpdatePending: Boolean = false,
        // In-app update: path of a downloaded APK ready to hand to the system installer, and whether a
        // download is currently in flight (so the maintenance button shows "Downloading…").
        val installApkPath: String? = null,
        val updating: Boolean = false,
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
            idleReturnStartedMs = l.idleReturnStartedMs,
            openUpdateUrl = if (l.openUpdatePending && pairing != null)
                pairing.serverUrl.trimEnd('/') + "/download/openmasjidkiosk.apk" else null,
            installApkPath = l.installApkPath,
            updating = l.updating,
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
        // (Keyed card entry now uses Stripe.js in an in-app WebView — no PaymentConfiguration/PaymentSheet
        //  init needed; the publishable key is passed to the WebView per keyed PaymentIntent.)
        // Arm/cancel the idle-abandon timer at every step transition (so a donor who fills in details
        // then walks away doesn't leave their name/email on screen — see rescheduleIdleReset).
        viewModelScope.launch {
            local.map { it.giving.step }.distinctUntilChanged().collect {
                rescheduleIdleReset()
                // …and re-evaluate the return-to-main timer, which self-cancels off the amount screen.
                // Without this it was only ever re-evaluated BY onUserActivity while already on that
                // screen, so stepping into a donation left `autoReturnStartedMs` set at its old value.
                // The countdown ring prefers that marker over the idle one, so every later step drew a
                // ring frozen at whatever was left of a timer that had already stopped mattering — the
                // one piece of feedback telling a parent the kiosk is about to reset, showing a lie.
                rescheduleAutoReturn()
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
    // the first time. Triggered either by a maintainer in the 10-tap menu or by the admin from the
    // webui (delivered on the heartbeat). Both just flip [Local.openUpdatePending]; the UI turns that
    // into [UiState.openUpdateUrl], opens the browser, then calls [consumeOpenUpdate].

    /** Maintainer tapped "Update app". Prefer an IN-APP update: download the APK via the pinned client
     *  and hand it to the system installer (no browser, so the kiosk lockdown isn't broken by leaving
     *  to Chrome). Falls back to opening the APK link in the browser only if the download fails.
     *  Guarded so a double-tap can't start two downloads. */
    fun requestAppUpdate() {
        if (local.value.updating) return
        repo.log("info", "app_update_requested", "maintenance")
        local.update { it.copy(updating = true) }
        viewModelScope.launch {
            val file = repo.downloadUpdateApk()
            if (file != null) {
                local.update { it.copy(updating = false, installApkPath = file.absolutePath) }
            } else {
                repo.log("warn", "app_update_download_failed", "falling back to browser install")
                local.update { it.copy(updating = false, openUpdatePending = true) }
            }
        }
    }

    /** The UI has handed the downloaded APK to the system installer — clear the one-shot path. */
    fun consumeInstallApk() = local.update { it.copy(installApkPath = null) }

    /** The UI has opened the update URL in the browser (fallback) — clear the one-shot flag. */
    fun consumeOpenUpdate() = local.update { it.copy(openUpdatePending = false) }

    // ---- Giving flow (donor-facing) ----------------------------------------------------

    private var givingJob: Job? = null

    private fun updateGiving(f: (GivingState) -> GivingState) = local.update { it.copy(giving = f(it.giving)) }

    private var autoReturnJob: Job? = null
    private var idleResetJob: Job? = null
    /** The touch-proof ceiling on the tuition balance screen — see [armTuitionHardReset]. */
    private var tuitionHardResetJob: Job? = null

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

    /** Any donor touch resets the return-to-main countdown (on a non-main tab) and the idle-abandon
     *  timer (mid-donation), so an actively-used kiosk is never yanked away. */
    fun onUserActivity() {
        if (local.value.giving.step == GivingStep.Amount) rescheduleAutoReturn()
        rescheduleIdleReset()
    }

    /** Reset an ABANDONED donation (Details/Card/Error left untouched) back to a fresh giving screen,
     *  so the next passer-by never sees a previous donor's name/email and the main appeal is restored.
     *  Armed on entering those steps (via the step observer in [start]) and extended by any touch.
     *  Excludes Processing (a payment is in flight — must finish) and Thanks (self-resets after 8s). */
    private fun rescheduleIdleReset() {
        idleResetJob?.cancel()
        val g = local.value.giving
        val step = g.step
        val armStep = step == GivingStep.LargeAmount || step == GivingStep.Details || step == GivingStep.Card || step == GivingStep.Error ||
            step == GivingStep.TuitionConfirm || step == GivingStep.TuitionInvoices
        // A tuition campaign rests on GivingStep.Amount, but the lookup shell there holds a typed
        // Student ID — which identifies a child and is enough to see their balance. That is not
        // something a walked-away parent should leave for the next person, and on the MAIN/single tab
        // the return-to-main timer never fires, so once anything is typed we arm the idle timer here
        // and clear the field on timeout.
        val tuitionDirty = step == GivingStep.Amount && activeCampaign()?.type == "tuition" &&
            g.tuition?.studentCode?.isNotBlank() == true
        if (!armStep && !tuitionDirty) {
            if (local.value.idleReturnStartedMs != null) local.update { it.copy(idleReturnStartedMs = null) }
            return
        }
        // Show the same return-to-menu countdown ring the tabs use. While the keyed-card WebView is up
        // (manual != null) the donor's taps go to the WebView, not us, so give a much longer window so
        // a slow typer isn't cut off mid-card (an abandoned form still resets eventually).
        val timeout = if (g.manual != null) MANUAL_IDLE_MS else IDLE_ABANDON_MS
        local.update { it.copy(idleReturnStartedMs = System.currentTimeMillis()) }
        idleResetJob = viewModelScope.launch {
            delay(timeout)
            val cur = local.value.giving
            val s = cur.step
            if (s == GivingStep.LargeAmount || s == GivingStep.Details || s == GivingStep.Card || s == GivingStep.Error ||
                s == GivingStep.TuitionConfirm || s == GivingStep.TuitionInvoices
            ) {
                cancelGiving()
            } else if (s == GivingStep.Amount && activeCampaign()?.type == "tuition" &&
                cur.tuition?.studentCode?.isNotBlank() == true) {
                // Wipe the abandoned Student ID (and any looked-up family) back to a fresh lookup shell,
                // keeping the tile itself on screen — no restart, no lingering balance for a passer-by.
                updateTuition { TuitionState(schoolName = it.schoolName, tagline = it.tagline, available = it.available) }
                if (local.value.idleReturnStartedMs != null) local.update { it.copy(idleReturnStartedMs = null) }
            }
        }
    }

    /** Return the giving flow to the resting amount screen (after cancel / thank-you / error).
     *
     *  A tuition tile keeps its SHELL — the school's name, tagline and availability — because that is
     *  the tile's heading, fetched once when the campaign mounts and never re-fetched (the mount is
     *  keyed on the campaign id, which doesn't change). Wiping it left the Fees tab headed with the
     *  bare campaign title after every timeout. Everything about the FAMILY goes. */
    private fun resetGiving() {
        tuitionHardResetJob?.cancel()
        val shell = local.value.giving.tuition
        updateGiving {
            GivingState(
                tuition = shell?.let { TuitionState(schoolName = it.schoolName, tagline = it.tagline, available = it.available) },
            )
        }
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

    /** Toggle covering the estimated card fee (only offered when the campaign allows it). A Zakat
     *  campaign forces fee-covering on, so the toggle is ignored there. */
    fun setCoverFees(v: Boolean) {
        onUserActivity()
        if (activeCampaign()?.forceCoverFees == true) return // Zakat: the fee is always covered
        updateGiving { it.copy(coverFees = v) }
    }

    /** Pick an amount (minor units). For a large gift (≥ the admin's threshold) we first suggest a
     *  cheaper way to give (bank transfer / Zelle); otherwise proceed to details/card. */
    fun chooseAmount(amountMinor: Long) {
        if (amountMinor <= 0) return
        cancelAutoReturn() // a donation is starting — don't yank the donor back to the main tab
        val cfg = ui.value.config
        val threshold = cfg?.largeAmountThresholdMinor ?: 0L
        val hasAlternative = !cfg?.largeAmountNote.isNullOrBlank() || !cfg?.largeAmountImage.isNullOrBlank()
        if (threshold > 0 && amountMinor >= threshold && hasAlternative) {
            // Interpose the large-donation screen — the donor can read the alternative, then either
            // give by card anyway or cancel. The idle-abandon timer + ring cover this step too.
            updateGiving { it.copy(amountMinor = amountMinor, error = null, step = GivingStep.LargeAmount) }
            return
        }
        proceedAfterAmount(amountMinor)
    }

    /** From the large-donation suggestion, the donor chose to give by card anyway. */
    fun proceedDespiteLargeAmount() {
        val amt = local.value.giving.amountMinor
        if (amt <= 0) { resetGiving(); return }
        proceedAfterAmount(amt)
    }

    /** Decide the next step for a chosen amount: the details step for name/email prompts, monthly, OR
     *  when the campaign covers fees (its toggle/Zakat note lives there); otherwise straight to card.
     *  A Zakat (forceCoverFees) campaign always covers the fee, so we set that on the giving state. */
    private fun proceedAfterAmount(amountMinor: Long) {
        val cfg = ui.value.config
        val campaign = activeCampaign()
        val monthly = local.value.giving.monthly
        val forced = campaign?.forceCoverFees == true
        val wantsDetails = monthly ||
            (cfg?.namePolicy ?: "off") != "off" ||
            (cfg?.emailPolicy ?: "off") != "off" ||
            campaign?.coverFees == true
        updateGiving {
            it.copy(
                amountMinor = amountMinor,
                coverFees = if (forced) true else it.coverFees,
                error = null,
                step = if (wantsDetails) GivingStep.Details else GivingStep.Card,
            )
        }
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
            // NB: rethrow CancellationException on every suspend call below. This job is cancelled
            // when the donor switches to keyed entry (enterManually → startManualCollect); if we
            // swallowed the cancellation we'd fall through and briefly flash the "Sorry" error screen
            // before the card form opened. Rethrowing ends the superseded job silently.
            // Keep the REASON. It used to be discarded here and the log line said only "monthly", so
            // four separate reports of "Sorry, we couldn't start the payment" had nothing to diagnose
            // from: a server error, a timeout and a Stripe refusal all looked identical from the tablet.
            var createWhy = ""
            val pi = try {
                repo.createPaymentIntent(g.amountMinor, campaign.id, name, email, monthly, manual = false, coverFees = g.coverFees, idem)
            } catch (c: CancellationException) {
                throw c
            } catch (e: Exception) {
                createWhy = (e.javaClass.simpleName + ": " + e.message.orEmpty()).take(240)
                null
            }
            if (pi == null) {
                repo.log("warn", "donation_create_failed", "$kind · $createWhy")
                updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "Couldn’t start the payment. Please try again.") }
                repo.flushLogs()
                return@launch
            }
            // Show the server's authoritative charge from here on (matches what Stripe will take,
            // even if this kiosk's cover-fee/Zakat config hasn't synced yet).
            updateGiving { it.copy(serverChargeMinor = pi.chargeMinor) }
            var collectWhy = ""
            val piId = try {
                PaymentController.collectAndConfirm(pi.clientSecret)
            } catch (c: CancellationException) {
                ReaderManager.clearPrompt()
                throw c
            } catch (e: Exception) {
                collectWhy = (e.javaClass.simpleName + ": " + e.message.orEmpty()).take(240)
                null
            }
            ReaderManager.clearPrompt()
            if (piId == null) {
                // The "tap your card" prompt appearing for a split second and then vanishing lands
                // HERE, so this line is the one that explains it.
                repo.log("warn", "donation_collect_failed", pi.id + " · " + collectWhy)
                updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "That didn’t go through — no charge was made. Try again?") }
                repo.flushLogs()
                return@launch
            }
            // Card read — the payment is now authorized on the reader. Complete it in a NonCancellable
            // block so a late cancel / tab-switch can't orphan the authorized charge: the server always
            // captures + records it, and the donor sees the thank-you they earned.
            withContext(NonCancellable) {
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
    }

    /** Enter a card by hand (Stripe's on-device form) instead of the reader. Creates a keyed card
     *  PaymentIntent, then hands its client secret to the UI (KioskRoot) to present PaymentSheet. */
    private fun startManualCollect() {
        val g = local.value.giving
        val campaign = activeCampaign()
        // preparingManual → the card screen shows a calm "opening card entry" state (not the reader's
        // tap prompt) so switching from the reader to keyed entry is seamless.
        updateGiving { it.copy(step = GivingStep.Card, busy = true, error = null, manual = null, preparingManual = true) }
        givingJob?.cancel()
        PaymentController.cancelCollect()
        ReaderManager.clearPrompt()
        givingJob = viewModelScope.launch {
            val name = g.donorName.trim().ifBlank { null }
            val email = g.donorEmail.trim().ifBlank { null }
            val idem = UUID.randomUUID().toString()
            repo.log("info", "donation_started", "${g.amountMinor} minor · manual · ${campaign?.title ?: ""}")
            var manualWhy = ""
            val pi = try {
                repo.createPaymentIntent(g.amountMinor, campaign?.id, name, email, monthly = false, manual = true, coverFees = g.coverFees, idem)
            } catch (c: CancellationException) {
                throw c // superseded/cancelled — don't flash an error
            } catch (e: Exception) {
                manualWhy = (e.javaClass.simpleName + ": " + e.message.orEmpty()).take(240)
                null
            }
            // The publishable key comes back with the manual PI; fall back to the one in config (the
            // server always injects it now) so a blank field on the PI can't strand keyed entry.
            val pk = pi?.publishableKey?.takeIf { it.isNotBlank() } ?: ui.value.config?.publishableKey?.takeIf { it.isNotBlank() }
            if (pi == null || pi.clientSecret.isBlank() || pk.isNullOrBlank()) {
                repo.log(
                    "warn",
                    "donation_create_failed",
                    "manual · " + manualWhy.ifBlank { if (pi == null) "no intent" else "missing client secret or publishable key" },
                )
                updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "Couldn’t start card entry. Please try again.", preparingManual = false) }
                repo.flushLogs()
                return@launch
            }
            updateGiving { it.copy(serverChargeMinor = pi.chargeMinor, preparingManual = false, manual = ManualEntry(pi.id, pi.clientSecret, pk, pi.chargeMinor, ui.value.config?.currency.orEmpty())) }
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

    // ── Tuition (students/billing) — a `tuition` campaign shells out to OpenMasjid Students ──────
    private fun updateTuition(f: (TuitionState) -> TuitionState) =
        updateGiving { it.copy(tuition = f(it.tuition ?: TuitionState())) }

    /** Enter/refresh the tuition shell for the active campaign: ensure state exists + fetch the school
     *  label + whether tuition is available. Called by the lookup screen on mount (per campaign). */
    fun onTuitionStart() {
        val c = activeCampaign() ?: return
        if (c.type != "tuition") return
        if (local.value.giving.tuition == null) updateGiving { it.copy(tuition = TuitionState()) }
        viewModelScope.launch {
            // Fetch the school label + availability. onTuitionStart only re-runs when campaign.id
            // changes — which never happens on a single-campaign tuition kiosk — so a transient blip
            // must NOT hard-disable the tile with no recovery. Retry a few times, and on total failure
            // keep the prior/default availability (fail-soft: the lookup shell stays and a real outage
            // is surfaced kindly at lookup time) rather than latching available = false.
            var info = runCatching { repo.tuitionInfo() }.getOrNull()
            var tries = 0
            while (info == null && tries < 2) {
                delay(2_000L)
                info = runCatching { repo.tuitionInfo() }.getOrNull()
                tries++
            }
            updateTuition {
                it.copy(
                    schoolName = info?.schoolName ?: it.schoolName,
                    tagline = info?.tagline ?: it.tagline,
                    available = info?.enabled ?: it.available,
                    // The advance/floor policy also arrives with the lookup; keeping it here too means
                    // the pay screen is right even on the first paint after a config change.
                    allowAdvance = info?.allowAdvance ?: it.allowAdvance,
                    minAmountMinor = info?.minAmountMinor ?: it.minAmountMinor,
                )
            }
        }
    }

    // Typing re-arms the idle-abandon timer (and the return-to-main timer on a non-main tab) so an
    // abandoned Student ID is always cleared — see rescheduleIdleReset's tuition branch. The ID is
    // normalised the way the school does it (uppercase, no spaces/hyphens) so "yus-1234" just works.
    fun setTuitionStudentCode(v: String) {
        updateTuition { it.copy(studentCode = v.uppercase().filter { ch -> ch != ' ' && ch != '-' }.take(32), notFound = false, error = null) }
        onUserActivity()
    }

    /** Step 1 (contract v2 §11.0): resolve the typed Student ID to a child's name and ask the parent to
     *  confirm it. No balance is fetched yet — that confirmation is what replaced the PIN, so a
     *  mistyped ID is caught here rather than paying a stranger's bill. A mistyped/unknown/locked ID is
     *  a uniform "not found"; a broker outage is "temporarily unavailable" (never "wrong ID"). */
    fun tuitionIdentify() {
        onUserActivity()
        val c = activeCampaign() ?: return
        val t = local.value.giving.tuition ?: return
        if (t.studentCode.isBlank()) {
            updateTuition { it.copy(error = "Enter the Student ID.") }
            return
        }
        updateTuition { it.copy(looking = true, notFound = false, error = null) }
        givingJob?.cancel()
        givingJob = viewModelScope.launch {
            val res = runCatching { repo.tuitionIdentify(c.id, t.studentCode.trim()) }.getOrNull()
            when {
                res == null -> updateTuition { it.copy(looking = false, error = "Tuition is temporarily unavailable — please try again.") }
                !res.found -> updateTuition { it.copy(looking = false, notFound = true) }
                else -> {
                    updateGiving {
                        it.copy(
                            step = GivingStep.TuitionConfirm,
                            error = null,
                            tuition = (it.tuition ?: TuitionState()).copy(looking = false, notFound = false, error = null, identifiedName = res.name),
                        )
                    }
                    rescheduleIdleReset()
                }
            }
        }
    }

    /** "No, that's not my child" — back to the ID entry with the mistyped code cleared. */
    fun tuitionRejectStudent() {
        onUserActivity()
        givingJob?.cancel()
        updateGiving {
            it.copy(
                step = GivingStep.Amount,
                error = null,
                tuition = (it.tuition ?: TuitionState()).copy(studentCode = "", identifiedName = "", looking = false, notFound = false, error = null),
            )
        }
        rescheduleIdleReset()
    }

    /** Step 2: the parent confirmed the name → fetch the balance for that SAME Student ID and move to
     *  the invoices step. */
    fun tuitionConfirmStudent() {
        onUserActivity()
        val c = activeCampaign() ?: return
        val t = local.value.giving.tuition ?: return
        if (t.studentCode.isBlank()) return
        updateTuition { it.copy(looking = true, notFound = false, error = null) }
        givingJob?.cancel()
        givingJob = viewModelScope.launch {
            val res = runCatching { repo.tuitionLookup(c.id, t.studentCode.trim()) }.getOrNull()
            when {
                res == null -> updateTuition { it.copy(looking = false, error = "Tuition is temporarily unavailable — please try again.") }
                // Vanishingly rare (identify just matched it) — send them back to the ID screen rather
                // than stranding them on a confirmation for a child we can no longer price.
                !res.found -> updateGiving {
                    it.copy(
                        step = GivingStep.Amount,
                        tuition = (it.tuition ?: TuitionState()).copy(looking = false, notFound = true, identifiedName = ""),
                    )
                }
                else -> {
                    val fam = res.family!!
                    updateGiving {
                        it.copy(
                            step = GivingStep.TuitionInvoices,
                            error = null,
                            tuition = (it.tuition ?: TuitionState()).copy(
                                looking = false,
                                notFound = false,
                                error = null,
                                session = fam.session,
                                familyLabel = fam.label,
                                balanceMinor = fam.balanceMinor,
                                creditMinor = fam.creditMinor,
                                allowAdvance = fam.allowAdvance,
                                minAmountMinor = fam.minAmountMinor,
                                currency = fam.currency,
                                students = fam.students.map { s ->
                                    TuitionStudentUi(
                                        key = s.key,
                                        name = s.name,
                                        balanceMinor = s.balanceMinor,
                                        creditMinor = s.creditMinor,
                                        invoices = s.invoices.map { i ->
                                            TuitionInvoiceUi(
                                                i.id,
                                                i.label,
                                                i.dueDate,
                                                i.balanceMinor,
                                                i.studentName,
                                                i.items.map { line -> TuitionItemUi(line.id, line.label, line.kind, line.amountMinor, line.balanceMinor) },
                                            )
                                        },
                                    )
                                },
                                payFull = true,
                                selected = emptySet(),
                            ),
                        )
                    }
                    rescheduleIdleReset()
                    armTuitionHardReset()
                }
            }
        }
    }

    /** A HARD ceiling on how long a named family's balance may sit on the wall.
     *
     *  The 45-second idle timer is extended by every touch, which is right for a donation in progress
     *  — nobody should be yanked away mid-flow. It is wrong for a balance screen: a parent who is
     *  stuck, or reading, or just resting a hand on the tablet keeps their children's names, bills and
     *  arrears on a foyer screen indefinitely, and that is the one thing this screen must not do.
     *  So this deadline is NOT reset by activity. It never interrupts a payment: by the time the card
     *  is being collected the step has moved past the balance screen and the check below no-ops. */
    private fun armTuitionHardReset() {
        tuitionHardResetJob?.cancel()
        tuitionHardResetJob = viewModelScope.launch {
            delay(TUITION_MAX_ON_SCREEN_MS)
            val s = local.value.giving.step
            if (s == GivingStep.TuitionConfirm || s == GivingStep.TuitionInvoices) cancelGiving()
        }
    }

    fun setTuitionPayFull(full: Boolean) {
        onUserActivity()
        updateTuition { it.copy(payFull = full, error = null) }
    }

    /** Tick or untick one unit of the bill — a LINE where the school itemises its bills, else the whole
     *  bill (contract 0.43.0 §11.0b). */
    fun toggleTuitionUnit(id: String) {
        onUserActivity()
        updateTuition { st -> st.copy(payFull = false, error = null, selected = if (st.selected.contains(id)) st.selected - id else st.selected + id) }
    }

    /** Tick or untick a whole bill at once — every payable line of it, so a parent who wants the lot
     *  doesn't have to tap each line. */
    fun toggleTuitionInvoice(id: String) {
        onUserActivity()
        updateTuition { st ->
            val inv = st.invoices.firstOrNull { it.id == id } ?: return@updateTuition st
            val units = st.unitsOf(inv)
            val allOn = units.isNotEmpty() && units.all { st.selected.contains(it) }
            st.copy(payFull = false, error = null, selected = if (allOn) st.selected - units.toSet() else st.selected + units.toSet())
        }
    }

    /** Pay tuition on the reader: the whole balance, the ticked bills/lines, or — when [amountMinor] is
     *  given — a typed amount, which may be a part payment or money paid AHEAD of any bill (0.41.0),
     *  for one named child. Mirrors the donation reader flow, but the amount is recomputed server-side
     *  from the held session, and it records a "payment" into the Students ledger — never a donation. */
    fun payTuition() = payTuitionInternal(null, "")

    /** Pay a TYPED amount — a part payment, or money paid ahead when nothing is due. [studentKey] names
     *  the child whose ledger it belongs to (blank = the household, walked oldest-due-first). */
    fun payTuitionAmount(amountMinor: Long, studentKey: String = "") = payTuitionInternal(amountMinor, studentKey)

    private fun payTuitionInternal(amountMinor: Long?, studentKey: String) {
        val t = local.value.giving.tuition ?: return
        val readerConnected = ui.value.reader.conn == ReaderConn.Connected
        if (!readerConnected) {
            updateGiving { it.copy(step = GivingStep.Error, error = "The card reader isn’t connected. Please ask a volunteer.") }
            return
        }
        val payFull = t.payFull
        // Only ids that are still real: a selection made before a refresh must never survive into a
        // charge as a made-up id (the server would refuse it anyway, after the parent had committed).
        val ids = t.selected.filter { t.unitAmount(it) > 0 }
        if (amountMinor == null && !payFull && ids.isEmpty()) {
            updateTuition { it.copy(error = "Choose at least one item to pay, or pay the full balance.") }
            return
        }
        // Belt to the server's braces: it re-checks the floor against its own copy of the school's
        // settings. The pad shows the actual minimum, so this line only has to stop the charge.
        if (amountMinor != null && amountMinor < t.minAmountMinor) {
            updateTuition { it.copy(error = "That's below the smallest payment this school accepts.") }
            return
        }
        val pay = when {
            amountMinor != null -> TuitionPay.Amount(amountMinor, studentKey)
            payFull -> TuitionPay.Full
            // Lines where the school itemises its bills, whole bills where it doesn't. Never both in
            // one charge — the provider takes one breakdown or the other.
            t.itemised -> TuitionPay.Items(ids)
            else -> TuitionPay.Invoices(ids)
        }
        // Show the amount immediately on the Card/Processing/Thanks screens (no "$0" flash before the
        // PI round-trip). This is a DISPLAY estimate from the looked-up balances; the server recomputes
        // the authoritative charge from the held session and serverChargeMinor overrides it below.
        val displayMinor = when {
            amountMinor != null -> amountMinor
            // The open bills, not the netted household balance — see TuitionState.dueMinor.
            payFull -> t.dueMinor
            else -> ids.sumOf { t.unitAmount(it) }
        }
        updateGiving { it.copy(step = GivingStep.Card, busy = true, error = null, amountMinor = displayMinor) }
        givingJob?.cancel()
        givingJob = viewModelScope.launch {
            val idem = UUID.randomUUID().toString()
            repo.log("info", "tuition_started", if (amountMinor != null) "typedAmount" else "payFull=$payFull items=${ids.size}")
            val pi = try {
                repo.createTuitionPaymentIntent(t.session, pay, idem)
            } catch (c: CancellationException) {
                throw c
            } catch (e: Exception) {
                null
            }
            if (pi == null) {
                repo.log("warn", "tuition_create_failed", "")
                updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "Couldn’t start the payment. Please try again.") }
                repo.flushLogs()
                return@launch
            }
            updateGiving { it.copy(serverChargeMinor = pi.chargeMinor) }
            val piId = try {
                PaymentController.collectAndConfirm(pi.clientSecret)
            } catch (c: CancellationException) {
                ReaderManager.clearPrompt()
                throw c
            } catch (e: Exception) {
                null
            }
            ReaderManager.clearPrompt()
            if (piId == null) {
                repo.log("warn", "tuition_collect_failed", pi.id)
                updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "That didn’t go through — no charge was made. Try again?") }
                repo.flushLogs()
                return@launch
            }
            withContext(NonCancellable) {
                updateGiving { it.copy(step = GivingStep.Processing, busy = true) }
                val result = runCatching { repo.completeTuitionPaymentIntent(piId) }.getOrNull()
                if (result?.succeeded == true) {
                    repo.log("info", "tuition_succeeded", "${result.amountMinor} ${result.currency}")
                    updateGiving { it.copy(step = GivingStep.Thanks, busy = false, monthlyOutcome = MonthlyOutcome.None) }
                    viewModelScope.launch {
                        delay(THANKS_MS)
                        if (local.value.giving.step == GivingStep.Thanks) resetGiving()
                    }
                } else {
                    repo.log("warn", "tuition_not_succeeded", "status=${result?.status ?: "unknown"}")
                    updateGiving { it.copy(step = GivingStep.Error, busy = false, error = "That didn’t complete. If your card was charged it will be refunded.") }
                }
                repo.flushLogs()
            }
        }
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

    /** Records a rapid tap on the attract screen; 10 within 3s reveals the unlock/settings path. */
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
    /** Exponential backoff after a wrong PIN, capped.
     *
     *  `steps` is clamped BEFORE the shift, which matters: `attempts` grows without bound, and
     *  `Long shl` compiles to the JVM's `lshl` — that masks the distance to its low 6 bits and
     *  wraps on overflow rather than saturating. Unclamped, `5L shl 61` overflows NEGATIVE (so
     *  `coerceAtMost` picks the negative and the lockout lands in the past) and `5L shl 64` wraps
     *  back to 5 seconds, restarting the whole ramp. Clamping at 6 changes nothing an admin or a
     *  donor can observe — `5 shl 6` is 320, already past the 300s cap — it just stops the ramp
     *  from resetting itself every 64 attempts. */
    private fun backoffUntil(attempts: Int): Long {
        if (attempts < FREE_ATTEMPTS) return 0L
        val steps = (attempts - FREE_ATTEMPTS).coerceAtMost(BACKOFF_MAX_STEPS)
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
        // How long the thank-you screen stays up before returning to the giving screen.
        const val THANKS_MS = 8_000L
        // How long an abandoned donation (Details/Card/Error, no touches) waits before resetting.
        const val IDLE_ABANDON_MS = 45_000L
        // While the keyed-card WebView is open the donor's taps don't reach us, so give a long window.
        const val MANUAL_IDLE_MS = 120_000L
        // The longest a named family's balance may stay on the wall, touches or not. Generous enough
        // to read three bills and use the amount pad; short enough that a screen full of a family's
        // arrears can't be left up by someone who wandered off with a finger on the glass.
        const val TUITION_MAX_ON_SCREEN_MS = 180_000L
        // Deliberately hard to trigger by accident: 10 rapid taps in the hidden corner within the
        // window below. Bumped from 7 → 10 to further lock the kiosk down.
        const val SECRET_TAPS = 10
        const val SECRET_WINDOW_MS = 3_000L
        const val FREE_ATTEMPTS = 3
        const val BACKOFF_BASE_SECONDS = 5L
        const val MAX_BACKOFF_SECONDS = 300L
        // 5 << 6 == 320s, already past the cap — so this is where the ramp stops mattering. Kept as
        // a named bound because its job is to keep the shift distance small (see backoffUntil).
        const val BACKOFF_MAX_STEPS = 6
    }
}
