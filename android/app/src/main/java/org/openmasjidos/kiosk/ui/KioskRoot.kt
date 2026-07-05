// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
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
 */
@Composable
fun KioskRoot(
    vm: KioskViewModel,
    isDeviceOwner: Boolean,
    onExitKiosk: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val ui by vm.ui.collectAsStateWithLifecycle()

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
                AttractScreen(
                    masjidName = ui.config?.masjidName,
                    attractTitle = ui.config?.attractTitle,
                    identify = ui.identify,
                )
                when (ui.overlay) {
                    Overlay.None -> SecretCorner(onTap = vm::onSecretCornerTap)
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
                        onReturn = vm::closeOverlay,
                        onRePair = vm::rePair,
                        onExit = onExitKiosk,
                    )
                }
            }
        }
    }
}

/**
 * An invisible touch target in the top-start corner. Five taps within 3s (counted in the VM)
 * reveal the unlock PIN. It carries no ripple and no accessibility label so it stays hidden from
 * donors while remaining reachable by a maintainer who knows the gesture.
 */
@Composable
private fun SecretCorner(onTap: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Box(
        modifier = Modifier
            .size(84.dp)
            .clearAndSetSemantics { } // never announced to donors / TalkBack
            .clickable(
                interactionSource = interaction,
                indication = null,
                onClick = onTap,
            ),
    )
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
