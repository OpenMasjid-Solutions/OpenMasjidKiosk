// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

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
import com.stripe.android.PaymentConfiguration
import com.stripe.android.paymentsheet.PaymentSheet
import com.stripe.android.paymentsheet.PaymentSheetResult
import com.stripe.android.paymentsheet.rememberPaymentSheet
import org.openmasjidos.kiosk.GivingStep
import org.openmasjidos.kiosk.KioskViewModel
import org.openmasjidos.kiosk.ManualResult
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

    // Manual/keyed card entry: present Stripe's own card sheet (it tokenises the card on-device and
    // confirms the PaymentIntent directly with Stripe — our code never sees the card number). The VM
    // then verifies the result server-side before recording, same as the reader.
    val context = LocalContext.current
    val paymentSheet = rememberPaymentSheet { result ->
        when (result) {
            is PaymentSheetResult.Completed -> vm.onManualResult(ManualResult.Completed)
            is PaymentSheetResult.Canceled -> vm.onManualResult(ManualResult.Canceled)
            is PaymentSheetResult.Failed -> vm.onManualResult(ManualResult.Failed, result.error.message)
        }
    }
    val manual = ui.giving.manual
    LaunchedEffect(manual?.piId) {
        if (manual != null) {
            runCatching { PaymentConfiguration.init(context, manual.publishableKey) }
            paymentSheet.presentWithPaymentIntent(
                manual.clientSecret,
                PaymentSheet.Configuration(
                    merchantDisplayName = ui.config?.masjidName?.takeIf { it.isNotBlank() } ?: "Donation",
                ),
            )
        }
    }

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

            else -> { // Paired
                if (ui.giving.step != GivingStep.Idle) {
                    GivingScreen(
                        giving = ui.giving,
                        config = ui.config,
                        readerPrompt = ui.reader.prompt,
                        onSetMonthly = vm::setMonthly,
                        onChooseAmount = vm::chooseAmount,
                        onDonorName = vm::setDonorName,
                        onDonorEmail = vm::setDonorEmail,
                        onSubmitDetails = vm::submitDetails,
                        onRetry = vm::retryGiving,
                        onEnterManually = vm::enterManually,
                        onCancel = vm::cancelGiving,
                    )
                } else {
                    AttractScreen(
                        masjidName = ui.config?.masjidName,
                        attractTitle = ui.config?.attractTitle,
                        identify = ui.identify,
                        onTapToDonate = vm::beginGiving,
                        onSecretTap = vm::onSecretTap,
                    )
                }
                when (ui.overlay) {
                    Overlay.None -> Unit // maintenance is reached by 7 rapid taps on the attract screen
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
                        onReturn = vm::closeOverlay,
                        onRePair = vm::rePair,
                        onExit = onExitKiosk,
                    )
                }
            }
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
