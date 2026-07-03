// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.openmasjidos.kiosk.R
import org.openmasjidos.kiosk.RePairReason
import org.openmasjidos.kiosk.ui.theme.InkDark
import org.openmasjidos.kiosk.ui.theme.InkMutedDark

/**
 * Fail-closed lockout screen. Shown when the pinned certificate changed (possible MITM or a
 * legitimate cert rotation) or the server revoked this device. The only way forward is to pair
 * again — we never silently reconnect on a changed cert.
 */
@Composable
fun RePairScreen(
    reason: RePairReason,
    onRePair: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SceneSurface(modifier = modifier) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier
                .widthIn(max = 440.dp)
                .padding(28.dp),
        ) {
            Text(
                text = stringResource(R.string.repair_title),
                style = MaterialTheme.typography.displayMedium,
                color = InkDark,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(14.dp))
            Text(
                text = when (reason) {
                    RePairReason.CertChanged -> stringResource(R.string.repair_reason_cert)
                },
                style = MaterialTheme.typography.bodyLarge,
                color = InkMutedDark,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(28.dp))
            Button(
                onClick = onRePair,
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp),
            ) {
                Text(stringResource(R.string.repair_button), style = MaterialTheme.typography.titleLarge)
            }
        }
    }
}
