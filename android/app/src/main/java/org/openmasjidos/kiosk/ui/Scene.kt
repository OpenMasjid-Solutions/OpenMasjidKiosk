// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import org.openmasjidos.kiosk.ui.theme.SceneEnd
import org.openmasjidos.kiosk.ui.theme.SceneMid
import org.openmasjidos.kiosk.ui.theme.SceneStart

/**
 * The shared ambient Sakīna scene used across kiosk surfaces (attract, pairing, PIN, etc.).
 * It is dark in BOTH themes (per DESIGN.md §4), so on-scene text uses the fixed light "on-scene"
 * inks rather than theme onBackground.
 */
val SceneBrush: Brush
    @Composable get() = Brush.linearGradient(
        colors = listOf(SceneStart, SceneMid, SceneEnd),
        start = Offset(0f, 0f),
        end = Offset(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY),
    )

/** A full-screen box painted with [SceneBrush]. Content is centred by default. */
@Composable
fun SceneSurface(
    modifier: Modifier = Modifier,
    contentAlignment: Alignment = Alignment.Center,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(SceneBrush),
        contentAlignment = contentAlignment,
    ) {
        content()
    }
}
