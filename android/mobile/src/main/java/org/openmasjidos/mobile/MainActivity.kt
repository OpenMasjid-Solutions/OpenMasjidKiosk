// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import org.openmasjidos.kiosk.ui.theme.SakinaTheme
import org.openmasjidos.mobile.ui.PairScreen
import org.openmasjidos.mobile.ui.ReadyScreen

/**
 * OpenMasjid Mobile Donations.
 *
 * `ComponentActivity`, and nothing more: no HOME intent, no Lock Task, no leave-watchdog, no
 * immersive-sticky bars, no keep-screen-on. This is somebody's own phone and it must behave like
 * every other app on it — Home works, Back works, Recents works, and they can take a call.
 *
 * Routing is driven by whether a pairing exists in DataStore, not by navigation calls, so the
 * screen can never disagree with the stored state. Unpairing takes effect immediately for the same
 * reason, and so does a revoke, once the heartbeat layer lands.
 */
class MainActivity : ComponentActivity() {
    private val vm: MobileViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            SakinaTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    val screen by vm.screen.collectAsStateWithLifecycle()
                    val pairUi by vm.pair.collectAsStateWithLifecycle()

                    when (val s = screen) {
                        // Reading DataStore. Brief, but it must not flash the pairing form at
                        // someone who IS paired — at an event that reads as "it forgot my masjid".
                        Screen.Loading -> Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center,
                        ) { CircularProgressIndicator() }

                        Screen.Pair -> PairScreen(
                            ui = pairUi,
                            onSubmit = vm::submitPairing,
                        )

                        is Screen.Ready -> {
                            val reader by vm.reader.collectAsStateWithLifecycle()
                            val transport by vm.transport.collectAsStateWithLifecycle()
                            val locationId by vm.locationId.collectAsStateWithLifecycle()
                            val campaigns by vm.campaigns.collectAsStateWithLifecycle()
                            val chosen by vm.chosenCampaign.collectAsStateWithLifecycle()
                            val currency by vm.currency.collectAsStateWithLifecycle()
                            val collect by vm.collect.collectAsStateWithLifecycle()
                            ReadyScreen(
                                pairing = s.pairing,
                                reader = reader,
                                transport = transport,
                                locationId = locationId,
                                campaigns = campaigns,
                                chosenCampaignId = chosen,
                                currency = currency,
                                collect = collect,
                                onChooseCampaign = vm::chooseCampaign,
                                onTake = vm::takePayment,
                                onCancelCollect = vm::cancelCollect,
                                onResetCollect = vm::resetCollect,
                                onTransport = vm::setTransport,
                                onDiscover = vm::discoverReader,
                                onStopDiscovery = vm::stopDiscovery,
                                onConnect = vm::connectReader,
                                onDisconnectReader = vm::disconnectReader,
                                onUnpair = vm::unpair,
                            )
                        }
                    }
                }
            }
        }
    }
}
