// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package com.openmasjid.kiosk.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * Sakīna palette — the native mirror of the OpenMasjidOS design tokens.
 * Values are copied verbatim from docs/DESIGN.md and the platform tokens.css so the
 * Android kiosk reads as part of the dashboard. Dark is the default theme.
 *
 * Keep these in sync with tokens.css if the platform palette changes.
 */

// ---- Dark (DEFAULT) ------------------------------------------------------------------
val SurfaceDark = Color(0xFF030D1A)         // --color-surface
val SurfaceRaisedDark = Color(0xFF0A1828)   // --color-surface-raised
val SurfaceOverlayDark = Color(0xFF0F2040)  // --color-surface-overlay

val PrimaryDark = Color(0xFF22D3EE)         // --color-primary (cyan)
val PrimaryHoverDark = Color(0xFF67E8F9)    // --color-primary-hover
val PrimaryMutedDark = Color(0xFF155E75)    // --color-primary-muted

val GoldDark = Color(0xFFF59E0B)            // --color-accent / --color-gold

val InkDark = Color(0xFFF4F7FB)             // --color-ink
val InkMutedDark = Color(0xFFAEBACD)        // --color-ink-muted
val InkFaintDark = Color(0xFF8593AD)        // --color-ink-faint

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

val PrimaryLight = Color(0xFF0284C7)        // --color-primary
val PrimaryHoverLight = Color(0xFF0369A1)   // --color-primary-hover
val PrimaryMutedLight = Color(0xFFBAE6FD)   // --color-primary-muted

val GoldLight = Color(0xFFD97706)           // --color-accent / --color-gold

val InkLight = Color(0xFF0C4A6E)            // --color-ink
val InkMutedLight = Color(0xFF44515F)       // --color-ink-muted
val InkFaintLight = Color(0xFF647281)       // --color-ink-faint

val OnPrimaryLight = Color(0xFFFFFFFF)      // --color-on-primary
val SuccessLight = Color(0xFF16A34A)        // --color-success
val WarningLight = Color(0xFFD97706)        // --color-warning
val DangerLight = Color(0xFFDC2626)         // --color-danger
