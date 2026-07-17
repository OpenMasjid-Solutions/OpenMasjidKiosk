// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.openmasjidos.kiosk.GivingState
import org.openmasjidos.kiosk.GivingStep
import org.openmasjidos.kiosk.MonthlyOutcome
import org.openmasjidos.kiosk.local.Campaign
import org.openmasjidos.kiosk.local.KioskConfig
import org.openmasjidos.kiosk.ui.theme.DangerDark
import org.openmasjidos.kiosk.ui.theme.SuccessDark
import java.util.Locale

/**
 * Resolved per-campaign appearance for the giving screen (computed in [GivingHome]). Lets one bright
 * or dark, accent-tinted look flow through every step without hard-coding colours.
 */
data class SceneStyle(
    val bright: Boolean,
    val accent: Color,
    val onAccent: Color,       // text on a filled accent button
    val onScene: Color,        // headings on the background
    val onSceneMuted: Color,   // subtitles / secondary
    val tile: Color,           // amount tile fill (glass)
    val tileInk: Color,        // amount text on a tile
    val card: Color,           // the central giving card (liquid glass)
    val cardBorder: Color,     // its hairline border
)

/**
 * The donor-facing giving flow (§9) for one campaign: amount → (details) → card → thank-you.
 * GiveALittle-simple — huge full-screen tiles, warm wording, no jargon. Card data is never touched
 * here; the reader + Stripe SDK handle it, and the server verifies every payment before it counts.
 * The full-screen background + campaign tabs are drawn by [GivingHome]; colours come from [style].
 */
@Composable
fun GivingScreen(
    giving: GivingState,
    campaign: Campaign,
    config: KioskConfig?,
    style: SceneStyle,
    readerConnected: Boolean,
    readerPrompt: String?,
    onSetMonthly: (Boolean) -> Unit,
    onSetCoverFees: (Boolean) -> Unit,
    onChooseAmount: (Long) -> Unit,
    onDonorName: (String) -> Unit,
    onDonorEmail: (String) -> Unit,
    onSubmitDetails: () -> Unit,
    onProceedLarge: () -> Unit,
    onRetry: () -> Unit,
    onEnterManually: () -> Unit,
    onCancel: () -> Unit,
    loadImage: suspend (String) -> ImageBitmap? = { null },
    modifier: Modifier = Modifier,
) {
    val currency = config?.currency?.ifBlank { "USD" } ?: "USD"
    val manualOnCard = true // keyed entry is always offered (see KioskViewModel)
    val chargeMinor = displayCharge(giving, campaign, config)
    when (giving.step) {
        GivingStep.Amount, GivingStep.Idle ->
            AmountStep(giving, campaign, currency, style, readerConnected, config?.footerText ?: "OpenMasjid Solutions", onSetMonthly, onChooseAmount, loadImage, modifier)
        else -> CenteredScene(modifier) {
            when (giving.step) {
                GivingStep.LargeAmount -> LargeAmountStep(giving, config, currency, style, loadImage, onProceedLarge, onCancel)
                GivingStep.Details -> DetailsStep(giving, campaign, config, currency, style, onDonorName, onDonorEmail, onSetCoverFees, onSubmitDetails, onCancel)
                GivingStep.Card -> CardStep(chargeMinor, currency, style, readerPrompt, manualOnCard, giving.preparingManual, onEnterManually, onCancel)
                GivingStep.Processing -> ProcessingStep(chargeMinor, currency, style)
                GivingStep.Thanks -> ThanksStep(giving, campaign, currency, chargeMinor, style, onCancel)
                GivingStep.Error -> ErrorStep(giving.error, style, onRetry, onCancel)
                else -> Unit
            }
        }
    }
}

/** Transparent centred column for the form-like steps (GivingHome owns the background). */
@Composable
private fun CenteredScene(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.widthIn(max = 620.dp).fillMaxWidth().padding(28.dp),
            content = content,
        )
    }
}

// ── Step: choose an amount (FULL-SCREEN: header + a big-tile grid + a small "Other") ──────────
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AmountStep(
    giving: GivingState,
    campaign: Campaign,
    currency: String,
    style: SceneStyle,
    readerConnected: Boolean,
    footerText: String,
    onSetMonthly: (Boolean) -> Unit,
    onChoose: (Long) -> Unit,
    loadImage: suspend (String) -> ImageBitmap?,
    modifier: Modifier = Modifier,
) {
    var showPad by remember { mutableStateOf(false) }
    if (showPad) {
        CenteredScene(modifier) { Numpad(campaign, currency, style, onConfirm = onChoose, onBack = { showPad = false }) }
        return
    }
    BoxWithConstraints(modifier = modifier.fillMaxSize()) {
      // Derive portrait from the MEASURED size — not LocalConfiguration — so it reflects the in-app
      // content rotation (RotatedRoot): the window may be landscape while the rotated UI is portrait.
      val portrait = maxHeight > maxWidth
      Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = 28.dp, vertical = 22.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Campaign logo (if the admin set one) sits above the title.
        val logoUrl = campaign.logo
        if (logoUrl.isNotBlank()) {
            val logo by produceState<ImageBitmap?>(initialValue = null, logoUrl) {
                value = runCatching { loadImage(logoUrl) }.getOrNull()
            }
            logo?.let {
                Image(
                    bitmap = it,
                    contentDescription = null,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.heightIn(max = 96.dp).fillMaxWidth(0.6f).padding(bottom = 10.dp),
                )
            }
        }
        Text(
            text = campaign.title.ifBlank { "Support your masjid" },
            style = MaterialTheme.typography.displayMedium,
            color = style.onScene,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            text = campaign.description.ifBlank { "Choose an amount to give" },
            // A supporting paragraph — kept modest so a fuller description fits without being cut off,
            // and capped at 3 lines so it never squeezes the amount grid on a short screen.
            fontSize = 18.sp,
            lineHeight = 24.sp,
            color = style.onSceneMuted,
            textAlign = TextAlign.Center,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        // One-time vs monthly (only when the campaign enabled it, the reader can take it, and one is
        // connected right now — monthly needs a card-present charge).
        if (campaign.monthlyEnabled && campaign.readerCapable && readerConnected) {
            Spacer(Modifier.height(16.dp))
            SingleChoiceSegmentedButtonRow(modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth()) {
                SegmentedButton(selected = !giving.monthly, onClick = { onSetMonthly(false) }, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text("One-time") }
                SegmentedButton(selected = giving.monthly, onClick = { onSetMonthly(true) }, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text("Monthly") }
            }
        }
        Spacer(Modifier.height(20.dp))

        // The big-tile grid fills the whole screen. In PORTRAIT use 2 wide columns (taller tiles read
        // better on a narrow screen); in landscape use 3 (2 when there are only a few presets).
        val presets = campaign.presetsMinor.take(6).ifEmpty { listOf(500L, 1000L, 2000L, 5000L, 10000L, 25000L) }
        val cols = when {
            portrait -> if (presets.size <= 2) 1 else 2
            presets.size <= 4 -> 2
            else -> 3
        }
        Column(Modifier.fillMaxWidth().weight(1f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            presets.chunked(cols).forEach { row ->
                Row(Modifier.fillMaxWidth().weight(1f), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    row.forEach { minor ->
                        AmountTile(formatMoney(minor, currency), style, Modifier.weight(1f).fillMaxHeight()) { onChoose(minor) }
                    }
                    repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }

        // A small "Choose your own amount" pill (GiveALittle-style), not a full-width button.
        if (campaign.allowCustom) {
            Spacer(Modifier.height(16.dp))
            Surface(
                onClick = { showPad = true },
                shape = RoundedCornerShape(50),
                color = Color.Transparent,
                border = BorderStroke(1.5.dp, style.accent),
            ) {
                Text(
                    "Choose your own amount",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = style.onScene,
                    modifier = Modifier.padding(horizontal = 26.dp, vertical = 12.dp),
                )
            }
        }
        if (footerText.isNotBlank()) {
            Spacer(Modifier.height(10.dp))
            Text(
                footerText,
                style = MaterialTheme.typography.labelMedium,
                color = style.onSceneMuted.copy(alpha = 0.7f),
            )
        }
      }
    }
}

/** A big GiveALittle-style amount tile with a TWO-TONE design: a huge, BOLD BLACK amount on the tile
 *  fill (with a slight liquid-glass sheen), over a solid accent "Donate" footer band. The amount reads
 *  instantly across a room. */
@Composable
private fun AmountTile(label: String, style: SceneStyle, modifier: Modifier = Modifier, onClick: () -> Unit) {
    // A slight glass sheen across the top of the tile — a soft white highlight fading to nothing.
    val sheen = Brush.verticalGradient(
        listOf(Color.White.copy(alpha = if (style.bright) 0.5f else 0.10f), Color.Transparent),
    )
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(24.dp),
        color = style.tile,
        contentColor = style.tileInk,
        // A hairline keeps a white tile defined on the light scene; the dark scene relies on the fill.
        border = if (style.bright) BorderStroke(1.dp, Color.Black.copy(alpha = 0.06f)) else null,
        shadowElevation = if (style.bright) 6.dp else 2.dp,
        modifier = modifier,
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            BoxWithConstraints(
                modifier = Modifier.weight(1f).fillMaxWidth().background(sheen).padding(horizontal = 6.dp),
                contentAlignment = Alignment.Center,
            ) {
                // Size the number to FILL the tile: as large as the available width allows (≈0.62em per
                // glyph for this bold face), capped by the tile height. Big on a 10" landscape wall
                // mount, automatically smaller in portrait / on small tablets — so a money value like
                // "$100" is never clipped or ellipsized to "$10…".
                val glyphs = label.length.coerceAtLeast(2)
                val byWidth = maxWidth.value / (glyphs * 0.62f)
                val byHeight = maxHeight.value * 0.74f
                val amountSize = byWidth.coerceAtMost(byHeight).coerceIn(26f, 120f)
                Text(
                    label,
                    fontSize = amountSize.sp,
                    fontWeight = FontWeight.Black,
                    color = style.tileInk,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                )
            }
            // A tall, prominent accent "Donate" band — the clear call to action on every tile.
            Box(
                modifier = Modifier.fillMaxWidth().background(style.accent).padding(vertical = 18.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("Donate", fontSize = 27.sp, fontWeight = FontWeight.Bold, color = style.onAccent)
            }
        }
    }
}

// ── Step: custom amount numpad ───────────────────────────────────────────────
@Composable
private fun ColumnScope.Numpad(
    campaign: Campaign,
    currency: String,
    style: SceneStyle,
    onConfirm: (Long) -> Unit,
    onBack: () -> Unit,
) {
    val factor = factorFor(currency)
    var digits by remember(campaign.id) { mutableStateOf("") }
    val major = digits.toLongOrNull() ?: 0L
    val minor = major * factor
    val min = campaign.customMinMinor
    val max = campaign.customMaxMinor
    val valid = minor in min..max

    Text("Enter an amount", style = MaterialTheme.typography.headlineSmall, color = style.onScene)
    Spacer(Modifier.height(16.dp))
    Text(if (major == 0L) formatMoney(0, currency) else formatMoney(minor, currency), style = MaterialTheme.typography.displayMedium, color = style.onScene)
    Spacer(Modifier.height(6.dp))
    Text("Between ${formatMoney(min, currency)} and ${formatMoney(max, currency)}", style = MaterialTheme.typography.bodySmall, color = style.onSceneMuted)
    Spacer(Modifier.height(20.dp))

    val rows = listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("⌫", "0", "OK"))
    rows.forEach { r ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            r.forEach { key ->
                val isOk = key == "OK"
                Button(
                    onClick = {
                        when (key) {
                            "⌫" -> if (digits.isNotEmpty()) digits = digits.dropLast(1)
                            "OK" -> if (valid) onConfirm(minor)
                            else -> if (digits.length < 7) digits = (digits + key).trimStart('0').ifEmpty { "" }
                        }
                    },
                    enabled = !isOk || valid,
                    shape = RoundedCornerShape(16.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (isOk) style.accent else style.tile,
                        contentColor = if (isOk) style.onAccent else style.tileInk,
                    ),
                    modifier = Modifier.weight(1f).height(66.dp),
                ) { Text(key, style = MaterialTheme.typography.titleLarge) }
            }
        }
        Spacer(Modifier.height(12.dp))
    }
    TextButton(onClick = onBack) { Text("Back", color = style.onSceneMuted) }
}

// ── Step: large-donation alternative (suggest a cheaper way before the card) ──────────────────
@Composable
private fun ColumnScope.LargeAmountStep(
    giving: GivingState,
    config: KioskConfig?,
    currency: String,
    style: SceneStyle,
    loadImage: suspend (String) -> ImageBitmap?,
    onProceed: () -> Unit,
    onCancel: () -> Unit,
) {
    Text("Before you give", style = MaterialTheme.typography.headlineSmall, color = style.onScene)
    Spacer(Modifier.height(8.dp))
    if (giving.amountMinor > 0) {
        Text(formatMoney(giving.amountMinor, currency), style = MaterialTheme.typography.displaySmall, color = style.accent, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(16.dp))
    }
    val note = config?.largeAmountNote.orEmpty()
    if (note.isNotBlank()) {
        Text(note, style = MaterialTheme.typography.bodyLarge, color = style.onScene, textAlign = TextAlign.Center)
    } else {
        Text(
            "For a larger gift, a bank transfer means more of it reaches the masjid.",
            style = MaterialTheme.typography.bodyLarge,
            color = style.onScene,
            textAlign = TextAlign.Center,
        )
    }
    val img = config?.largeAmountImage.orEmpty()
    if (img.isNotBlank()) {
        val bmp by produceState<ImageBitmap?>(initialValue = null, img) {
            value = runCatching { loadImage(img) }.getOrNull()
        }
        bmp?.let {
            Spacer(Modifier.height(20.dp))
            Surface(shape = RoundedCornerShape(16.dp), color = Color.White) {
                Image(bitmap = it, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.size(240.dp).padding(10.dp))
            }
        }
    }
    Spacer(Modifier.height(24.dp))
    Button(
        onClick = onProceed,
        shape = RoundedCornerShape(16.dp),
        colors = ButtonDefaults.buttonColors(containerColor = style.accent, contentColor = style.onAccent),
        modifier = Modifier.fillMaxWidth().height(60.dp),
    ) { Text("Give ${formatMoney(giving.amountMinor, currency)} by card", style = MaterialTheme.typography.titleLarge) }
    Spacer(Modifier.height(6.dp))
    Text(
        "Card fees are higher on large gifts, but you're welcome to give by card.",
        style = MaterialTheme.typography.bodySmall,
        color = style.onSceneMuted,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(8.dp))
    TextButton(onClick = onCancel) { Text("Cancel", color = style.onSceneMuted) }
}

// ── Step: optional donor details ─────────────────────────────────────────────
@Composable
private fun ColumnScope.DetailsStep(
    giving: GivingState,
    campaign: Campaign,
    config: KioskConfig?,
    currency: String,
    style: SceneStyle,
    onName: (String) -> Unit,
    onEmail: (String) -> Unit,
    onSetCoverFees: (Boolean) -> Unit,
    onSubmit: () -> Unit,
    onCancel: () -> Unit,
) {
    val nameOn = giving.monthly || (config?.namePolicy ?: "off") != "off"
    val emailOn = giving.monthly || (config?.emailPolicy ?: "off") != "off"
    val nameReq = giving.monthly || config?.namePolicy == "required"
    val emailReq = giving.monthly || config?.emailPolicy == "required"
    Text("Your details", style = MaterialTheme.typography.headlineSmall, color = style.onScene)
    Spacer(Modifier.height(6.dp))
    Text(
        if (giving.monthly) "For your monthly giving and receipts." else "For your receipt — optional unless marked required.",
        style = MaterialTheme.typography.bodyMedium,
        color = style.onSceneMuted,
    )
    Spacer(Modifier.height(20.dp))
    if (nameOn) {
        OutlinedTextField(value = giving.donorName, onValueChange = onName, label = { Text(if (nameReq) "Name (required)" else "Name (optional)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(12.dp))
    }
    if (emailOn) {
        OutlinedTextField(
            value = giving.donorEmail,
            onValueChange = onEmail,
            label = { Text(if (emailReq) "Email (required)" else "Email (optional)") },
            singleLine = true,
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth(),
        )
    }
    // Cover-fees lives here, next to name/email, and shows the exact extra it adds. A forced-fee
    // campaign (Zakat, or a Tuition set to require it) covers it with no toggle and a type-specific
    // note; a Donation with the offer on shows a donor opt-in toggle.
    val feeClarify = "This is the Visa / Mastercard / Amex card fee — not a platform fee. OpenMasjid Solutions is free, unlimited, forever."
    if (campaign.forceCoverFees && !giving.monthly) {
        Spacer(Modifier.height(16.dp))
        val extra = feeExtra(giving.amountMinor, config)
        val forcedNote = if (campaign.type == "zakat") {
            "Because this is Zakat, the card fee (+${formatMoney(extra, currency)}) is added so the full Zakat reaches the masjid."
        } else {
            "The card fee (+${formatMoney(extra, currency)}) is added so the masjid receives the full amount."
        }
        Text(forcedNote, style = MaterialTheme.typography.bodyMedium, color = style.onScene, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(4.dp))
        Text(feeClarify, style = MaterialTheme.typography.bodySmall, color = style.onSceneMuted)
    } else if (campaign.coverFees && !giving.monthly) {
        Spacer(Modifier.height(16.dp))
        val extra = feeExtra(giving.amountMinor, config)
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                "Add a little to cover card fees, so the masjid receives the full amount (+${formatMoney(extra, currency)})",
                style = MaterialTheme.typography.bodyMedium,
                color = style.onScene,
                modifier = Modifier.weight(1f).padding(end = 12.dp),
            )
            Switch(checked = giving.coverFees, onCheckedChange = onSetCoverFees, colors = SwitchDefaults.colors(checkedTrackColor = style.accent))
        }
        Spacer(Modifier.height(4.dp))
        Text(feeClarify, style = MaterialTheme.typography.bodySmall, color = style.onSceneMuted)
    }
    giving.error?.let {
        Spacer(Modifier.height(12.dp))
        Text(it, color = DangerDark, style = MaterialTheme.typography.bodyMedium)
    }
    Spacer(Modifier.height(24.dp))
    Button(
        onClick = onSubmit,
        shape = RoundedCornerShape(16.dp),
        colors = ButtonDefaults.buttonColors(containerColor = style.accent, contentColor = style.onAccent),
        modifier = Modifier.fillMaxWidth().height(60.dp),
    ) { Text("Continue", style = MaterialTheme.typography.titleLarge) }
    Spacer(Modifier.height(8.dp))
    TextButton(onClick = onCancel) { Text("Cancel", color = style.onSceneMuted) }
}

// ── Step: collect the card ───────────────────────────────────────────────────
@Composable
private fun ColumnScope.CardStep(
    chargeMinor: Long,
    currency: String,
    style: SceneStyle,
    readerPrompt: String?,
    manualEnabled: Boolean,
    preparing: Boolean,
    onEnterManually: () -> Unit,
    onCancel: () -> Unit,
) {
    Text(formatMoney(chargeMinor, currency), style = MaterialTheme.typography.displayMedium, color = style.accent, fontWeight = FontWeight.Bold)
    Spacer(Modifier.height(20.dp))
    CircularProgressIndicator(color = style.accent)
    Spacer(Modifier.height(20.dp))
    Text(
        // While the keyed-entry PaymentIntent is being created, show a calm "opening" line instead of
        // the reader's tap prompt, so switching from the reader to keyed entry is seamless.
        text = if (preparing) "Opening secure card entry…" else (readerPrompt?.takeIf { it.isNotBlank() } ?: "Tap, insert or swipe your card"),
        style = MaterialTheme.typography.headlineSmall,
        color = style.onScene,
        textAlign = TextAlign.Center,
    )
    if (manualEnabled && !preparing) {
        Spacer(Modifier.height(20.dp))
        Button(
            onClick = onEnterManually,
            shape = RoundedCornerShape(14.dp),
            colors = ButtonDefaults.buttonColors(containerColor = style.accent, contentColor = style.onAccent),
        ) { Text("Enter card details") }
    }
    Spacer(Modifier.height(16.dp))
    OutlinedButton(onClick = onCancel, shape = RoundedCornerShape(14.dp)) { Text("Cancel", color = style.onSceneMuted) }
}

// ── Step: processing (card read; server verifying) ───────────────────────────
@Composable
private fun ColumnScope.ProcessingStep(chargeMinor: Long, currency: String, style: SceneStyle) {
    Text(formatMoney(chargeMinor, currency), style = MaterialTheme.typography.displayMedium, color = style.accent, fontWeight = FontWeight.Bold)
    Spacer(Modifier.height(20.dp))
    CircularProgressIndicator(color = style.accent)
    Spacer(Modifier.height(20.dp))
    Text("Processing your donation…", style = MaterialTheme.typography.headlineSmall, color = style.onScene, textAlign = TextAlign.Center)
}

// ── Step: thank you ──────────────────────────────────────────────────────────
@Composable
private fun ColumnScope.ThanksStep(
    giving: GivingState,
    campaign: Campaign,
    currency: String,
    chargeMinor: Long,
    style: SceneStyle,
    onCancel: () -> Unit,
) {
    val msg = campaign.thankYouMessage.takeIf { it.isNotBlank() }
        ?: "JazākAllāhu khayran — thank you for your generous donation."
    Text("✓", style = MaterialTheme.typography.displayLarge, color = SuccessDark)
    Spacer(Modifier.height(12.dp))
    if (giving.amountMinor > 0) {
        Text(
            text = if (giving.monthly) "${formatMoney(chargeMinor, currency)} / month" else "You gave ${formatMoney(chargeMinor, currency)}",
            style = MaterialTheme.typography.headlineMedium,
            color = style.accent,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(12.dp))
    }
    Text(msg, style = MaterialTheme.typography.headlineSmall, color = style.onScene, textAlign = TextAlign.Center)
    when (giving.monthlyOutcome) {
        MonthlyOutcome.Created -> {
            Spacer(Modifier.height(10.dp))
            Text("Your monthly donation is set up — we'll email your receipts.", style = MaterialTheme.typography.bodyLarge, color = SuccessDark, textAlign = TextAlign.Center)
        }
        MonthlyOutcome.NotSupported -> {
            Spacer(Modifier.height(10.dp))
            Text("We couldn't set up monthly giving with this card, but your gift today went through. Thank you!", style = MaterialTheme.typography.bodyMedium, color = style.onSceneMuted, textAlign = TextAlign.Center)
        }
        MonthlyOutcome.None -> Unit
    }
    Spacer(Modifier.height(28.dp))
    OutlinedButton(onClick = onCancel, shape = RoundedCornerShape(14.dp)) { Text("Done", color = style.onScene) }
}

// ── Step: error ──────────────────────────────────────────────────────────────
@Composable
private fun ColumnScope.ErrorStep(error: String?, style: SceneStyle, onRetry: () -> Unit, onCancel: () -> Unit) {
    Text("Sorry", style = MaterialTheme.typography.displaySmall, color = style.onScene)
    Spacer(Modifier.height(12.dp))
    Text(
        error ?: "That didn’t go through — no charge was made.",
        style = MaterialTheme.typography.bodyLarge,
        color = style.onSceneMuted,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(28.dp))
    Button(
        onClick = onRetry,
        shape = RoundedCornerShape(16.dp),
        colors = ButtonDefaults.buttonColors(containerColor = style.accent, contentColor = style.onAccent),
        modifier = Modifier.fillMaxWidth().height(58.dp),
    ) { Text("Try again", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold) }
    Spacer(Modifier.height(8.dp))
    TextButton(onClick = onCancel) { Text("Not now", color = style.onSceneMuted) }
}

// ── Amount / fee helpers ─────────────────────────────────────────────────────

/** The amount to display/charge. Once the PaymentIntent exists we show the SERVER's authoritative
 *  charge (so the tablet can never display one total while Stripe takes another — e.g. a kiosk whose
 *  Zakat cover-fee config hasn't synced yet). Before then, it's the local estimate: the base grossed
 *  up by the cover-fee when opted in or forced (Zakat), matching the server's grossUpForFees. */
private fun displayCharge(giving: GivingState, campaign: Campaign, config: KioskConfig?): Long {
    if (giving.serverChargeMinor > 0) return giving.serverChargeMinor
    val cover = campaign.coverFees && (giving.coverFees || campaign.forceCoverFees)
    if (!cover || giving.amountMinor <= 0) return giving.amountMinor
    return giving.amountMinor + feeExtra(giving.amountMinor, config)
}

/** The estimated extra a donor adds by covering the card fee (grossed-up total − base). */
private fun feeExtra(baseMinor: Long, config: KioskConfig?): Long {
    if (baseMinor <= 0) return 0
    val bps = config?.feeBps ?: 290
    val fixed = config?.feeFixedMinor ?: 30
    val total = Math.ceil((baseMinor + fixed) / (1.0 - bps / 10000.0)).toLong()
    return maxOf(0L, total - baseMinor)
}

// ── Money formatting ─────────────────────────────────────────────────────────
private val ZERO_DECIMAL = setOf(
    "JPY", "KRW", "VND", "CLP", "XAF", "XOF", "BIF", "DJF", "GNF", "KMF", "MGA", "PYG", "RWF", "UGX", "VUV", "XPF",
)
private val THREE_DECIMAL = setOf("BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND")

private fun isZeroDecimal(currency: String) = currency.uppercase() in ZERO_DECIMAL
private fun decimals(currency: String): Int = when {
    isZeroDecimal(currency) -> 0
    currency.uppercase() in THREE_DECIMAL -> 3
    else -> 2
}
private fun factorFor(currency: String): Long = when (decimals(currency)) {
    0 -> 1L
    3 -> 1000L
    else -> 100L
}

private fun symbolFor(currency: String) = when (currency.uppercase()) {
    "USD", "CAD", "AUD", "NZD" -> "$"
    "GBP" -> "£"
    "EUR" -> "€"
    "PKR" -> "₨"
    "INR" -> "₹"
    "MYR" -> "RM"
    "AED" -> "AED "
    "SAR" -> "SAR "
    else -> ""
}

/** Format integer minor units as a human amount (e.g. 2500 USD → "$25"). */
fun formatMoney(minor: Long, currency: String): String {
    val sym = symbolFor(currency)
    val d = decimals(currency)
    val f = factorFor(currency)
    val body = when {
        d == 0 -> minor.toString()
        minor % f == 0L -> (minor / f).toString()
        else -> String.format(Locale.US, "%.${d}f", minor.toDouble() / f)
    }
    return if (sym.isNotEmpty()) "$sym$body" else "$body ${currency.uppercase()}"
}
