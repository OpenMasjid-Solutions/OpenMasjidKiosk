// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/**
 * Typography for the kiosk.
 *
 * DESIGN.md pairs Inter (body/UI) with Space Grotesk (headings, letter-spacing -0.02em,
 * weight 600). The admin panel now self-hosts both. HERE THEY ARE STILL DEFERRED, deliberately, and
 * the app UI spec's "self-host both" is not being ignored by accident:
 *  - The one property the spec's type rules exist to protect already holds. Roboto, the Android
 *    system face, has tabular digits by default, so an amount does not jitter as it is typed; Inter's
 *    and Space Grotesk's default digits are proportional, so switching faces is the change that would
 *    CREATE the jitter the spec forbids. (Every style below also asks for `tnum` now, so that stays
 *    true whatever face is under it.) Arabic, meanwhile, falls to the system Naskh, not a serif.
 *  - The donor flow is outside the shared design system by construction: OpenMasjidOS
 *    docs/design-system/CONSUMING.md lists "Kiosk's donor flow — Jetpack Compose" among the surfaces
 *    that system does not cover. What the tablet shows a donor is campaign-designed content.
 *  - A new face changes every line's metrics, and this is a fixed wall screen whose tiles, amount
 *    pad and card step are sized to fit exactly. There is no Android SDK on the maintainer's machine
 *    (CI is the only compiler), so the first time anyone could see a clipped tile or a wrapped
 *    "Donate" band would be on a real tablet, after the build had already shipped to the dev channel.
 *    That is a change to make on its own, with a tablet in hand — not folded into a sweep.
 * So we carry over the *shape* of the type scale — heavier, tighter display headings — on the
 * platform sans. No external font is fetched (self-contained, matching the "no CDN" rule).
 *
 * TABULAR FIGURES ON EVERY STYLE (`fontFeatureSettings = "tnum"`), per the spec's §4: every money
 * amount, countdown and counter. It only changes how digits are spaced, so it costs nothing on text
 * with none, and setting it on the whole scale means no amount can miss it by using the "wrong" style
 * — which is how a per-call-site rule always ends up. (Roboto is already tabular; this makes it a
 * promise rather than an accident of the current face.)
 *
 * SIZED FOR A WALL, NOT A PHONE. A donor reads this tablet standing up, from half a meter or
 * more away, often in a hurry — so every step is roughly a third larger than Material's phone
 * defaults, and body copy never drops below 16sp. **Define the whole scale here, including the
 * styles Material would otherwise supply** (displaySmall, headlineMedium/Small, titleMedium/Small,
 * bodySmall, labelMedium/Small): the screens use those too, and leaving them out is how half the
 * kiosk silently stayed at phone sizes. Weights are also a step heavier than Material's, which
 * matters more than size for reading a bright screen across a foyer.
 *
 * Prefer these styles over a hard-coded `fontSize` at a call site, so "make the kiosk bigger"
 * stays a one-file change.
 */
private val DisplayFamily = FontFamily.Default
private val BodyFamily = FontFamily.Default

/** OpenType tabular figures: every digit the same width, so a growing amount or a ticking counter
 *  does not shuffle sideways. See the note above on why it is on every style. */
private const val TABULAR = "tnum"

val SakinaTypography = Typography(
    displayLarge = TextStyle(
        fontFamily = DisplayFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.Bold,
        fontSize = 60.sp,
        lineHeight = 66.sp,
        letterSpacing = (-0.02).em,
    ),
    displayMedium = TextStyle(
        fontFamily = DisplayFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.Bold,
        fontSize = 48.sp,
        lineHeight = 54.sp,
        letterSpacing = (-0.02).em,
    ),
    displaySmall = TextStyle(
        fontFamily = DisplayFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.Bold,
        fontSize = 40.sp,
        lineHeight = 46.sp,
        letterSpacing = (-0.02).em,
    ),
    headlineLarge = TextStyle(
        fontFamily = DisplayFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.SemiBold,
        fontSize = 36.sp,
        lineHeight = 42.sp,
        letterSpacing = (-0.015).em,
    ),
    headlineMedium = TextStyle(
        fontFamily = DisplayFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.SemiBold,
        fontSize = 32.sp,
        lineHeight = 38.sp,
        letterSpacing = (-0.015).em,
    ),
    headlineSmall = TextStyle(
        fontFamily = DisplayFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.SemiBold,
        fontSize = 28.sp,
        lineHeight = 34.sp,
        letterSpacing = (-0.01).em,
    ),
    titleLarge = TextStyle(
        fontFamily = DisplayFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.SemiBold,
        fontSize = 26.sp,
        lineHeight = 32.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = DisplayFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.SemiBold,
        fontSize = 21.sp,
        lineHeight = 27.sp,
    ),
    titleSmall = TextStyle(
        fontFamily = DisplayFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.SemiBold,
        fontSize = 18.sp,
        lineHeight = 24.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = BodyFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.Medium,
        fontSize = 20.sp,
        lineHeight = 28.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = BodyFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.Medium,
        fontSize = 18.sp,
        lineHeight = 25.sp,
    ),
    bodySmall = TextStyle(
        fontFamily = BodyFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.Medium,
        fontSize = 16.sp,
        lineHeight = 22.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = BodyFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.SemiBold,
        fontSize = 19.sp,
        lineHeight = 24.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = BodyFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        lineHeight = 20.sp,
    ),
    labelSmall = TextStyle(
        fontFamily = BodyFamily,
        fontFeatureSettings = TABULAR,
        fontWeight = FontWeight.SemiBold,
        fontSize = 14.sp,
        lineHeight = 18.sp,
    ),
)
