// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import org.openmasjidos.kiosk.ui.AttractScreen
import org.openmasjidos.kiosk.ui.theme.SakinaTheme

/**
 * The single kiosk activity. It also declares itself as the device HOME launcher
 * (see AndroidManifest) so a wall tablet boots straight into the giving screen.
 *
 * Slice 1 just renders the themed attract screen; kiosk lock-task, pairing, the reader,
 * and the giving flow are wired up in later slices.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Draw the ambient scene edge-to-edge behind the system bars.
        enableEdgeToEdge()
        setContent {
            SakinaTheme {
                AttractScreen()
            }
        }
    }
}
