// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import android.provider.Settings
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import org.openmasjidos.kiosk.GivingStep
import org.openmasjidos.kiosk.KIOSK_AUTO_RETURN_MS
import org.openmasjidos.kiosk.KioskViewModel
import org.openmasjidos.kiosk.UiState
import org.openmasjidos.kiosk.local.Campaign
import org.openmasjidos.kiosk.readers.ReaderConn
import org.openmasjidos.kiosk.ui.theme.DangerDark
import org.openmasjidos.kiosk.ui.theme.GoldDark
import org.openmasjidos.kiosk.ui.theme.ImageScrim
import org.openmasjidos.kiosk.ui.theme.InkBlack
import org.openmasjidos.kiosk.ui.theme.InkDark
import org.openmasjidos.kiosk.ui.theme.InkMutedDark
import org.openmasjidos.kiosk.ui.theme.PrimaryDark
import org.openmasjidos.kiosk.ui.theme.SceneMid
import org.openmasjidos.kiosk.ui.theme.SuccessDark
import org.openmasjidos.kiosk.ui.theme.SurfaceOverlayDark
import org.openmasjidos.kiosk.ui.theme.SurfaceRaisedDark
import org.openmasjidos.kiosk.ui.theme.bestTextOn
import org.openmasjidos.kiosk.ui.theme.contrastRatio

/**
 * The always-on giving home (§9, redesigned): the kiosk boots straight into the MAIN campaign's
 * giving screen — no "Tap to donate". Extra campaigns appear as browser-style tabs across the top;
 * each carries its own accent + background. Selecting a non-main tab starts a 45s inactivity
 * countdown (a visual-only ring) that returns to the main tab; any touch resets it.
 *
 * The hidden maintenance gesture (10 taps) is detected on the screen BACKGROUND (unconsumed taps),
 * so it works on every step without colliding with the donor's amount buttons or the number pad.
 */
@Composable
fun GivingHome(vm: KioskViewModel, ui: UiState, modifier: Modifier = Modifier) {
    val campaign = ui.activeCampaign
    val accent = accentOf(campaign)
    val primary = primaryOf(campaign)
    // Bright by default: 'auto'/'light' with no background image → a soft PRIMARY-color background
    // (light at top → primary at the bottom) with dark text + white tiles (the "Donate" band is the
    // accent); 'dark' (or a background image) → the calm dark scene + light text.
    val hasImage = !campaign?.backgroundImage.isNullOrBlank()
    val bright = !hasImage && (campaign?.theme ?: "auto") != "dark"
    // The bright background base: the campaign's primary color, or a light tint of the accent when
    // no primary is set (keeps older single-color campaigns looking right).
    val sceneBase = primary ?: lerp(accent, Color.White, 0.35f)
    // A clearly-light primary → a light wash with dark text (the reference look). A darker primary →
    // DEEPEN the whole gradient and use light text, so headings stay readable everywhere (not just the
    // mid-tone). This avoids low-contrast white text over a lightened-toward-white background.
    val lightScene = sceneBase.luminance() > 0.35f
    val style = sceneStyleFor(bright, accent, lightScene, sceneBase)
    val darkBrush = SceneBrush
    val bgBrush = when {
        !bright -> darkBrush
        lightScene -> Brush.verticalGradient(
            colors = listOf(lerp(sceneBase, Color.White, 0.45f), sceneBase, lerp(sceneBase, Color.White, 0.12f)),
        )
        else -> Brush.verticalGradient(
            colors = listOf(lerp(sceneBase, Color.Black, 0.06f), sceneBase, lerp(sceneBase, Color.Black, 0.28f)),
        )
    }
    Box(
        modifier = modifier
            .fillMaxSize()
            // Any touch anywhere counts as activity → resets the return-to-main countdown.
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    vm.onUserActivity()
                }
            }
            // Hidden maintenance gesture: 10 rapid taps anywhere on the screen background (works on
            // EVERY step, not just one screen). requireUnconsumed=true means taps that a button/numpad
            // already handled don't count — so entering a custom amount can't accidentally open it.
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = true)
                    vm.onSecretTap()
                }
            },
    ) {
        CampaignBackground(vm, campaign?.backgroundImage.orEmpty(), bgBrush)
        // Fireworks celebration, drawn behind the thank-you content so the message stays readable.
        // Admin-enabled and only for gifts at/above the configured threshold (0 = every gift).
        val cfg = ui.config
        if (cfg?.celebrateEnabled == true && ui.giving.step == GivingStep.Thanks &&
            ui.giving.amountMinor >= cfg.celebrateThresholdMinor
        ) {
            Fireworks(colors = listOf(accent, sceneBase, Color.White, GoldDark), modifier = Modifier.fillMaxSize())
        }
        Column(Modifier.fillMaxSize()) {
            HomeTopBar(ui, style, onSelect = vm::selectCampaign)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (campaign != null) {
                    // Key the giving subtree to the campaign so any remembered UI state (e.g. the
                    // custom-amount numpad's typed digits / open state) is discarded when the tab changes.
                    key(campaign.id) {
                        GivingScreen(
                            giving = ui.giving,
                            campaign = campaign,
                            config = ui.config,
                            style = style,
                            readerConnected = ui.reader.conn == ReaderConn.Connected,
                            readerPrompt = ui.reader.prompt,
                            onSetMonthly = vm::setMonthly,
                            onSetCoverFees = vm::setCoverFees,
                            onChooseAmount = vm::chooseAmount,
                            onDonorName = vm::setDonorName,
                            onDonorEmail = vm::setDonorEmail,
                            onSubmitDetails = vm::submitDetails,
                            onProceedLarge = vm::proceedDespiteLargeAmount,
                            onRetry = vm::retryGiving,
                            onEnterManually = vm::enterManually,
                            onCancel = vm::cancelGiving,
                            onTuitionStart = vm::onTuitionStart,
                            onTuitionStudentCode = vm::setTuitionStudentCode,
                            onTuitionIdentify = vm::tuitionIdentify,
                            onTuitionConfirmStudent = vm::tuitionConfirmStudent,
                            onTuitionRejectStudent = vm::tuitionRejectStudent,
                            onTuitionPayFull = vm::setTuitionPayFull,
                            onTuitionToggleUnit = vm::toggleTuitionUnit,
                            onTuitionToggleInvoice = vm::toggleTuitionInvoice,
                            onTuitionPay = vm::payTuition,
                            onTuitionConfirmFee = vm::confirmTuitionFee,
                            onTuitionPayAmount = vm::payTuitionAmount,
                            loadImage = { url -> vm.image(url)?.asImageBitmap() },
                        )
                    }
                } else {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("Getting things ready…", color = style.onSceneMuted, style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
        }
        // Card reader firmware update, on the DONOR-FACING screen. The progress bar already existed in
        // maintenance, but that is behind the exit PIN — so from the floor an updating reader looked
        // exactly like a broken one, and the natural reaction (unplug it, power-cycle the tablet) is
        // the one thing that can leave an M2 needing a service visit. Stripe's updates are required,
        // arrive on connect and can take several minutes, so this says plainly what is happening, how
        // far along it is, and not to touch it.
        if (ui.reader.conn == ReaderConn.Updating) {
            ReaderUpdatingBanner(
                percent = ui.reader.updateProgress,
                accent = accent,
                modifier = Modifier.align(Alignment.TopCenter).padding(top = 18.dp),
            )
        }
        // Reader hint: a pulsing NFC symbol + arrows pinned to the reader's side (set per tablet in
        // Admin → Devices). Shown while the donor is at the card step; turns green when it clears. It
        // rides inside RotatedRoot with everything else, so the side (off/left/right/top/bottom) is as
        // the donor sees the rotated screen; a reader above or below it is top/bottom.
        // The green is the SCENE's success colour, not the dark theme's: that light green measured
        // 1.3:1 on the default bright wash, so "it went through" was the part a donor couldn't see.
        NfcReaderHint(
            side = cfg?.nfcSide ?: "off",
            active = ui.giving.step == GivingStep.Card || ui.giving.step == GivingStep.Processing,
            cleared = ui.giving.step == GivingStep.Thanks,
            // The READABLE accent, not the raw one: on the default campaign the raw accent is cyan drawn
            // on a wash of cyan, about 1.3:1 — the one graphic whose whole job is to show a donor where
            // to hold their card was close to invisible. accentInk is the accent where it reads on this
            // scene and the scene's own ink where it doesn't.
            accent = style.accentInk,
            success = style.success,
        )
        // Visual-only countdown ring (no numbers/words): shown while a non-main tab idles OR while a
        // donation is under way (returns to the menu on inactivity).
        (ui.autoReturnStartedMs ?: ui.idleReturnStartedMs)?.let { started ->
            CountdownRing(started, accent, Modifier.align(Alignment.TopEnd).padding(top = 14.dp, end = 16.dp))
        }
        // "Identify" flash — the admin taps Identify in the fleet view and the kiosk lights up so a
        // volunteer can spot the right tablet across a room.
        if (ui.identify) {
            Box(Modifier.fillMaxSize().background(accent.copy(alpha = 0.55f)))
        }
    }
}

@Composable
private fun HomeTopBar(ui: UiState, style: SceneStyle, onSelect: (String) -> Unit) {
    // Tabs appear only when there's more than one campaign; a single-campaign kiosk is chrome-free.
    if (ui.campaigns.size > 1) {
        Column(Modifier.fillMaxWidth().padding(top = 6.dp)) {
            CampaignTabs(ui.campaigns, ui.selectedCampaignId, style, tabMetricsFor(ui.config?.tabSize), onSelect)
        }
    }
}

/** Font + padding for the campaign tabs, chosen by the admin's kiosk-wide "tab size" setting.
 *  `medium` reproduces the original hardcoded values, so unset/legacy configs look unchanged.
 *  Kept in sync with the web picker (campaigns.tsx TAB_SIZES). */
private data class TabMetrics(val font: androidx.compose.ui.unit.TextUnit, val padH: androidx.compose.ui.unit.Dp, val padV: androidx.compose.ui.unit.Dp)

private fun tabMetricsFor(size: String?): TabMetrics = when (size) {
    "small" -> TabMetrics(15.sp, 20.dp, 12.dp)
    "large" -> TabMetrics(22.sp, 34.dp, 22.dp)
    "xlarge" -> TabMetrics(28.sp, 46.dp, 30.dp)
    else -> TabMetrics(16.sp, 26.dp, 16.dp) // "medium" (and any unknown value) → the original size
}

/**
 * "Card reader is updating — 42%", on the giving screen.
 *
 * Deliberately calm and non-alarming: a donor may well be standing there, and this is a normal,
 * temporary state rather than a fault. The percentage is the point — a bar that only spins gives a
 * volunteer no way to tell "nearly done" from "stuck", which is what makes people pull the plug.
 * [percent] is null while the reader hasn't reported progress yet, and then the bar is indeterminate.
 */
@Composable
private fun ReaderUpdatingBanner(percent: Int?, accent: Color, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.widthIn(max = 460.dp),
        shape = RoundedCornerShape(16.dp),
        color = Color.Black.copy(alpha = 0.55f),
        border = BorderStroke(1.dp, accent.copy(alpha = 0.45f)),
    ) {
        Column(
            Modifier
                .padding(horizontal = 20.dp, vertical = 14.dp)
                // A live region (spec §7): the update starts on its own, mid-shift, with nobody having
                // pressed anything — exactly the kind of change a TalkBack user has no other way to
                // hear about.
                .semantics { liveRegion = LiveRegionMode.Polite },
        ) {
            Text(
                text = if (percent != null) "Card reader is updating — $percent%" else "Card reader is updating…",
                style = MaterialTheme.typography.titleSmall,
                color = Color.White,
                // What is SPOKEN stays steady while the percentage ticks. A live region re-reads
                // whatever changes inside it, so reading the number out would talk over a donor at
                // every percent for several minutes — the countdown a live region must never be. The
                // exact figure is still on the progress bar below, for anyone who moves to it.
                modifier = Modifier.semantics { contentDescription = "Card reader is updating" },
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = "This happens automatically and can take a few minutes. Please leave the reader switched on.",
                style = MaterialTheme.typography.bodySmall,
                color = Color.White.copy(alpha = 0.75f),
            )
            Spacer(Modifier.height(10.dp))
            if (percent != null) {
                LinearProgressIndicator(
                    progress = { percent / 100f },
                    modifier = Modifier.fillMaxWidth(),
                    color = accent,
                    trackColor = Color.White.copy(alpha = 0.18f),
                )
            } else {
                LinearProgressIndicator(
                    modifier = Modifier.fillMaxWidth(),
                    color = accent,
                    trackColor = Color.White.copy(alpha = 0.18f),
                )
            }
        }
    }
}

@Composable
private fun CampaignTabs(campaigns: List<Campaign>, selectedId: String, style: SceneStyle, metrics: TabMetrics, onSelect: (String) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(10.dp),
    ) {
        campaigns.forEach { c ->
            val selected = c.id == selectedId
            // Each tab is color-coded by its OWN campaign color (its primary, or accent when unset).
            val tabColor = primaryOf(c) ?: accentOf(c)
            val onTab = bestTextOn(tabColor)
            Surface(
                onClick = { onSelect(c.id) },
                shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = 6.dp, bottomEnd = 6.dp),
                // Selected: a solid fill of the campaign color. Unselected: a soft tint of it with a
                // bold colored outline, so every tab still shows its own color and reads clearly.
                color = if (selected) tabColor else tabColor.copy(alpha = 0.20f),
                border = BorderStroke(2.dp, tabColor),
                shadowElevation = if (selected) 6.dp else 0.dp,
            ) {
                Text(
                    text = c.title.ifBlank { "Appeal" },
                    fontSize = metrics.font,
                    fontWeight = FontWeight.Bold,
                    color = if (selected) onTab else style.onScene,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = metrics.padH, vertical = metrics.padV),
                )
            }
        }
    }
}

@Composable
private fun CampaignBackground(vm: KioskViewModel, url: String, brush: Brush) {
    // Paint the campaign's scene (bright accent gradient, or the dark scene) first, so there's never
    // a blank flash while a background image loads.
    Box(Modifier.fillMaxSize().background(brush)) {
        if (url.isBlank()) return
        val bmp by produceState<ImageBitmap?>(initialValue = null, url) {
            value = runCatching { vm.image(url)?.asImageBitmap() }.getOrNull()
        }
        bmp?.let {
            Image(
                bitmap = it,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
            // Dark scrim so text stays legible over any image (text is light when a bg image is set).
            Box(Modifier.fillMaxSize().background(ImageScrim))
        }
    }
}

/** A small ring that depletes over [KIOSK_AUTO_RETURN_MS]. Purely visual — no text or numbers.
 *
 *  REDUCED MOTION (spec §7), read the same way [Fireworks] reads it: Android's "Remove animations"
 *  sets the system animator scale to 0. Compose's own animations follow that scale by themselves, but
 *  this ring is driven by a hand-written loop the scale never reaches — so without this check it swept
 *  on at about 20 frames a second for a donor who had asked the whole device to hold still. It still
 *  counts down (it is how a volunteer sees the screen is about to reset), in a few visible steps
 *  instead of a continuous sweep. */
@Composable
private fun CountdownRing(startedMs: Long, accent: Color, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val reduceMotion = remember {
        runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        }.getOrDefault(1f) == 0f
    }
    val tickMs = if (reduceMotion) REDUCED_MOTION_TICK_MS else 50L
    var now by remember(startedMs) { mutableStateOf(startedMs) }
    androidx.compose.runtime.LaunchedEffect(startedMs, tickMs) {
        while (true) {
            now = nowMs()
            if (now - startedMs >= KIOSK_AUTO_RETURN_MS) break
            delay(tickMs)
        }
    }
    val remaining = (1f - (now - startedMs).toFloat() / KIOSK_AUTO_RETURN_MS).coerceIn(0f, 1f)
    Canvas(modifier = modifier.size(30.dp)) {
        val stroke = 3.5.dp.toPx()
        drawArc(
            color = Color.White.copy(alpha = 0.22f),
            startAngle = 0f, sweepAngle = 360f, useCenter = false,
            style = Stroke(width = stroke, cap = StrokeCap.Round),
        )
        drawArc(
            color = accent,
            startAngle = -90f, sweepAngle = 360f * remaining, useCenter = false,
            style = Stroke(width = stroke, cap = StrokeCap.Round),
        )
    }
}

private fun nowMs(): Long = System.currentTimeMillis()

/** How often the countdown ring moves with animations turned off: nine steps across the 45 seconds. */
private const val REDUCED_MOTION_TICK_MS = 5_000L

/** Parse a campaign's '#rrggbb' accent, falling back to the kiosk default (cyan). Internal because the
 *  keyed-entry page (KioskRoot → ManualCardWebView) paints the same accent and must get it, and its
 *  ink, by the same rule as the giving screen. */
internal fun accentOf(c: Campaign?): Color {
    val hex = c?.accentColor?.removePrefix("#") ?: return PrimaryDark
    if (hex.length != 6) return PrimaryDark
    val v = hex.toLongOrNull(16) ?: return PrimaryDark
    return Color(0xFF000000L or v)
}

/** Parse a campaign's '#rrggbb' PRIMARY (background) color, or null when unset (caller then derives
 *  a light background from the accent — keeping older single-color campaigns looking right). */
private fun primaryOf(c: Campaign?): Color? {
    val hex = c?.primaryColor?.removePrefix("#")?.takeIf { it.length == 6 } ?: return null
    val v = hex.toLongOrNull(16) ?: return null
    return Color(0xFF000000L or v)
}

// The ink arithmetic — InkBlack (the near-black of big amounts and headings on a bright wash),
// contrastRatio, and bestTextOn (whichever of InkBlack and white reads on a fill, falling back to pure
// black in the narrow band where neither reaches AA) — lives in :core's ui/theme/Color.kt, so the wall
// kiosk and Mobile Donations cannot ink the same campaign colour two ways. It mirrors
// web/src/contrast.ts `bestInkOn` exactly, which is what lets the admin's live preview promise it shows
// what this tablet draws; server/src/ink-contrast.test.ts holds the web half to 4.5:1 on every preset
// and platform accent, and is the only automated check the rule gets, because the Kotlin half cannot
// be built on the maintainer's machine. Change the two together.

/** Error and success TEXT on a bright scene. The theme's DangerDark/SuccessDark are the dark theme's
 *  light red and light green, made to sit on navy, and on the default bright wash they measured 1.9:1
 *  and 1.3:1 — the error line and the "your monthly donation is set up" line were the two a donor could
 *  not read. These are the deep shades a light surface needs (5.7:1 and 4.9:1 on that wash);
 *  [sceneStyleFor] still checks them against the scene actually painted, because a campaign's primary
 *  can be any colour at all. */
private val DangerOnBright = Color(0xFF991B1B)
private val SuccessOnBright = Color(0xFF166534)

/** WCAG AA for body text: the bar an ink has to clear to be used on this screen. */
private const val AA_TEXT = 4.5f

/** [preferred] when it reads at AA on [bg], else [fallback] — an ink already known to read there. */
private fun readableOr(preferred: Color, bg: Color, fallback: Color): Color =
    if (contrastRatio(preferred, bg) >= AA_TEXT) preferred else fallback

/** Resolve the giving-screen color set from the accent + the scene it will actually be painted on.
 *
 *  CONTRAST IS COMPUTED, NOT ASSUMED. Every ink is picked against the real background — [sceneBase]
 *  for a bright scene, the fixed dark gradient otherwise — so a masjid can choose any campaign color,
 *  light or dark, and the words on top stay readable. Secondary text is a *blend* toward the
 *  background rather than a translucent gray: it still reads as secondary, but at a fraction of the
 *  contrast loss (and it composites predictably over a background image's scrim).
 *
 *  THE ACCENT IS A FILL, NOT AN INK. It paints buttons, the "Donate" band, rings and borders. Where it
 *  used to be TEXT as well — the amount being charged, "Hold your card on the reader", the balance due
 *  — that text now takes [SceneStyle.accentInk]: the accent when it reads on the scene, the scene's own
 *  ink when it does not. With no primary set, the bright wash is a tint OF the accent, so the default
 *  cyan was being drawn on a paler cyan at 1.3:1. Error and success text get the same treatment
 *  ([SceneStyle.danger], [SceneStyle.success]) instead of the dark theme's fixed light red and green.
 *
 *  web/src/campaigns.tsx `computeScene` is a line-for-line port of this function and measures the
 *  accent against the same backgrounds (sceneBase here, SceneMid on the dark scene): change one,
 *  change the other.
 *
 *  Bright + light primary: dark ink on a light wash. Bright + dark primary: light ink on a deepened
 *  wash (the gradient in GivingHome is built to match). Either way the tiles are white (slightly
 *  glassy) with big black numbers and an accent "Donate" band. Dark theme: the calm dark scene, light
 *  ink on solid elevated tiles. */
private fun sceneStyleFor(bright: Boolean, accent: Color, lightScene: Boolean, sceneBase: Color): SceneStyle = if (bright) {
    // The ink that wins on the wash the text actually sits on (the gradient's mid stop is sceneBase).
    val ink = bestTextOn(sceneBase)
    val onScene = if (lightScene) InkBlack else ink
    SceneStyle(
        bright = true,
        accent = accent,
        // Text on the solid accent (buttons + the two-tone "Donate" band): whichever ink reads on THAT
        // fill. This was `luminance > 0.4 ? InkLight : white`, defended by a comment saying the 0.4
        // crossover was what gave the default cyan dark text — but cyan sits at L≈0.53 and takes dark
        // ink under either threshold. What the threshold really did was put white on every accent
        // between L≈0.18 and 0.4, exactly where white fails (Emerald, Sunset, Gold and Teal among the
        // editor's own presets, at 2.6–3.7:1), and use the dashboard's navy InkLight rather than a
        // near-black above it, which fell short on Midnight too (4.4:1).
        onAccent = bestTextOn(accent),
        accentInk = readableOr(accent, sceneBase, onScene),
        onScene = onScene,
        // Secondary text (subtitles, hints, Cancel): only a step down from the heading, never a
        // washed-out gray — 12% toward the background keeps the hierarchy and the legibility.
        onSceneMuted = lerp(onScene, sceneBase, 0.12f),
        danger = readableOr(DangerOnBright, sceneBase, onScene),
        success = readableOr(SuccessOnBright, sceneBase, onScene),
        tile = Color.White.copy(alpha = 0.92f), // slight liquid-glass — the background tints through a touch
        tileInk = InkBlack,                      // big BOLD BLACK numbers, like the reference
        // Measured against the white TILE, not the wash: on a dark primary the accent can read on the
        // scene and still vanish on a white tile.
        tileAccentInk = readableOr(accent, Color.White, InkBlack),
        card = Color.White,
    )
} else {
    SceneStyle(
        bright = false,
        accent = accent,
        // Same rule as the bright scene: the ink that reads on the accent fill. (Never simply the
        // scene's ink — InkDark is near-white and would vanish on a pale accent band.)
        onAccent = bestTextOn(accent),
        // Measured against the dark gradient's middle stop, as the web preview measures it: a deep
        // custom accent (Ocean, Royal) is 2–3:1 on navy, and gives way to the scene's near-white.
        accentInk = readableOr(accent, SceneMid, InkDark),
        onScene = InkDark,
        // Brighter than the dashboard's muted ink: that gray is tuned for a monitor an arm's length
        // away, and it greys out on a foyer tablet. Halfway back toward the primary ink.
        onSceneMuted = lerp(InkMutedDark, InkDark, 0.5f),
        // The dark theme's own tokens are right here: they were made for navy (5.9:1 and 6.3:1).
        danger = DangerDark,
        success = SuccessDark,
        tile = SurfaceOverlayDark,
        tileInk = InkDark,
        tileAccentInk = readableOr(accent, SurfaceOverlayDark, InkDark),
        card = SurfaceRaisedDark,
    )
}
