// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.openmasjidos.kiosk.KIOSK_AUTO_RETURN_MS
import org.openmasjidos.kiosk.KioskViewModel
import org.openmasjidos.kiosk.UiState
import org.openmasjidos.kiosk.local.Campaign
import org.openmasjidos.kiosk.ui.theme.InkDark
import org.openmasjidos.kiosk.ui.theme.InkMutedDark
import org.openmasjidos.kiosk.ui.theme.PrimaryDark

/**
 * The always-on giving home (§9, redesigned): the kiosk boots straight into the MAIN campaign's
 * giving screen — no "Tap to donate". Extra campaigns appear as browser-style tabs across the top;
 * each carries its own accent + background. Selecting a non-main tab starts a 45s inactivity
 * countdown (a visual-only ring) that returns to the main tab; any touch resets it.
 *
 * The hidden maintenance gesture (7 taps) lives on the top header strip so it never collides with
 * the donor's amount buttons.
 */
@Composable
fun GivingHome(vm: KioskViewModel, ui: UiState, modifier: Modifier = Modifier) {
    val campaign = ui.activeCampaign
    val accent = accentOf(campaign)
    Box(
        modifier = modifier
            .fillMaxSize()
            // Any touch anywhere counts as activity → resets the return-to-main countdown.
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    vm.onUserActivity()
                }
            },
    ) {
        CampaignBackground(vm, campaign?.backgroundImage.orEmpty())
        Column(Modifier.fillMaxSize()) {
            HomeTopBar(ui, onSelect = vm::selectCampaign, onSecretTap = vm::onSecretTap)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (campaign != null) {
                    GivingScreen(
                        giving = ui.giving,
                        campaign = campaign,
                        config = ui.config,
                        accent = accent,
                        readerPrompt = ui.reader.prompt,
                        onSetMonthly = vm::setMonthly,
                        onSetCoverFees = vm::setCoverFees,
                        onChooseAmount = vm::chooseAmount,
                        onDonorName = vm::setDonorName,
                        onDonorEmail = vm::setDonorEmail,
                        onSubmitDetails = vm::submitDetails,
                        onRetry = vm::retryGiving,
                        onEnterManually = vm::enterManually,
                        onCancel = vm::cancelGiving,
                    )
                } else {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text("Getting things ready…", color = InkMutedDark, style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
        }
        // Visual-only return-to-main countdown (no numbers/words), shown only while a non-main tab idles.
        ui.autoReturnStartedMs?.let { started ->
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
private fun HomeTopBar(ui: UiState, onSelect: (String) -> Unit, onSecretTap: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 6.dp)) {
        val masjid = ui.config?.masjidName?.takeIf { it.isNotBlank() }
        // The masjid-name strip doubles as the hidden 7-tap maintenance zone (never a donor control).
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 44.dp)
                .pointerInput(Unit) { detectTapGestures(onTap = { onSecretTap() }) },
            contentAlignment = Alignment.Center,
        ) {
            if (masjid != null) {
                Text(masjid, style = MaterialTheme.typography.titleMedium, color = InkMutedDark, maxLines = 1, overflow = TextOverflow.Ellipsis)
            } else {
                Spacer(Modifier.heightIn(min = 44.dp))
            }
        }
        if (ui.campaigns.size > 1) {
            Spacer(Modifier.heightIn(min = 6.dp))
            CampaignTabs(ui.campaigns, ui.selectedCampaignId, onSelect)
        }
    }
}

@Composable
private fun CampaignTabs(campaigns: List<Campaign>, selectedId: String, onSelect: (String) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(8.dp),
    ) {
        campaigns.forEach { c ->
            val selected = c.id == selectedId
            val acc = accentOf(c)
            Surface(
                onClick = { onSelect(c.id) },
                shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomStart = 4.dp, bottomEnd = 4.dp),
                color = if (selected) acc.copy(alpha = 0.24f) else Color.White.copy(alpha = 0.06f),
                border = if (selected) BorderStroke(1.5.dp, acc) else null,
            ) {
                Text(
                    text = c.title.ifBlank { "Appeal" },
                    style = MaterialTheme.typography.titleSmall,
                    color = if (selected) InkDark else InkMutedDark,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 18.dp, vertical = 11.dp),
                )
            }
        }
    }
}

@Composable
private fun CampaignBackground(vm: KioskViewModel, url: String) {
    // Always paint the default scene first (so there's never a blank flash while an image loads).
    Box(Modifier.fillMaxSize().background(SceneBrush)) {
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
            // Dark scrim so the (near-white) giving text stays legible over any image.
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
