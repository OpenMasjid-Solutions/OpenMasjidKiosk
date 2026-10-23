// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui.theme

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
 *
 * EVERY SURFACE ROLE IS SET, including the `surfaceContainer*` family Material 3 added. Leave one out
 * and Material quietly supplies its own baseline palette for it — a grey-lilac — and that is what a
 * default `Card` painted in Mobile Donations (it uses `surfaceContainerHighest`), sitting on our navy
 * page like a panel from another app. They are mapped by what the component IS, the way the web
 * tokens name them, rather than by Material's tone ladder:
 *  - a panel (Card, a filled text field) is `--color-surface-raised` — spec §5, "Panels:
 *    --color-surface-raised" — so `surfaceContainerHighest`/`Low` are the raised surface;
 *  - a menu, a dialog or a navigation bar floats above the page, which the tokens call
 *    `--color-surface-overlay` ("menus, popovers"), so `surfaceContainer`/`High` are the overlay;
 *  - `surfaceContainerLowest` and `surfaceDim` are the page itself.
 * That breaks Material's rule that "Highest" is the most tinted, on purpose: a card here reads the
 * same as a panel in the admin panel, and a dialog still stands out from the card it opens over.
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
    surfaceTint = PrimaryDark,
    outline = InkFaintDark,
    outlineVariant = SurfaceOverlayDark,
    error = DangerDark,
    onError = Color(0xFF2A0A0A),
    scrim = Color(0xFF000000),
    surfaceBright = SurfaceOverlayDark,
    surfaceDim = SurfaceDark,
    surfaceContainerLowest = SurfaceDark,
    surfaceContainerLow = SurfaceRaisedDark,
    surfaceContainer = SurfaceOverlayDark,
    surfaceContainerHigh = SurfaceOverlayDark,
    surfaceContainerHighest = SurfaceRaisedDark,
)

private val LightColors: ColorScheme = lightColorScheme(
    // The BUTTON blue, --color-btn: Material paints a filled Button with `primary` and a TextButton's
    // label in it too, so it must pass AA both as a fill under white ink (5.93:1) and as text on the
    // page (5.57:1). The platform's lighter #0284C7 managed 4.10 and 3.84 — every filled button in
    // Mobile Donations on a phone set to light mode ("Take payment", "Connect", "Next donation").
    primary = BtnLight,
    onPrimary = OnPrimaryLight,
    primaryContainer = PrimaryMutedLight,
    onPrimaryContainer = InkLight,
    secondary = GoldLight,
    // Dark ink, not white: white on this gold is 3.19:1. This is the gold accent's own onPrimary from
    // the platform's accent table, 5.23:1 here.
    onSecondary = Color(0xFF2B1B00),
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
    surfaceTint = BtnLight,
    outline = InkFaintLight,
    outlineVariant = SurfaceOverlayLight,
    error = DangerLight,
    onError = Color(0xFFFFFFFF),
    scrim = Color(0xFF000000),
    surfaceBright = SurfaceRaisedLight,
    surfaceDim = SurfaceLight,
    surfaceContainerLowest = SurfaceLight,
    surfaceContainerLow = SurfaceRaisedLight,
    surfaceContainer = SurfaceOverlayLight,
    surfaceContainerHigh = SurfaceOverlayLight,
    surfaceContainerHighest = SurfaceRaisedLight,
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
