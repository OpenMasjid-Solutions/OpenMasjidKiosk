// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.openmasjidos.kiosk.local.PairingRecord

/**
 * What a paired phone shows, until the reader and the collection flow land in the next layers.
 *
 * It is not a placeholder in the way the very first screen was: this phone genuinely IS paired to
 * a masjid, holds a device token, and appears in the admin's Devices list. Saying so — and naming
 * the server it is bound to — is the honest report of its actual state, and it is what makes the
 * pairing layer testable on a real phone before there is anything to charge a card with.
 */
@Composable
fun ReadyScreen(
    pairing: PairingRecord,
    onUnpair: () -> Unit,
) {
    var confirming by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .padding(horizontal = 24.dp, vertical = 28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Connected", style = MaterialTheme.typography.headlineSmall)
        Text(
            text = "This phone is paired and appears in your masjid’s Devices list.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("Server", style = MaterialTheme.typography.labelMedium)
                // The address only. The device TOKEN is never rendered — it is the credential that
                // can create charges against the masjid's Stripe account, and a screen someone can
                // photograph over your shoulder is no place for it.
                Text(pairing.serverUrl, style = MaterialTheme.typography.bodyMedium)
            }
        }

        Text(
            text = "Taking payments comes next — connect a Stripe Reader M2 over Bluetooth or USB.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        // No import for `weight` — it is a ColumnScope extension supplied by the enclosing
        // Column's receiver. Importing androidx.compose.foundation.layout.weight instead resolves
        // to an INTERNAL RowColumnParentData extension and fails to compile.
        Spacer(Modifier.weight(1f))

        TextButton(onClick = { confirming = true }, modifier = Modifier.fillMaxWidth()) {
            Text("Disconnect from this masjid")
        }
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text("Disconnect this phone?") },
            // Says what is actually lost, and that recovery needs someone else. A volunteer who
            // taps this at an event cannot fix it alone — they need an admin to issue a new code.
            text = {
                Text(
                    "This phone will stop being able to take donations. To use it again you’ll need " +
                        "a new 6-digit pairing code from the masjid’s admin panel.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    confirming = false
                    onUnpair()
                }) { Text("Disconnect") }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) { Text("Cancel") }
            },
        )
    }
}
