// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance

/**
 * Sakīna palette — the native mirror of this app's design tokens, so the Android apps read as part
 * of the same product as the admin panel and the OpenMasjidOS dashboard. Dark is the default theme.
 *
 * WHERE THE VALUES COME FROM. They mirror web/src/styles/tokens.css — the admin panel's tokens —
 * NOT the platform's tokens.css verbatim, which is what this comment used to claim. The two differ on
 * purpose, and only for contrast: this app raises the muted and faint inks (the platform's faint ink
 * measures 2.2–3.6:1 on its own surfaces) and uses the platform's own button blue as the light
 * theme's primary (the platform's #0284C7 is 4.1:1 under white text). server/src/theme-contrast.test.ts
 * measures every one of those web values against WCAG AA, so "tidying" one back to the platform's
 * figure fails there, loudly — and the same change must not be made quietly here instead.
 *
 * Keep these in sync with web/src/styles/tokens.css when it changes.
 */

// ---- Dark (DEFAULT) ------------------------------------------------------------------
val SurfaceDark = Color(0xFF030D1A)         // --color-surface
val SurfaceRaisedDark = Color(0xFF0A1828)   // --color-surface-raised
val SurfaceOverlayDark = Color(0xFF0F2040)  // --color-surface-overlay

val PrimaryDark = Color(0xFF22D3EE)         // --color-primary (cyan) — also --color-btn in dark
val PrimaryHoverDark = Color(0xFF67E8F9)    // --color-primary-hover
val PrimaryMutedDark = Color(0xFF155E75)    // --color-primary-muted

val GoldDark = Color(0xFFF59E0B)            // --color-accent / --color-gold

val InkDark = Color(0xFFF4F7FB)             // --color-ink
val InkMutedDark = Color(0xFFAEBACD)        // --color-ink-muted (raised for AA; platform #9FACC2)
val InkFaintDark = Color(0xFF8593AD)        // --color-ink-faint (raised for AA; platform #5C6B83)

val OnPrimaryDark = Color(0xFF00131C)       // --color-on-primary
val SuccessDark = Color(0xFF34D399)         // --color-success
val WarningDark = Color(0xFFFBBF24)         // --color-warning
val DangerDark = Color(0xFFF87171)          // --color-danger

// Ambient scene gradient (fixed; dark in both themes per DESIGN.md §4).
val SceneStart = Color(0xFF0C3A4D)
val SceneMid = Color(0xFF082230)
val SceneEnd = Color(0xFF020A12)

// ---- Light -------------------------------------------------------------------------
val SurfaceLight = Color(0xFFF0F9FF)        // --color-surface
val SurfaceRaisedLight = Color(0xFFFFFFFF)  // --color-surface-raised
val SurfaceOverlayLight = Color(0xFFE0F2FE) // --color-surface-overlay

// The light primary is the platform's BUTTON blue, not its #0284C7, in tokens.css as here: that one is
// 3.8:1 as text on the light page and 4.1:1 under white ink, and Compose uses one `primary` for both a
// filled button and a text button's label, so it has to pass as both. This one is 5.9:1 and 5.6:1.
val PrimaryLight = Color(0xFF0369A1)        // --color-primary
val PrimaryHoverLight = Color(0xFF075985)   // --color-primary-hover
val PrimaryMutedLight = Color(0xFFBAE6FD)   // --color-primary-muted

/** The fill of a filled button in light theme (the spec's --color-btn), with [OnPrimaryLight] on it
 *  at 5.93:1. The same hex as [PrimaryLight] today; named separately because the spec gives the
 *  button its own token, and a later accent change must be able to move one without the other. */
val BtnLight = Color(0xFF0369A1)            // --color-btn

val GoldLight = Color(0xFFD97706)           // --color-accent / --color-gold

val InkLight = Color(0xFF0C4A6E)            // --color-ink
val InkMutedLight = Color(0xFF44515F)       // --color-ink-muted (raised for AA; platform #475569)
val InkFaintLight = Color(0xFF5B6978)       // --color-ink-faint (4.9:1 on the overlay surface; platform #94A3B8)

val OnPrimaryLight = Color(0xFFFFFFFF)      // --color-on-primary
val SuccessLight = Color(0xFF16A34A)        // --color-success
val WarningLight = Color(0xFFD97706)        // --color-warning
val DangerLight = Color(0xFFDC2626)         // --color-danger

// ---- Giving-screen fixtures ------------------------------------------------------------
// Colours the kiosk's donor screens paint that are not part of the light/dark theme, because the
// giving screen is campaign-designed content (its colours are the admin's, per appeal). They live here
// rather than as raw hex in the screens so there is one place that says what each one is for.

/** The near-black ink for bright fills: big bold amounts, headings on a light campaign wash, the
 *  white amount tiles. web/src/contrast.ts `INK_BLACK` is the same value, so the admin's live preview
 *  inks a tile exactly as the tablet does. */
val InkBlack = Color(0xFF0A0F14)

/** The dim laid over a campaign's background PHOTO so light text stays legible on any image. */
val ImageScrim = Color(0xAA020A12)

/** The opaque backdrop behind the keyed-entry card form (a WebView), matching kioskpay.html's own
 *  background, so the giving screen never shows through and there is no white flash before the page
 *  paints. A View wants an ARGB Int: `CardEntryBackdrop.toArgb()`. */
val CardEntryBackdrop = Color(0xFF071726)

/** WCAG contrast ratio between two colours, 1..21. Compose's [luminance] is the WCAG relative
 *  luminance, so this is the same arithmetic as web/src/contrast.ts `contrastRatio`. */
fun contrastRatio(a: Color, b: Color): Float {
    val la = a.luminance()
    val lb = b.luminance()
    return (maxOf(la, lb) + 0.05f) / (minOf(la, lb) + 0.05f)
}

/**
 * The ink for a FILLED element of colour [fill]: whichever of [InkBlack] and white contrasts more.
 *
 * With PURE black the better of the two always clears 4.5:1 (the worst case, a mid-tone around
 * L≈0.18, is 4.58:1); the softer near-black gives a little of that up, so for the narrow band of
 * fills where neither reaches AA this falls back to pure black, which by the same arithmetic always
 * does. The same rule as web/src/contrast.ts `bestInkOn`, which is what lets the designer's preview
 * promise it shows what the tablet will.
 *
 * The ink has to be chosen FOR the fill because the fill is an admin's colour from a picker: a fixed
 * white measured 2.6:1 on the editor's own Gold preset and 2.7:1 on the violet accent.
 */
fun bestTextOn(fill: Color): Color {
    val onBlack = contrastRatio(fill, InkBlack)
    val onWhite = contrastRatio(fill, Color.White)
    if (maxOf(onBlack, onWhite) >= 4.5f) return if (onBlack >= onWhite) InkBlack else Color.White
    return Color.Black
}
