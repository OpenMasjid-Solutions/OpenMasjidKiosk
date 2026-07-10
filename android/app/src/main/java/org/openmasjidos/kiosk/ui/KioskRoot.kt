// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import android.app.Activity
import android.view.WindowManager
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import org.openmasjidos.kiosk.KioskViewModel
import org.openmasjidos.kiosk.Overlay
import org.openmasjidos.kiosk.Phase
import org.openmasjidos.kiosk.R
import org.openmasjidos.kiosk.ui.theme.InkMutedDark

/**
 * The kiosk state-machine host. Renders exactly one top-level surface for the current
 * [Phase]/overlay and owns the hidden unlock gesture.
 *
 * @param isDeviceOwner whether the tablet is provisioned as device owner; drives the
 *   "not a locked-down kiosk yet" hint on the maintenance screen.
 * @param onExitKiosk stop lock task and leave the app (wired to the Activity in MainActivity).
 * @param onOpenBrowser drop lock task and open a URL in the browser (used to install an app update).
 */
@Composable
fun KioskRoot(
    vm: KioskViewModel,
    isDeviceOwner: Boolean,
    onExitKiosk: () -> Unit,
    onOpenBrowser: (String) -> Unit,
    onSetHomeApp: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val ui by vm.ui.collectAsStateWithLifecycle()

    // When the admin (webui) or a maintainer asks this kiosk to update, open the APK link in the
    // browser so a person can install it, then clear the one-shot flag.
    val updateUrl = ui.openUpdateUrl
    LaunchedEffect(updateUrl) {
        if (updateUrl != null) {
            onOpenBrowser(updateUrl)
            vm.consumeOpenUpdate()
        }
    }

    // Force the tablet to maximum screen brightness (a wall kiosk should be as bright as possible) —
    // configurable in Admin → Kiosk settings, on by default. BRIGHTNESS_OVERRIDE_NONE hands control
    // back to the system when turned off.
    val ctx0 = LocalContext.current
    val maxBright = ui.config?.maxBrightness != false
    LaunchedEffect(maxBright) {
        (ctx0 as? Activity)?.let { act ->
            act.window.attributes = act.window.attributes.apply {
                screenBrightness = if (maxBright) 1f else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            }
        }
    }

    // Keyed/manual card entry runs Stripe.js Payment Element in an in-app WebView (ManualCardWebView)
    // presented as a full-screen overlay below when a keyed PaymentIntent is pending. Unlike Stripe's
    // PaymentSheet (which opens an external Chrome Custom Tab for 3DS/Link that a device-owner Lock
    // Task kiosk blocks), the WebView keeps everything in-app. The VM verifies the result server-side
    // before recording, same as the reader. The PAN is entered into Stripe's iframe, never our code.
    val manual = ui.giving.manual

    Box(modifier = modifier) {
        when {
            // A re-pair lockout overrides everything — fail closed.
            ui.rePair != null -> RePairScreen(reason = ui.rePair!!, onRePair = vm::rePair)

            ui.phase == Phase.Loading -> LoadingScreen()

            ui.phase == Phase.Unpaired -> PairingScreen(
                form = ui.form,
                onUrlChange = vm::onUrlChange,
                onCodeChange = vm::onCodeChange,
                onNameChange = vm::onNameChange,
                onSubmit = vm::pair,
            )

            else -> { // Paired — boot straight into the giving home (campaign tabs; no attract screen)
                GivingHome(vm = vm, ui = ui)
                when (ui.overlay) {
                    Overlay.None -> Unit // maintenance is reached by 7 rapid taps on the top header strip
                    Overlay.Pin -> PinPad(
                        state = ui.pin,
                        onSubmit = vm::submitPin,
                        onCancel = vm::closeOverlay,
                    )
                    Overlay.Maintenance -> MaintenanceScreen(
                        diagnostics = ui.diagnostics,
                        reader = ui.reader,
                        locationId = ui.config?.locationId.orEmpty(),
                        noPinSet = ui.config?.pinHash?.isNotBlank() != true,
                        exitAllowed = ui.exitAllowed,
                        showPinningHint = !isDeviceOwner,
                        onScanReaders = vm::scanForReaders,
                        onStopReaderScan = vm::stopReaderScan,
                        onConnectReader = vm::connectReader,
                        onDisconnectReader = vm::disconnectReader,
                        onInstallReaderUpdate = vm::installReaderUpdate,
                        onDismissReaderError = vm::dismissReaderError,
                        onReaderPermissionDenied = vm::onReaderPermissionDenied,
                        onUpdateApp = vm::requestAppUpdate,
                        onSetHomeApp = onSetHomeApp,
                        onOpenSettings = onOpenSettings,
                        onReturn = vm::closeOverlay,
                        onRePair = vm::rePair,
                        onExit = onExitKiosk,
                    )
                }
            }
        }
        // Keyed card entry (Stripe.js Payment Element in a WebView) — a full-screen overlay on top of
        // everything while a keyed PaymentIntent is pending. Stays in-app, so Lock Task never blocks it.
        manual?.let { m ->
            ManualCardWebView(
                clientSecret = m.clientSecret,
                publishableKey = m.publishableKey,
                accentHex = ui.activeCampaign?.accentColor?.takeIf { it.isNotBlank() } ?: "#22d3ee",
                payLabel = if (m.chargeMinor > 0) "Pay ${formatMoney(m.chargeMinor, m.currency.ifBlank { "USD" })}" else "Pay",
                amountLabel = ui.config?.masjidName?.takeIf { it.isNotBlank() } ?: "",
                onResult = vm::onManualResult,
            )
        }
    }
}

@Composable
private fun LoadingScreen() {
    SceneSurface {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.height(16.dp))
            Text(
                text = stringResource(R.string.loading),
                style = MaterialTheme.typography.bodyMedium,
                color = InkMutedDark,
            )
        }
    }
}
