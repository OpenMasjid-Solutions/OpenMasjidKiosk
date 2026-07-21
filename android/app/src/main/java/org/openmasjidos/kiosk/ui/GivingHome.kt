// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.openmasjidos.kiosk.GivingStep
import org.openmasjidos.kiosk.KIOSK_AUTO_RETURN_MS
import org.openmasjidos.kiosk.KioskViewModel
import org.openmasjidos.kiosk.UiState
import org.openmasjidos.kiosk.local.Campaign
import org.openmasjidos.kiosk.readers.ReaderConn
import org.openmasjidos.kiosk.ui.theme.GoldDark
import org.openmasjidos.kiosk.ui.theme.InkDark
import org.openmasjidos.kiosk.ui.theme.InkLight
import org.openmasjidos.kiosk.ui.theme.InkMutedDark
import org.openmasjidos.kiosk.ui.theme.InkMutedLight
import org.openmasjidos.kiosk.ui.theme.PrimaryDark
import org.openmasjidos.kiosk.ui.theme.SurfaceOverlayDark
import org.openmasjidos.kiosk.ui.theme.SurfaceRaisedDark

/**
 * The always-on giving home (§9, redesigned): the kiosk boots straight into the MAIN campaign's
 * giving screen — no "Tap to donate". Extra campaigns appear as browser-style tabs across the top;
 * each carries its own accent + background. Selecting a non-main tab starts a 45s inactivity
 * countdown (a visual-only ring) that returns to the main tab; any touch resets it.
 *
 * The hidden maintenance gesture (7 taps) is detected on the screen BACKGROUND (unconsumed taps),
 * so it works on every step without colliding with the donor's amount buttons or the number pad.
 */
@Composable
fun GivingHome(vm: KioskViewModel, ui: UiState, modifier: Modifier = Modifier) {
    val campaign = ui.activeCampaign
    val accent = accentOf(campaign)
    val primary = primaryOf(campaign)
    // Bright by default: 'auto'/'light' with no background image → a soft PRIMARY-colour background
    // (light at top → primary at the bottom) with dark text + white tiles (the "Donate" band is the
    // accent); 'dark' (or a background image) → the calm dark scene + light text.
    val hasImage = !campaign?.backgroundImage.isNullOrBlank()
    val bright = !hasImage && (campaign?.theme ?: "auto") != "dark"
    // The bright background base: the campaign's primary colour, or a light tint of the accent when
    // no primary is set (keeps older single-colour campaigns looking right).
    val sceneBase = primary ?: lerp(accent, Color.White, 0.35f)
    // A clearly-light primary → a light wash with dark text (the reference look). A darker primary →
    // DEEPEN the whole gradient and use light text, so headings stay readable everywhere (not just the
    // mid-tone). This avoids low-contrast white text over a lightened-toward-white background.
    val lightScene = sceneBase.luminance() > 0.35f
    val style = sceneStyleFor(bright, accent, lightScene)
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
            // Hidden maintenance gesture: 7 rapid taps anywhere on the screen background (works on
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
                            onTuitionName = vm::setTuitionName,
                            onTuitionPin = vm::setTuitionPin,
                            onTuitionLookup = vm::tuitionLookup,
                            onTuitionPayFull = vm::setTuitionPayFull,
                            onTuitionToggleInvoice = vm::toggleTuitionInvoice,
                            onTuitionPay = vm::payTuition,
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
            CampaignTabs(ui.campaigns, ui.selectedCampaignId, style, onSelect)
        }
    }
}

@Composable
private fun CampaignTabs(campaigns: List<Campaign>, selectedId: String, style: SceneStyle, onSelect: (String) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(10.dp),
    ) {
        campaigns.forEach { c ->
            val selected = c.id == selectedId
            // Each tab is colour-coded by its OWN campaign colour (its primary, or accent when unset).
            val tabColor = primaryOf(c) ?: accentOf(c)
            val onTab = bestTextOn(tabColor)
            Surface(
                onClick = { onSelect(c.id) },
                shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = 6.dp, bottomEnd = 6.dp),
                // Selected: a solid fill of the campaign colour. Unselected: a soft tint of it with a
                // bold coloured outline, so every tab still shows its own colour and reads clearly.
                color = if (selected) tabColor else tabColor.copy(alpha = 0.20f),
                border = BorderStroke(2.dp, tabColor),
                shadowElevation = if (selected) 6.dp else 0.dp,
            ) {
                Text(
                    text = c.title.ifBlank { "Appeal" },
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = if (selected) onTab else style.onScene,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 26.dp, vertical = 16.dp),
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
            Box(Modifier.fillMaxSize().background(Color(0xAA020A12)))
        }
    }
}

/** A small ring that depletes over [KIOSK_AUTO_RETURN_MS]. Purely visual — no text or numbers. */
@Composable
private fun CountdownRing(startedMs: Long, accent: Color, modifier: Modifier = Modifier) {
    var now by remember(startedMs) { mutableStateOf(startedMs) }
    androidx.compose.runtime.LaunchedEffect(startedMs) {
        while (true) {
            now = nowMs()
            if (now - startedMs >= KIOSK_AUTO_RETURN_MS) break
            delay(50)
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

/** Parse a campaign's '#rrggbb' accent, falling back to the kiosk default (cyan). */
private fun accentOf(c: Campaign?): Color {
    val hex = c?.accentColor?.removePrefix("#") ?: return PrimaryDark
    if (hex.length != 6) return PrimaryDark
    val v = hex.toLongOrNull(16) ?: return PrimaryDark
    return Color(0xFF000000L or v)
}

/** Parse a campaign's '#rrggbb' PRIMARY (background) colour, or null when unset (caller then derives
 *  a light background from the accent — keeping older single-colour campaigns looking right). */
private fun primaryOf(c: Campaign?): Color? {
    val hex = c?.primaryColor?.removePrefix("#")?.takeIf { it.length == 6 } ?: return null
    val v = hex.toLongOrNull(16) ?: return null
    return Color(0xFF000000L or v)
}

/** A near-black ink for the bright scene — big bold amounts + headings read pure-black on the light
 *  primary background and on the white tiles (matching the reference giving screen). */
private val InkBlack = Color(0xFF0A0F14)

/** Pick whichever of dark ink / white gives the higher contrast on [bg] (a solid fill), so text on a
 *  filled colour is always legible regardless of the colour's brightness. */
private fun bestTextOn(bg: Color): Color {
    val l = bg.luminance()
    val onBlack = (l + 0.05f) / 0.05f       // contrast ratio vs a near-black ink
    val onWhite = 1.05f / (l + 0.05f)        // contrast ratio vs white
    return if (onBlack >= onWhite) InkBlack else Color.White
}

/** Resolve the giving-screen colour set from the accent + whether the scene reads light. Bright +
 *  [lightScene]: dark text on a light PRIMARY background. Bright + dark primary: light text on a
 *  deepened background (the gradient is built to match in GivingHome). Either way the tiles are white
 *  (slightly glassy) with big black numbers and an accent "Donate" band. Dark theme: the calm dark
 *  scene, light text on solid elevated tiles. */
private fun sceneStyleFor(bright: Boolean, accent: Color, lightScene: Boolean): SceneStyle = if (bright) {
    SceneStyle(
        bright = true,
        accent = accent,
        // Text on the solid accent (buttons + the two-tone "Donate" band): a DARK ink on a light accent,
        // white on a dark one. Crossover ≈ 0.4 luminance (well above the 0.179 WCAG break-even) so a
        // mid-bright accent like the default cyan gets readable dark text, not low-contrast white.
        onAccent = if (accent.luminance() > 0.4f) InkLight else Color.White,
        onScene = if (lightScene) InkBlack else Color.White,
        // Secondary text (subtitle/footer): a DARK slate on a light wash so it stays clearly readable,
        // and near-opaque white on a dark wash — not a washed-out grey.
        onSceneMuted = if (lightScene) Color(0xFF2F3742) else Color.White.copy(alpha = 0.9f),
        tile = Color.White.copy(alpha = 0.92f), // slight liquid-glass — the background tints through a touch
        tileInk = InkBlack,                      // big BOLD BLACK numbers, like the reference
        card = Color.White,
        cardBorder = Color.White,
    )
} else {
    SceneStyle(
        bright = false,
        accent = accent,
        // Same contrast rule as the bright scene — dark ink on a light accent (InkDark is near-white
        // and would vanish on a pale accent band), white on a dark accent.
        onAccent = if (accent.luminance() > 0.4f) InkLight else Color.White,
        onScene = InkDark,
        onSceneMuted = InkMutedDark,
        tile = SurfaceOverlayDark,
        tileInk = InkDark,
        card = SurfaceRaisedDark,
        cardBorder = SurfaceOverlayDark,
    )
}
