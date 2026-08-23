// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.mobile

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import org.openmasjidos.kiosk.local.DeviceStore
import org.openmasjidos.kiosk.local.PairingRecord
import org.openmasjidos.kiosk.net.KioskRepository
import org.openmasjidos.kiosk.net.PairResult
import org.openmasjidos.kiosk.local.Campaign
import org.openmasjidos.kiosk.readers.PaymentController
import org.openmasjidos.kiosk.readers.ReaderConn
import org.openmasjidos.kiosk.readers.ReaderManager
import org.openmasjidos.kiosk.readers.ReaderTransport
import org.openmasjidos.kiosk.readers.ReaderUiState
import java.util.UUID

/**
 * The mobile app's state.
 *
 * Deliberately a fraction of the kiosk's ViewModel. That one runs a wall tablet: a heartbeat every
 * ten seconds, a config-version watcher, a leave-watchdog, PIN backoff, reader auto-reconnect on
 * boot. None of that belongs on a volunteer's phone, which is picked up for twenty minutes at an
 * event and then put away. What IS shared — the pairing call, the trust decision, the device token
 * at rest — comes from `:core` and is not reimplemented here.
 */
sealed interface Screen {
    /** Still reading DataStore; we do not yet know whether this phone is paired. */
    data object Loading : Screen
    data object Pair : Screen
    data class Ready(val pairing: PairingRecord) : Screen
}

/**
 * Where one collection has got to.
 *
 * Deliberately short. At an event the volunteer takes a donation, hands the phone back, and takes
 * another — so there is no attract screen, no details step and no long thank-you. The kiosk's flow
 * is built for a stranger walking up to a wall unaided; this one is built for someone doing it
 * fifty times an hour with a queue.
 */
sealed interface Collect {
    /** Entering an amount. */
    data object Idle : Collect
    /** Server is minting the PaymentIntent. */
    data object Preparing : Collect
    /** Reader is armed; the donor taps. [prompt] is the reader's own instruction, if it gave one. */
    data class Tap(val amountMinor: Long, val prompt: String?) : Collect
    /** Card read; the SERVER is verifying with Stripe. Nothing is recorded until it answers. */
    data object Verifying : Collect
    data class Done(val amountMinor: Long, val currency: String) : Collect
    /** A finished sentence, never an exception. */
    data class Failed(val message: String) : Collect
}

/** What the pairing form is doing right now. */
data class PairUi(
    val busy: Boolean = false,
    /** A finished, human sentence — never a raw error. Empty when there is nothing to say. */
    val error: String = "",
)

class MobileViewModel(app: Application) : AndroidViewModel(app) {
    private val store = DeviceStore(app)
    private val repo = KioskRepository(app)

    private val _screen = MutableStateFlow<Screen>(Screen.Loading)
    val screen: StateFlow<Screen> = _screen.asStateFlow()

    private val _pair = MutableStateFlow(PairUi())
    val pair: StateFlow<PairUi> = _pair.asStateFlow()

    /** The reader, straight from :core — the same state object the kiosk renders. */
    val reader: StateFlow<ReaderUiState> = ReaderManager.state

    /**
     * The Terminal Location this masjid's readers connect to, from the synced config.
     *
     * Empty until the first config fetch succeeds, and empty is meaningful: it means an admin has
     * not finished Payments setup, and the reader screen says exactly that rather than letting a
     * connect attempt fail with something a volunteer cannot act on.
     */
    val locationId: StateFlow<String> = store.config
        .map { it?.locationId.orEmpty() }
        .stateIn(viewModelScope, SharingStarted.Eagerly, "")

    init {
        // One collector for the life of the app: pairing is the only thing that decides which
        // screen is shown, and unpairing must take effect immediately rather than on next launch.
        viewModelScope.launch {
            store.pairing.collect { rec ->
                _screen.value = if (rec == null) Screen.Pair else Screen.Ready(rec)
                if (rec != null) {
                    ReaderManager.ensureInitialized(getApplication(), repo)
                    // Fail soft: no network at the hall yet is not a reason to show an error on a
                    // screen the volunteer has not asked anything of. The reader screen reports the
                    // consequence (no location set) if it never lands.
                    runCatching { repo.fetchConfig() }
                }
            }
        }
    }

    // ---- Reader ----------------------------------------------------------------------------

    /**
     * Which transport the volunteer has SELECTED — not the same thing as `reader.transport`.
     *
     * `ReaderUiState.transport` only changes when discovery actually starts, so driving the chips
     * from it would mean tapping "USB" appeared to do nothing until you also pressed Find. This is
     * the selection; that is the state of the hardware.
     */
    private val _transport = MutableStateFlow(ReaderTransport.Bluetooth)
    val transport: StateFlow<ReaderTransport> = _transport.asStateFlow()

    fun setTransport(t: ReaderTransport) {
        ReaderManager.clearError()
        _transport.value = t
    }

    fun discoverReader() {
        ReaderManager.clearError()
        ReaderManager.startDiscovery(_transport.value)
    }

    fun stopDiscovery() = ReaderManager.stopDiscovery()

    fun connectReader(serial: String) = ReaderManager.connect(serial, locationId.value)

    fun disconnectReader() = ReaderManager.disconnect()

    // ---- Collecting --------------------------------------------------------------------------

    /** The campaigns this masjid is running, from the synced config. */
    val campaigns: StateFlow<List<Campaign>> = store.config
        .map { it?.campaigns.orEmpty() }
        .stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val currency: StateFlow<String> = store.config
        .map { it?.currency.orEmpty().ifBlank { "USD" } }
        .stateIn(viewModelScope, SharingStarted.Eagerly, "USD")

    private val _chosenCampaign = MutableStateFlow("")
    val chosenCampaign: StateFlow<String> = _chosenCampaign.asStateFlow()
    fun chooseCampaign(id: String) { _chosenCampaign.value = id }

    private val _collect = MutableStateFlow<Collect>(Collect.Idle)
    val collect: StateFlow<Collect> = _collect.asStateFlow()

    /**
     * Take one donation.
     *
     * Server mints the intent, the reader collects and confirms, then the SERVER verifies with
     * Stripe and records it. The phone never decides that money moved — it reports an id and is
     * told the outcome. That is the same invariant the kiosk holds and it is not negotiable: a
     * device in a volunteer's hand is the last thing that should be trusted about a payment.
     *
     * `monthly = false` throughout. A standing order needs a name and an email, which is a form
     * nobody fills in at a fundraising table; monthly giving belongs on the kiosk or the website.
     */
    fun takePayment(amountMinor: Long) {
        if (_collect.value !is Collect.Idle && _collect.value !is Collect.Failed) return
        if (amountMinor <= 0) return
        if (reader.value.conn != ReaderConn.Connected) {
            _collect.value = Collect.Failed("Connect a card reader first.")
            return
        }
        _collect.value = Collect.Preparing
        viewModelScope.launch {
            // A fresh key per ATTEMPT. If the network drops after the server created the intent,
            // retrying with the same key would return the same intent rather than double-charging.
            val key = UUID.randomUUID().toString()
            val created = runCatching {
                repo.createPaymentIntent(
                    amountMinor = amountMinor,
                    campaignId = _chosenCampaign.value.ifBlank { null },
                    donorName = null,
                    donorEmail = null,
                    monthly = false,
                    manual = false,
                    coverFees = false,
                    idempotencyKey = key,
                )
            }.getOrElse {
                _collect.value = Collect.Failed("Couldn’t start the payment. Check this phone still has internet, then try again.")
                return@launch
            }

            _collect.value = Collect.Tap(created.chargeMinor.takeIf { it > 0 } ?: amountMinor, null)

            val confirmed = runCatching {
                PaymentController.collectAndConfirm(created.clientSecret, savingCard = false)
            }.getOrElse {
                // Includes the donor or volunteer cancelling, which is ordinary and not an error
                // worth alarming language over.
                _collect.value = Collect.Failed("That card didn’t go through. No money was taken — try again.")
                return@launch
            }

            _collect.value = Collect.Verifying
            val outcome = runCatching { repo.completePaymentIntent(confirmed) }.getOrElse {
                // The dangerous case, and it is stated honestly rather than guessed at: the card may
                // well have been charged, and this phone simply cannot know. It must not say
                // "failed" and it must not say "thank you".
                _collect.value = Collect.Failed(
                    "The card was read, but we couldn’t confirm it with the masjid’s server. " +
                        "Do NOT take it again — check the Donations page before retrying.",
                )
                return@launch
            }

            _collect.value = if (outcome.succeeded) {
                Collect.Done(outcome.amountMinor, outcome.currency)
            } else {
                Collect.Failed("That payment was declined. No money was taken.")
            }
        }
    }

    /** Back to the amount screen, ready for the next donor. */
    fun resetCollect() {
        _collect.value = Collect.Idle
    }

    /** Volunteer cancelled while the reader was waiting for a card. */
    fun cancelCollect() {
        PaymentController.cancelCollect()
        _collect.value = Collect.Idle
    }

    /**
     * Pair this phone with a masjid's server.
     *
     * The address is whatever the volunteer typed — a LAN address at the masjid, or the public
     * Cloudflare one at an event a hundred miles away. `:core` decides how to trust it: a private
     * address gets self-signed trust-on-first-use pinning, anything public gets ordinary system-CA
     * validation with hostname verification. Nothing here needs to know which, and nothing here
     * should try to guess — that classification lives in one place on purpose.
     */
    fun submitPairing(url: String, code: String, deviceName: String) {
        if (_pair.value.busy) return
        _pair.value = PairUi(busy = true)
        viewModelScope.launch {
            val name = deviceName.trim().ifBlank { "Mobile donations" }
            when (val r = repo.pair(url.trim(), code.trim(), name)) {
                is PairResult.Success -> {
                    // No explicit navigation: the `store.pairing` collector above sees the write
                    // and moves the screen. One source of truth for "is this phone paired".
                    _pair.value = PairUi()
                }
                is PairResult.Failed -> _pair.value = PairUi(error = message(r.reason))
            }
        }
    }

    /** Forget this masjid entirely — the token, the address, the synced config. */
    fun unpair() {
        viewModelScope.launch { store.clear() }
    }

    /**
     * A sentence a volunteer can act on, for every failure the repository can return.
     *
     * Never a status code and never an exception. The person reading this is standing in a hall
     * with a queue in front of them, and the only useful thing a message can do is say what to try
     * next.
     */
    private fun message(reason: PairResult.Reason): String = when (reason) {
        PairResult.Reason.INVALID_URL ->
            "That address doesn’t look right. It should start with https:// — copy it exactly as the masjid gave it to you."
        PairResult.Reason.INVALID_CODE ->
            "A pairing code is 6 digits."
        PairResult.Reason.CODE_REJECTED ->
            "That code wasn’t accepted. Codes work once and expire after 10 minutes — ask for a fresh one in Devices."
        PairResult.Reason.UNREACHABLE ->
            "Couldn’t reach that server. Check this phone has internet, and that the address is the one the masjid gave you."
        PairResult.Reason.CERT ->
            "Couldn’t establish a secure connection to that server. If the masjid has just changed its address or certificate, ask them to check it."
        PairResult.Reason.GENERIC ->
            "That didn’t work. Please check the address and the code, then try again."
    }
}
