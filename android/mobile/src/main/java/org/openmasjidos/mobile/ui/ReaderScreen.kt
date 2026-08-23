// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.mobile.ui

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import org.openmasjidos.kiosk.readers.ReaderConn
import org.openmasjidos.kiosk.readers.ReaderTransport
import org.openmasjidos.kiosk.readers.ReaderUiState
import org.openmasjidos.kiosk.readers.readerPermissions

/**
 * Connecting a Stripe Reader M2 from a phone.
 *
 * THE PERMISSION STORY IS THE WHOLE DIFFERENCE FROM THE KIOSK, and it is why this screen exists
 * rather than reusing the maintenance screen. A kiosk tablet is usually provisioned as device
 * owner, so `grantReaderPermissions` grants Bluetooth and location silently and the volunteer
 * never sees a dialog. A volunteer's own phone is NEVER device owner. Every permission is a
 * runtime prompt they can decline, and can decline permanently.
 *
 * So this screen asks at the moment it is needed and explains why first, rather than firing a bare
 * system dialog at someone the second they open the app. It also handles the case the kiosk never
 * has to: "denied, don't ask again", where the only way back is the system settings page, and an
 * app that keeps re-showing a dialog Android will never display again just looks broken.
 *
 * Location is requested even for USB, which reads as absurd and is not our choice: the Terminal
 * SDK requires it for every discovery configuration. `readerPermissions` in :core is the single
 * definition of that, shared with the kiosk.
 */
@Composable
fun ReaderScreen(
    state: ReaderUiState,
    /** The volunteer's chosen transport. Distinct from `state.transport`, which follows the
     *  hardware and only moves once discovery begins. */
    transport: ReaderTransport,
    locationId: String,
    onTransport: (ReaderTransport) -> Unit,
    onDiscover: () -> Unit,
    onStopDiscovery: () -> Unit,
    onConnect: (serial: String) -> Unit,
    onDisconnect: () -> Unit,
) {
    val context = LocalContext.current
    val needed = readerPermissions(transport)

    // `RequestMultiplePermissions` returns a per-permission verdict. Discovery only starts if the
    // whole set was granted — a partial grant (Bluetooth yes, location no) fails inside the SDK
    // with a message no volunteer could act on, so it is better caught here.
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result.values.all { it }) onDiscover()
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Card reader", style = MaterialTheme.typography.titleMedium)

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = transport == ReaderTransport.Bluetooth,
                onClick = { onTransport(ReaderTransport.Bluetooth) },
                label = { Text("Bluetooth") },
                enabled = state.conn != ReaderConn.Discovering && state.conn != ReaderConn.Connecting,
            )
            FilterChip(
                selected = transport == ReaderTransport.Usb,
                onClick = { onTransport(ReaderTransport.Usb) },
                label = { Text("USB") },
                enabled = state.conn != ReaderConn.Discovering && state.conn != ReaderConn.Connecting,
            )
        }
        if (transport == ReaderTransport.Usb) {
            Text(
                // Said plainly, because it is the single most common reason USB "doesn't work" on a
                // phone: most phones need an OTG adapter, and most people do not have one in a hall.
                text = "USB needs an OTG adapter on most phones. Bluetooth is usually easier when you’re walking around.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        when (state.conn) {
            ReaderConn.Connected -> ConnectedCard(state, onDisconnect)

            ReaderConn.Updating -> Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Updating the reader", style = MaterialTheme.typography.titleSmall)
                    // Unplugging mid-update is the one thing that can brick an M2, so this says so
                    // rather than showing a bare progress bar.
                    Text(
                        "Leave the reader switched on and nearby until this finishes.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    val pct = state.updateProgress
                    if (pct != null) {
                        LinearProgressIndicator(progress = { pct / 100f }, modifier = Modifier.fillMaxWidth())
                        Text("$pct%", style = MaterialTheme.typography.bodySmall)
                    } else {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                }
            }

            ReaderConn.Discovering -> Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        CircularProgressIndicator(modifier = Modifier.height(18.dp), strokeWidth = 2.dp)
                        Text("Looking for readers…", style = MaterialTheme.typography.bodyMedium)
                    }
                    if (state.discovered.isEmpty()) {
                        Text(
                            "Hold the reader’s button until it shows a flashing light.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    state.discovered.forEach { r ->
                        Text(
                            text = r.label,
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { onConnect(r.serial) }
                                .padding(vertical = 10.dp),
                        )
                    }
                    OutlinedButton(onClick = onStopDiscovery, modifier = Modifier.fillMaxWidth()) {
                        Text("Stop looking")
                    }
                }
            }

            ReaderConn.Connecting -> Row(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(modifier = Modifier.height(18.dp), strokeWidth = 2.dp)
                Text("Connecting…", style = MaterialTheme.typography.bodyMedium)
            }

            ReaderConn.NotConnected, ReaderConn.Error -> {
                // A missing Terminal Location is an ADMIN problem, not something the volunteer can
                // fix by tapping harder, so say who has to do what instead of failing at connect time.
                if (locationId.isBlank()) {
                    Text(
                        "This masjid hasn’t finished its card-reader setup yet. An admin needs to " +
                            "complete Payments setup in the admin panel before a reader can connect.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                    )
                } else {
                    Button(
                        onClick = {
                            if (needed.isEmpty()) onDiscover() else ask.launch(needed)
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(50.dp),
                    ) { Text("Find my reader") }

                    Text(
                        text = "You’ll be asked for Bluetooth and location access. Location is required " +
                            "by the card-reader software to find a reader — this app never tracks where you are.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        state.error?.let { err ->
            Spacer(Modifier.height(2.dp))
            Text(err, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
            // The escape hatch for "deny and don't ask again". Android will never show the dialog
            // again, so an app that only offers a retry button is asking someone to press a control
            // that provably cannot work. This opens the one place it can be undone.
            OutlinedButton(
                onClick = {
                    context.startActivity(
                        Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", context.packageName, null),
                        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Open app permissions") }
        }
    }
}

@Composable
private fun ConnectedCard(state: ReaderUiState, onDisconnect: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Reader connected", style = MaterialTheme.typography.titleSmall)
            state.connectedLabel?.let {
                Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            // Bound to a local: `state` comes from :core, and Kotlin will not smart-cast a public
            // property declared in another module. (The same rule bit MaintenanceScreen.kt when the
            // :core split landed — see its comment.)
            state.battery?.let { pct ->
                val charge = if (state.charging == true) " · charging" else ""
                Text(
                    "Battery $pct%$charge",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            OutlinedButton(onClick = onDisconnect, modifier = Modifier.fillMaxWidth()) {
                Text("Disconnect reader")
            }
        }
    }
}
