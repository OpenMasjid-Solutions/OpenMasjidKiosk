// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import org.openmasjidos.mobile.PairUi

/**
 * Connect this phone to a masjid.
 *
 * ORDINARY PHONE INPUT, and that is the difference from the kiosk's pairing screen. The kiosk
 * draws its own on-screen keypad because a wall tablet in Lock Task cannot be trusted to have a
 * usable IME and a volunteer must not be able to swipe out of it. Here the person owns the device:
 * they get the keyboard they already know, autofill, paste. Hence `imePadding()` so the keyboard
 * never covers the field being typed into, and a scrollable column so a short phone in landscape
 * still reaches the button.
 *
 * The address matters more than it looks. At an event this will be the masjid's PUBLIC address
 * (the OpenMasjidOS Cloudflare tunnel), not a LAN one — the volunteer may be nowhere near the
 * building. `:core` chooses the TLS mode from the address itself, so nothing here needs a "is this
 * remote?" switch for someone to get wrong.
 */
@Composable
fun PairScreen(
    ui: PairUi,
    onSubmit: (url: String, code: String, name: String) -> Unit,
) {
    var url by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("") }

    val codeOk = code.length == 6
    val urlOk = url.isNotBlank()
    val canSubmit = codeOk && urlOk && !ui.busy

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .navigationBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 28.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(
            text = "Connect to your masjid",
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            text = "Enter the address your masjid gave you and the 6-digit code from Devices. " +
                "The code works once and expires after 10 minutes.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Spacer(Modifier.height(2.dp))

        OutlinedTextField(
            value = url,
            onValueChange = { url = it.trim() },
            label = { Text("Server address") },
            placeholder = { Text("https://omos.yourmasjid.org/kiosk") },
            singleLine = true,
            // Uri, not Text: gives the keyboard a "/" and ".com" without the app having to
            // sanitise autocapitalised input afterwards.
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
            enabled = !ui.busy,
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = code,
            // Filtered to digits and capped at 6 as it is typed, so the field cannot hold something
            // the server would only reject after a round trip.
            onValueChange = { code = it.filter(Char::isDigit).take(6) },
            label = { Text("6-digit code") },
            placeholder = { Text("000000") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Next),
            enabled = !ui.busy,
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = name,
            onValueChange = { name = it.take(40) },
            label = { Text("Name this phone (optional)") },
            placeholder = { Text("e.g. Ahmad’s phone") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            enabled = !ui.busy,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            text = "This is what the masjid sees in Devices, so give it a name they will recognise " +
                "when several people are collecting at once.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (ui.error.isNotEmpty()) {
            Text(
                text = ui.error,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
        }

        Spacer(Modifier.height(4.dp))

        Button(
            onClick = { onSubmit(url, code, name) },
            enabled = canSubmit,
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp),
        ) {
            if (ui.busy) {
                CircularProgressIndicator(
                    modifier = Modifier.height(20.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary,
                )
            } else {
                Text("Connect")
            }
        }

        Text(
            text = "Nothing is charged to this phone, and no card details ever touch it — the " +
                "card reader talks to the payment network directly.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
    }
}
