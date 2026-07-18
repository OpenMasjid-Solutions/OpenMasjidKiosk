// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.unit.Constraints

/**
 * Rotate the ENTIRE kiosk UI by [degrees] (0 / 90 / 180 / 270), set from the web UI.
 *
 * Why we rotate the content ourselves instead of `setRequestedOrientation`: many tablets — especially
 * large-screen Android 12L+ devices — have "ignore orientation request" on by default, so an app
 * asking the system for portrait/landscape is silently ignored and nothing rotates. Drawing the UI
 * rotated is device-independent: it always works, on any tablet, in any mount position. Compose
 * transforms pointer input through the same layer, so taps still land on the right controls.
 *
 * For 90°/270° we measure the content with WIDTH and HEIGHT swapped, then rotate about the centre, so
 * the rotated UI fills the screen exactly (the classic rotate-to-fill layout).
 */
@Composable
fun RotatedRoot(degrees: Int, content: @Composable () -> Unit) {
    val d = ((degrees % 360) + 360) % 360
    // Always route content through the SAME Layout call site (even at 0°, an identity transform), so
    // changing the rotation at runtime doesn't dispose + recreate the whole kiosk UI subtree (which
    // would reload the card WebView and reset numpad/local state).
    Layout(
        content = content,
        modifier = Modifier.fillMaxSize().graphicsLayer { rotationZ = d.toFloat() },
    ) { measurables, constraints ->
        val w = constraints.maxWidth
        val h = constraints.maxHeight
        // 90/270 → measure in the swapped frame so, once rotated, it fills w×h. 0/180 → measure as-is.
        val childConstraints = if (d == 90 || d == 270) Constraints.fixed(h, w) else Constraints.fixed(w, h)
        val placeables = measurables.map { it.measure(childConstraints) }
        layout(w, h) {
            // Centre each child so the rotation about the layer centre keeps it on-screen.
            placeables.forEach { it.place((w - it.width) / 2, (h - it.height) / 2) }
        }
    }
}

/** Map a stored orientation value to a content-rotation angle. Accepts the new degree strings and the
 *  legacy named values (from the first cut of this feature), defaulting to 0 (no rotation). */
fun orientationDegrees(value: String?): Int = when (value) {
    "90", "portrait" -> 90
    "180", "landscapeReverse" -> 180
    "270", "portraitReverse" -> 270
    else -> 0 // "0" | "auto" | "landscape" | null / unknown
}
