// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package com.openmasjid.kiosk.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * The Sakīna Material 3 color schemes.
 *
 * Roles are mapped from the OpenMasjidOS tokens: cyan primary, gold accent used sparingly
 * (secondary), the deep night-sky surfaces in dark and the warm ivory surfaces in light.
 * We deliberately do NOT use dynamic color (Material You): the brand palette is fixed so
 * the kiosk looks identical on every device. Dark is the design default.
 */
private val DarkColors: ColorScheme = darkColorScheme(
    primary = PrimaryDark,
    onPrimary = OnPrimaryDark,
    primaryContainer = PrimaryMutedDark,
    onPrimaryContainer = InkDark,
    secondary = GoldDark,
    onSecondary = Color(0xFF201400),
    secondaryContainer = Color(0xFF3A2A08),
    onSecondaryContainer = InkDark,
    tertiary = PrimaryHoverDark,
    onTertiary = OnPrimaryDark,
    background = SurfaceDark,
    onBackground = InkDark,
    surface = SurfaceRaisedDark,
    onSurface = InkDark,
    surfaceVariant = SurfaceOverlayDark,
    onSurfaceVariant = InkMutedDark,
    outline = InkFaintDark,
    outlineVariant = SurfaceOverlayDark,
    error = DangerDark,
    onError = Color(0xFF2A0A0A),
    scrim = Color(0xFF000000),
)

private val LightColors: ColorScheme = lightColorScheme(
    primary = PrimaryLight,
    onPrimary = OnPrimaryLight,
    primaryContainer = PrimaryMutedLight,
    onPrimaryContainer = InkLight,
    secondary = GoldLight,
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFFDE9C8),
    onSecondaryContainer = InkLight,
    tertiary = PrimaryHoverLight,
    onTertiary = OnPrimaryLight,
    background = SurfaceLight,
    onBackground = InkLight,
    surface = SurfaceRaisedLight,
    onSurface = InkLight,
    surfaceVariant = SurfaceOverlayLight,
    onSurfaceVariant = InkMutedLight,
    outline = InkFaintLight,
    outlineVariant = SurfaceOverlayLight,
    error = DangerLight,
    onError = Color(0xFFFFFFFF),
    scrim = Color(0xFF000000),
)

/**
 * App theme wrapper. [darkTheme] follows the system by default; the OpenMasjidOS brand
 * default is dark, and the ambient kiosk scene is dark in both themes regardless.
 * RTL is handled automatically by Compose from the locale — do not force a layout direction.
 */
@Composable
fun SakinaTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colorScheme = if (darkTheme) DarkColors else LightColors
    MaterialTheme(
        colorScheme = colorScheme,
        typography = SakinaTypography,
        content = content,
    )
}
