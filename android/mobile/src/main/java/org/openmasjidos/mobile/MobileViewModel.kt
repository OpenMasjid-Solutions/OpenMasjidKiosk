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
import org.openmasjidos.kiosk.readers.ReaderManager
import org.openmasjidos.kiosk.readers.ReaderTransport
import org.openmasjidos.kiosk.readers.ReaderUiState

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
