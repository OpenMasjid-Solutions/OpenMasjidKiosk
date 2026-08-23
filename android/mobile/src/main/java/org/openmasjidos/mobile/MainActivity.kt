// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.openmasjidos.kiosk.ui.theme.SakinaTheme

/**
 * The whole of OpenMasjid Mobile Donations, for now.
 *
 * This is the SHELL only — the module exists, it depends on `:core`, and it builds. Pairing, the
 * Stripe Reader M2 and the collection flow arrive in the layers after this one. It is deliberately
 * pushed on its own so that if CI goes red, the cause is this module and nothing else.
 *
 * IT IS NOT BUNDLED INTO THE SERVER IMAGE YET, and that is the point. `/new` only offers an app
 * whose APK is actually present, and CI does not hand this one to the image build until it can do
 * something useful. A volunteer will never be shown a download button for a placeholder.
 *
 * `ComponentActivity` rather than the kiosk's heavily-overridden Activity: no HOME intent, no Lock
 * Task, no leave-watchdog, no immersive-sticky bars, no keep-screen-on. This is somebody's own
 * phone and it must behave like every other app on it — Home works, Back works, Recents works.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            SakinaTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Placeholder()
                }
            }
        }
    }
}

@Composable
private fun Placeholder() {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "OpenMasjid Mobile Donations",
            style = MaterialTheme.typography.headlineSmall,
            textAlign = TextAlign.Center,
        )
        Text(
            text = "Setting up.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}
