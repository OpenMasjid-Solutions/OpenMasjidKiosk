// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.openmasjidos.kiosk.GivingState
import org.openmasjidos.kiosk.GivingStep
import org.openmasjidos.kiosk.MonthlyOutcome
import org.openmasjidos.kiosk.TuitionInvoiceUi
import org.openmasjidos.kiosk.R
import org.openmasjidos.kiosk.TuitionFeeQuote
import org.openmasjidos.kiosk.TuitionState
import org.openmasjidos.kiosk.local.Campaign
import org.openmasjidos.kiosk.local.KioskConfig
import org.openmasjidos.kiosk.ui.theme.DangerDark
import org.openmasjidos.kiosk.ui.theme.SuccessDark

/**
 * Resolved per-campaign appearance for the giving screen (computed in [GivingHome]). Lets one bright
 * or dark, accent-tinted look flow through every step without hard-coding colors.
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
 * The full-screen background + campaign tabs are drawn by [GivingHome]; colors come from [style].
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
    onTuitionStart: () -> Unit = {},
    onTuitionStudentCode: (String) -> Unit = {},
    onTuitionIdentify: () -> Unit = {},
    onTuitionConfirmStudent: () -> Unit = {},
    onTuitionRejectStudent: () -> Unit = {},
    onTuitionPayFull: (Boolean) -> Unit = {},
    onTuitionToggleUnit: (String) -> Unit = {},
    onTuitionToggleInvoice: (String) -> Unit = {},
    onTuitionPay: () -> Unit = {},
    /** The parent accepted the tuition + processing-fee total, so the reader may be armed. */
    onTuitionConfirmFee: () -> Unit = {},
    onTuitionPayAmount: (Long, String) -> Unit = { _, _ -> },
    loadImage: suspend (String) -> ImageBitmap? = { null },
    modifier: Modifier = Modifier,
) {
    val currency = config?.currency?.ifBlank { "USD" } ?: "USD"
    val manualOnCard = true // keyed entry is always offered (see KioskViewModel)
    val chargeMinor = displayCharge(giving, campaign, config)
    val isTuition = campaign.type == "tuition"
    when {
        // A `tuition` campaign replaces the amount grid with the Students shell: the resting screen is
        // the Student ID entry (full-screen — it hosts the in-app keyboard), then the "is this your
        // child?" confirmation, then the invoices/pay step. The card/processing/thanks/error steps
        // below are shared with donations.
        isTuition && (giving.step == GivingStep.Amount || giving.step == GivingStep.Idle) ->
            TuitionLookupStep(giving.tuition, campaign, style, onTuitionStart, onTuitionStudentCode, onTuitionIdentify, onCancel, modifier)
        isTuition && giving.step == GivingStep.TuitionConfirm ->
            TuitionConfirmStep(giving.tuition, style, onTuitionConfirmStudent, onTuitionRejectStudent, modifier)
        isTuition && giving.step == GivingStep.TuitionInvoices ->
            TuitionInvoicesStep(giving.tuition, style, onTuitionPayFull, onTuitionToggleUnit, onTuitionToggleInvoice, onTuitionPay, onTuitionPayAmount, onCancel, modifier)
        // Only reached when the school passes Stripe's cut to the payer. It sits between "pay" and the
        // reader being armed, because the parent has to see the total — and whose money the extra is —
        // before they commit to it (§11.4).
        isTuition && giving.step == GivingStep.TuitionFeeConfirm ->
            TuitionFeeStep(giving.feeQuote, style, onTuitionConfirmFee, onCancel, modifier)
        giving.step == GivingStep.Amount || giving.step == GivingStep.Idle ->
            AmountStep(giving, campaign, currency, style, readerConnected, config?.footerText ?: "OpenMasjid Solutions", onSetMonthly, onChooseAmount, loadImage, modifier)
        // Details has its own full-screen scrollable layout (it hosts the in-app keyboard), so it is
        // NOT wrapped in CenteredScene.
        giving.step == GivingStep.Details ->
            DetailsStep(giving, campaign, config, currency, style, onDonorName, onDonorEmail, onSetCoverFees, onSubmitDetails, onCancel, modifier)
        else -> CenteredScene(modifier) {
            when (giving.step) {
                GivingStep.LargeAmount -> LargeAmountStep(giving, config, currency, style, loadImage, onProceedLarge, onCancel)
                GivingStep.Card -> CardStep(chargeMinor, currency, style, readerPrompt, manualOnCard && !isTuition, giving.preparingManual, onEnterManually, onCancel)
                GivingStep.Processing -> ProcessingStep(chargeMinor, currency, style)
                GivingStep.Thanks -> ThanksStep(giving, campaign, currency, chargeMinor, style, onCancel)
                GivingStep.Error -> ErrorStep(giving.error, style, onRetry, onCancel)
                else -> Unit
            }
        }
    }
}

/** Transparent centered column for the form-like steps (GivingHome owns the background).
 *  Scrollable as well as centered: kiosk type is deliberately large, and on a short screen (or in
 *  landscape) a step like the card prompt must be able to scroll rather than clip its buttons. */
@Composable
private fun CenteredScene(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Box(
        modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.widthIn(max = 720.dp).fillMaxWidth().padding(28.dp),
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
            style = MaterialTheme.typography.titleMedium,
            color = style.onSceneMuted,
            textAlign = TextAlign.Center,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        // One-time vs monthly (only when the campaign enabled it, the reader can take it, and one is
        // connected right now — monthly needs a card-present charge).
        if (campaign.monthlyEnabled && readerConnected) {
            Spacer(Modifier.height(16.dp))
            SingleChoiceSegmentedButtonRow(modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth()) {
                SegmentedButton(selected = !giving.monthly, onClick = { onSetMonthly(false) }, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text("One-time", maxLines = 1, overflow = TextOverflow.Ellipsis) }
                SegmentedButton(selected = giving.monthly, onClick = { onSetMonthly(true) }, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text("Monthly", maxLines = 1, overflow = TextOverflow.Ellipsis) }
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

        // A prominent "Choose your own amount" pill (GiveALittle-style) — a faint accent fill + a bold
        // accent outline so it reads as a real, tappable button, not a hairline link.
        if (campaign.allowCustom) {
            Spacer(Modifier.height(18.dp))
            Surface(
                onClick = { showPad = true },
                shape = RoundedCornerShape(50),
                color = style.accent.copy(alpha = 0.14f),
                border = BorderStroke(2.dp, style.accent),
            ) {
                Text(
                    "Choose your own amount",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = style.onScene,
                    modifier = Modifier.padding(horizontal = 44.dp, vertical = 18.dp),
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
                val amountSize = byWidth.coerceAtMost(byHeight).coerceIn(30f, 132f)
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
                Text("Donate", fontSize = 32.sp, fontWeight = FontWeight.Bold, color = style.onAccent)
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
                    modifier = Modifier.weight(1f).height(78.dp),
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
        modifier = Modifier.fillMaxWidth().height(72.dp),
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

// ── Step: optional donor details (uses the IN-APP keyboard, so it rotates with the UI) ────────────
private enum class DetailsField { NAME, EMAIL }

@Composable
private fun DetailsStep(
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
    modifier: Modifier = Modifier,
) {
    val nameOn = giving.monthly || (config?.namePolicy ?: "off") != "off"
    val emailOn = giving.monthly || (config?.emailPolicy ?: "off") != "off"
    val nameReq = giving.monthly || config?.namePolicy == "required"
    val emailReq = giving.monthly || config?.emailPolicy == "required"
    // The field our in-app keyboard edits — NOTHING is selected until the donor taps a field. A
    // keyboard that opens by itself reads as "you must fill this in", and donors were stopping at an
    // optional name/email instead of going straight to Continue. Tapping a field opens it.
    var active by remember { mutableStateOf<DetailsField?>(null) }
    val feeClarify = "This is the Visa / Mastercard / Amex card fee — not a platform fee. OpenMasjid Solutions is free, unlimited, forever."

    Column(
        modifier = modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // Fields + fee + Continue scroll, so they never collide with the keyboard pinned below.
        Column(
            modifier = Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("Your details", style = MaterialTheme.typography.headlineSmall, color = style.onScene)
            Spacer(Modifier.height(6.dp))
            Text(
                if (giving.monthly) "For your monthly giving and receipts." else "For your receipt — optional unless marked required.",
                style = MaterialTheme.typography.bodyMedium,
                color = style.onSceneMuted,
            )
            Spacer(Modifier.height(18.dp))
            if (nameOn) {
                KioskField(if (nameReq) "Name (required)" else "Name (optional)", giving.donorName, active == DetailsField.NAME, style, "Tap here to type") { active = DetailsField.NAME }
                Spacer(Modifier.height(12.dp))
            }
            if (emailOn) {
                KioskField(if (emailReq) "Email (required)" else "Email (optional)", giving.donorEmail, active == DetailsField.EMAIL, style, "Tap here to type") { active = DetailsField.EMAIL }
            }
            // With the keyboard no longer opening by itself, say once how to reach it — and, when both
            // fields are optional, that skipping is fine.
            if (active == null && (nameOn || emailOn)) {
                Spacer(Modifier.height(10.dp))
                Text(
                    if (nameReq || emailReq) "Tap a box above to type." else "Tap a box to type, or just continue.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = style.onSceneMuted,
                    textAlign = TextAlign.Center,
                )
            }
            // Cover-fees: a forced-fee campaign (Zakat / required Tuition) shows a note with no toggle;
            // a Donation with the offer on shows a donor opt-in toggle.
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
            Spacer(Modifier.height(20.dp))
            Button(
                onClick = onSubmit,
                shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(containerColor = style.accent, contentColor = style.onAccent),
                modifier = Modifier.fillMaxWidth().height(72.dp),
            ) { Text("Continue", style = MaterialTheme.typography.titleLarge) }
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onCancel) { Text("Cancel", color = style.onSceneMuted) }
        }
        // The in-app keyboard — ordinary Compose content, so it rotates with the giving screen (the
        // system keyboard would appear sideways over the in-app-rotated UI).
        val a = active
        if (a != null) {
            Spacer(Modifier.height(10.dp))
            KioskKeyboard(
                style = style,
                onKey = { ch -> if (a == DetailsField.NAME) onName(giving.donorName + ch) else onEmail(giving.donorEmail + ch) },
                onBackspace = { if (a == DetailsField.NAME) onName(giving.donorName.dropLast(1)) else onEmail(giving.donorEmail.dropLast(1)) },
                onDone = { if (a == DetailsField.NAME && emailOn) active = DetailsField.EMAIL else onSubmit() },
            )
        }
    }
}

/** A tap-to-edit field display (no system IME — the in-app [KioskKeyboard] drives it). Highlights when
 *  it's the active field, and shows [placeholder] while empty so an untouched field reads as an
 *  invitation rather than a blank the donor must fill. */
@Composable
private fun KioskField(
    label: String,
    value: String,
    active: Boolean,
    style: SceneStyle,
    placeholder: String = "",
    onClick: () -> Unit,
) {
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = style.onSceneMuted)
        Spacer(Modifier.height(6.dp))
        Surface(
            onClick = onClick,
            shape = RoundedCornerShape(14.dp),
            color = style.tile,
            contentColor = style.tileInk,
            // A clearly-visible resting outline (not a hairline) — the box has to look tappable now
            // that no keyboard pops up to point at it.
            border = BorderStroke(if (active) 3.dp else 2.dp, if (active) style.accent else style.tileInk.copy(alpha = 0.35f)),
            modifier = Modifier.fillMaxWidth().height(76.dp),
        ) {
            Box(Modifier.fillMaxSize().padding(horizontal = 18.dp), contentAlignment = Alignment.CenterStart) {
                val empty = value.isEmpty()
                Text(
                    if (empty) placeholder else value,
                    style = MaterialTheme.typography.titleLarge,
                    color = if (empty) style.tileInk.copy(alpha = 0.55f) else style.tileInk,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

// ── Tuition (students/billing) — the tuition tile shell (Student ID → confirm → balance → reader) ─
/** Ceiling for a TYPED tuition amount, mirroring the server's own cap (students.ts MAX_TUITION_CENTS)
 *  so the pad can't offer a charge the server will refuse. Generous — a family clearing a year for
 *  several children — but bounded, because this is a keypad in a foyer. */
private const val TUITION_MAX_MINOR = 2_000_000L
/** Student ID entry — the resting screen for a `tuition` campaign. Full-screen so it can host the
 *  in-app keyboard (which rotates with the UI). Fetches the school label/availability on mount.
 *
 *  Contract v2 (Students 0.39.0 §11.0): one field, no PIN. The ID is the whole credential and the
 *  parent confirms the child's name on the next screen; that confirmation is what catches a mistyped
 *  ID. Nothing typed here is stored or logged — it's cleared when the parent walks away. */
@Composable
private fun TuitionLookupStep(
    tuition: TuitionState?,
    campaign: Campaign,
    style: SceneStyle,
    onStart: () -> Unit,
    onStudentCode: (String) -> Unit,
    onIdentify: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    LaunchedEffect(campaign.id) { onStart() }
    val t = tuition ?: TuitionState()
    // The keyboard waits to be asked for (see DetailsStep) — a parent walking up to a keypad that is
    // already open reads it as a demand rather than an offer.
    var editing by remember(campaign.id) { mutableStateOf(false) }
    Column(
        modifier = modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                t.schoolName.ifBlank { campaign.title.ifBlank { "Tuition" } },
                style = MaterialTheme.typography.displaySmall,
                color = style.onScene,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                t.tagline.ifBlank { "Enter your child's Student ID" },
                style = MaterialTheme.typography.titleMedium,
                color = style.onSceneMuted,
                textAlign = TextAlign.Center,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(22.dp))
            if (!t.available) {
                Text(
                    "Tuition payments aren't available right now. Please ask the office.",
                    color = style.onSceneMuted,
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodyLarge,
                )
            } else {
                KioskField(
                    label = "Student ID",
                    value = t.studentCode,
                    active = editing,
                    style = style,
                    placeholder = "Tap here to type",
                ) { editing = true }
                Spacer(Modifier.height(8.dp))
                Text(
                    "It's on your statement — three letters and four numbers, like YUS1234.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = style.onSceneMuted,
                    textAlign = TextAlign.Center,
                )
                if (t.notFound) {
                    Spacer(Modifier.height(12.dp))
                    Text(
                        "We couldn't find that — please check the Student ID, or ask the office.",
                        color = DangerDark,
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
                    )
                }
                t.error?.let {
                    Spacer(Modifier.height(12.dp))
                    Text(it, color = DangerDark, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
                }
                Spacer(Modifier.height(20.dp))
                Button(
                    onClick = onIdentify,
                    enabled = !t.looking && t.studentCode.isNotBlank(),
                    shape = RoundedCornerShape(16.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = style.accent, contentColor = style.onAccent),
                    modifier = Modifier.fillMaxWidth().height(72.dp),
                ) { Text(if (t.looking) "Checking…" else "Continue", style = MaterialTheme.typography.titleLarge) }
            }
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = onCancel) { Text("Cancel", color = style.onSceneMuted) }
        }
        if (t.available && editing) {
            Spacer(Modifier.height(10.dp))
            KioskKeyboard(
                style = style,
                onKey = { ch -> onStudentCode(t.studentCode + ch) },
                onBackspace = { onStudentCode(t.studentCode.dropLast(1)) },
                onDone = { editing = false; onIdentify() },
                // A Student ID is always capitals (YUS1234). The field already upper-cases whatever
                // arrives; locking the keyboard means the keys SHOW the capitals being typed instead of
                // lower-case letters that quietly change on the way into the box.
                capsLocked = true,
            )
        }
    }
}

/** "Is this your child?" — the confirmation that replaced the PIN (contract v2 §11.0). We show only the
 *  first name + last initial `identify` returned; no balance appears until the parent says yes. */
@Composable
private fun TuitionConfirmStep(
    tuition: TuitionState?,
    style: SceneStyle,
    onConfirm: () -> Unit,
    onReject: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val t = tuition ?: TuitionState()
    // Centered, but scrollable so a short landscape screen can never clip the two buttons.
    Column(
        modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Column(
            modifier = Modifier.widthIn(max = 620.dp).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("Is this your child?", style = MaterialTheme.typography.headlineSmall, color = style.onSceneMuted, textAlign = TextAlign.Center)
            Spacer(Modifier.height(14.dp))
            Text(
                t.identifiedName.ifBlank { "This student" },
                style = MaterialTheme.typography.displaySmall,
                color = style.accent,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            t.error?.let {
                Spacer(Modifier.height(14.dp))
                Text(it, color = DangerDark, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
            }
            Spacer(Modifier.height(28.dp))
            Button(
                onClick = onConfirm,
                enabled = !t.looking,
                shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(containerColor = style.accent, contentColor = style.onAccent),
                modifier = Modifier.fillMaxWidth().height(78.dp),
            ) { Text(if (t.looking) "Checking…" else "Yes, show the balance", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = onReject,
                enabled = !t.looking,
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth().height(68.dp),
            ) { Text("No — try another ID", color = style.onScene, style = MaterialTheme.typography.titleMedium) }
        }
    }
}

/**
 * WHOSE MONEY IS THIS? The itemized total, shown before the reader is armed, when the madrasah has
 * chosen to pass Stripe's processing fee to the payer (students/billing 0.51.0, §11.4).
 *
 * Two things are requirements rather than niceties, and both are here:
 *
 *  1. The fee is its OWN LINE with the total, seen before the parent commits. A total that first
 *     appears on the reader — or on a card statement — is what generates phone calls to the office.
 *  2. The sentence saying the extra is NOT the masjid's. It is what the card networks charge to
 *     accept a card and it goes to the payment processor. A parent who thinks the madrasah added
 *     3% to their child's tuition will say so, to other parents, and they will be wrong.
 *
 * Every figure comes from the server's own reply. This screen does no arithmetic: the total shown is
 * by construction the total the card is asked for.
 *
 * A school that absorbs the fee — almost all of them — never reaches this screen at all.
 */
@Composable
private fun TuitionFeeStep(
    quote: TuitionFeeQuote?,
    style: SceneStyle,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val q = quote ?: return
    Column(
        modifier = modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Column(
            modifier = Modifier.widthIn(max = 620.dp).fillMaxWidth(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                stringResource(R.string.tuition_fee_title),
                style = MaterialTheme.typography.headlineSmall,
                color = style.onSceneMuted,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(22.dp))

            // The three lines, in the order the contract sets them out. Tuition, then the fee, then
            // what the card is actually asked for — emphasised, because it is the number that matters.
            FeeRow(stringResource(R.string.tuition_fee_line_tuition), formatMoney(q.tuitionMinor, q.currency), style, emphasised = false)
            Spacer(Modifier.height(10.dp))
            FeeRow(stringResource(R.string.tuition_fee_line_fee), formatMoney(q.feeMinor, q.currency), style, emphasised = false)
            Spacer(Modifier.height(14.dp))
            HorizontalDivider(color = style.onSceneMuted.copy(alpha = 0.25f))
            Spacer(Modifier.height(14.dp))
            FeeRow(stringResource(R.string.tuition_fee_line_total), formatMoney(q.totalMinor, q.currency), style, emphasised = true)

            Spacer(Modifier.height(22.dp))
            Text(
                stringResource(R.string.tuition_fee_explainer),
                style = MaterialTheme.typography.bodyMedium,
                color = style.onSceneMuted,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(26.dp))
            Button(
                onClick = onConfirm,
                shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(containerColor = style.accent, contentColor = style.onAccent),
                modifier = Modifier.fillMaxWidth().height(78.dp),
            ) {
                Text(
                    stringResource(R.string.tuition_fee_pay, formatMoney(q.totalMinor, q.currency)),
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                )
            }
            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = onCancel,
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth().height(68.dp),
            ) { Text(stringResource(R.string.tuition_fee_cancel), color = style.onScene, style = MaterialTheme.typography.titleMedium) }
        }
    }
}

/** One label/amount row of the fee breakdown. The total is emphasised; the parts are not. */
@Composable
private fun FeeRow(label: String, amount: String, style: SceneStyle, emphasised: Boolean) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = if (emphasised) MaterialTheme.typography.titleLarge else MaterialTheme.typography.titleMedium,
            color = if (emphasised) style.onScene else style.onSceneMuted,
            fontWeight = if (emphasised) FontWeight.Bold else FontWeight.Normal,
            modifier = Modifier.weight(1f, fill = true),
        )
        Spacer(Modifier.width(16.dp))
        Text(
            amount,
            style = if (emphasised) MaterialTheme.typography.headlineSmall else MaterialTheme.typography.titleMedium,
            color = if (emphasised) style.accent else style.onScene,
            fontWeight = if (emphasised) FontWeight.Bold else FontWeight.Normal,
            maxLines = 1,
        )
    }
}

/** The family's account, CHILD BY CHILD: each one's balance or credit and their own bills, which can
 *  be paid whole, line by line ("just the book fee" — contract 0.43.0 §11.0b), or by typing an amount
 *  towards that child — including when nothing is due, which is how a family pays a term up front.
 *
 *  A zero balance is ambiguous on its own, so every account line reads from BOTH figures: what's owed,
 *  what has already been paid ahead, or "nothing due". With one bill per child, one flat list couldn't
 *  say which child was which — two siblings produce two identical "Tuition — Feb 2027" rows. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TuitionInvoicesStep(
    tuition: TuitionState?,
    style: SceneStyle,
    onPayFull: (Boolean) -> Unit,
    onToggleUnit: (String) -> Unit,
    onToggleInvoice: (String) -> Unit,
    onPay: () -> Unit,
    onPayAmount: (Long, String) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val t = tuition ?: TuitionState()
    val currency = t.currency.ifBlank { "USD" }
    // What can be paid is what the BILLS come to, never the household balance: that figure is netted,
    // so one child being in credit hides another child's real, payable bills behind a $0 total.
    val owes = t.dueMinor > 0
    val kids = t.students
    // One child needs no headings — the family line above already names the account. Several do.
    val perChild = kids.size > 1
    // The pad is NEVER where this screen opens, not even with nothing due. A parent came to see the
    // account; a number pad in their face reads as a demand for money they may not owe. Say what the
    // account is first, and let them ask to pay. Non-null = open, and it holds the child's session key
    // ("" = the household).
    var padFor by remember(t.session) { mutableStateOf<String?>(null) }
    val padKey = padFor
    if (padKey != null) {
        val kid = kids.firstOrNull { it.key == padKey && padKey.isNotBlank() }
        TuitionAmountPad(
            t = t,
            style = style,
            forName = kid?.name.orEmpty(),
            balanceMinor = kid?.balanceMinor ?: t.balanceMinor,
            onConfirm = { minor -> onPayAmount(minor, padKey) },
            onBack = { padFor = null },
        )
        return
    }
    val payAmount = if (t.payFull) t.dueMinor else t.selected.sumOf { t.unitAmount(it) }
    Column(
        modifier = modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(t.familyLabel.ifBlank { "Your account" }, style = MaterialTheme.typography.headlineSmall, color = style.onScene, textAlign = TextAlign.Center)
            Spacer(Modifier.height(4.dp))
            // The headline is what's DUE. Credit is shown too when there is any, but it never
            // replaces a real balance — "$180 paid ahead" above three unpaid bills is a lie of
            // omission, and it is exactly what the netted household figure produces.
            TuitionAccountLine(t.dueMinor, t.creditMinor, currency, style, big = true)
            Spacer(Modifier.height(16.dp))
            if (owes) {
                SingleChoiceSegmentedButtonRow(modifier = Modifier.widthIn(max = 480.dp).fillMaxWidth()) {
                    SegmentedButton(selected = t.payFull, onClick = { onPayFull(true) }, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text("Full balance", maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    SegmentedButton(selected = !t.payFull, onClick = { onPayFull(false) }, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text("Choose what to pay", maxLines = 1, overflow = TextOverflow.Ellipsis) }
                }
            }
            Spacer(Modifier.height(14.dp))
            if (kids.isEmpty() && t.invoices.isEmpty()) {
                Text(
                    if (t.allowAdvance) "You can still pay towards the next bill." else "Nothing is currently due — thank you.",
                    color = style.onSceneMuted,
                    style = MaterialTheme.typography.bodyLarge,
                    textAlign = TextAlign.Center,
                )
            }
            kids.forEach { kid ->
                // A child's own bills, which (unlike the household) are never netted against a
                // sibling — so this is both what they owe and what a payment for them can clear.
                val kidDue = kid.invoices.sumOf { it.balanceMinor }.takeIf { it > 0 } ?: kid.balanceMinor
                if (perChild) {
                    Spacer(Modifier.height(10.dp))
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            kid.name.ifBlank { "Other" },
                            style = MaterialTheme.typography.titleLarge,
                            color = style.onScene,
                            fontWeight = FontWeight.Bold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Spacer(Modifier.size(10.dp))
                        TuitionAccountLine(kidDue, kid.creditMinor, currency, style, big = false, compact = true)
                    }
                    Spacer(Modifier.height(6.dp))
                }
                if (kid.invoices.isEmpty()) {
                    Text(
                        if (kid.creditMinor > 0) "Nothing due — this credit comes off the next bill." else "Nothing due.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = style.onSceneMuted,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    )
                } else {
                    kid.invoices.forEach { inv ->
                        TuitionBillCard(
                            inv = inv,
                            t = t,
                            style = style,
                            currency = currency,
                            // Under "Full balance" the bills are a statement, not a checklist.
                            choosing = !t.payFull,
                            // The per-child heading already says whose this is.
                            showStudentName = !perChild,
                            onToggleUnit = onToggleUnit,
                            onToggleInvoice = onToggleInvoice,
                        )
                    }
                }
                // Money for THIS child. With one ledger per child, "add $50" has to say for whom —
                // and a family where one child is clear and another owes is the ordinary case.
                if (perChild && t.allowAdvance && kid.key.isNotBlank()) {
                    Spacer(Modifier.height(6.dp))
                    OutlinedButton(
                        onClick = { padFor = kid.key },
                        shape = RoundedCornerShape(14.dp),
                        modifier = Modifier.fillMaxWidth().height(64.dp),
                    ) {
                        val first = kid.name.substringBefore(' ').ifBlank { "this child" }
                        Text(
                            // "Add money" is the right words for a child who is square; for one who
                            // owes, it's a part payment against a bill they can see above.
                            if (kidDue > 0) "Pay another amount for $first" else "Add money for $first",
                            style = MaterialTheme.typography.titleMedium,
                            color = style.onScene,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            t.error?.let {
                Spacer(Modifier.height(12.dp))
                Text(it, color = DangerDark, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
            }
        }
        Spacer(Modifier.height(12.dp))
        if (owes) {
            Button(
                onClick = onPay,
                enabled = payAmount > 0,
                shape = RoundedCornerShape(16.dp),
                colors = ButtonDefaults.buttonColors(containerColor = style.accent, contentColor = style.onAccent),
                modifier = Modifier.fillMaxWidth().height(78.dp),
            ) { Text(if (payAmount > 0) "Pay ${formatMoney(payAmount, currency)}" else "Choose what to pay", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) }
        }
        // Paying a different amount — part of a balance, or ahead of any bill. With several children
        // this lives per child above instead, because the money has to land on one child's ledger.
        if (t.allowAdvance && !perChild) {
            if (owes) Spacer(Modifier.height(10.dp))
            val payAheadPrimary = !owes
            Button(
                onClick = { padFor = kids.firstOrNull()?.key.orEmpty() },
                shape = RoundedCornerShape(16.dp),
                colors = if (payAheadPrimary) {
                    ButtonDefaults.buttonColors(containerColor = style.accent, contentColor = style.onAccent)
                } else {
                    ButtonDefaults.buttonColors(containerColor = style.tile, contentColor = style.tileInk)
                },
                modifier = Modifier.fillMaxWidth().height(if (payAheadPrimary) 78.dp else 68.dp),
            ) {
                Text(
                    if (owes) "Pay a different amount" else "Pay towards the next bill",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                )
            }
        }
        // A real way out, always. This screen shows a named family's balance, so leaving it must not
        // depend on there being something to pay — with a child in credit there was no Pay button and
        // no advance button, and the only exit was a faint text link at the bottom of a tall screen.
        // It is also the button a parent needs when they have finished and don't want the next person
        // reading their account (the idle timer clears it either way, but not for 45 seconds).
        Spacer(Modifier.height(10.dp))
        OutlinedButton(
            onClick = onCancel,
            shape = RoundedCornerShape(16.dp),
            modifier = Modifier.fillMaxWidth().height(64.dp),
        ) { Text("Leave", style = MaterialTheme.typography.titleMedium, color = style.onScene) }
    }
}

/** What an account actually says, in one line: what's owed, what's already paid ahead, or nothing
 *  due. A bare "0" can't tell "square" from "paid the year already" — once an advance settles its
 *  invoice the credit is the only signal left.
 *
 *  Due and credit CAN both be non-zero here even though Students never reports both on one ledger,
 *  because a household total nets its children against each other: one child $340 ahead and another
 *  $160 behind is $160 due AND $180 of credit. Both get said — leading with the credit alone reads
 *  as "nothing to pay" over a screen full of unpaid bills. */
@Composable
private fun TuitionAccountLine(
    dueMinor: Long,
    creditMinor: Long,
    currency: String,
    style: SceneStyle,
    big: Boolean,
    compact: Boolean = false,
) {
    val text = MaterialTheme.typography.let { if (big) it.headlineMedium else it.titleMedium }
    if (dueMinor > 0) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                if (compact) formatMoney(dueMinor, currency) else "Balance due ${formatMoney(dueMinor, currency)}",
                style = text,
                color = style.accent,
                fontWeight = FontWeight.Bold,
            )
            if (creditMinor > 0 && !compact) {
                Spacer(Modifier.height(4.dp))
                Text(
                    "${formatMoney(creditMinor, currency)} is already paid ahead on this family — it comes off future bills.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = style.onSceneMuted,
                    textAlign = TextAlign.Center,
                )
            }
        }
        return
    }
    if (creditMinor > 0) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                "${formatMoney(creditMinor, currency)} paid ahead",
                style = text,
                color = SuccessDark,
                fontWeight = FontWeight.Bold,
            )
            if (!compact) {
                Spacer(Modifier.height(4.dp))
                Text(
                    "It comes off the next bill automatically.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = style.onSceneMuted,
                    textAlign = TextAlign.Center,
                )
            }
        }
        return
    }
    Text("Nothing due", style = text, color = style.onSceneMuted, fontWeight = FontWeight.Bold)
}

/** One bill. A bill with a single line is one row, exactly as it always was; a bill made of several
 *  (0.43.0 §11.0b) becomes a small statement — the month as the heading, then what it is made of, with
 *  only the lines that still have a balance offered as things to pay. Settled lines stay listed and
 *  marked done, and a credit line (a bursary) is shown as information, never as something payable. */
@Composable
private fun TuitionBillCard(
    inv: TuitionInvoiceUi,
    t: TuitionState,
    style: SceneStyle,
    currency: String,
    choosing: Boolean,
    showStudentName: Boolean,
    onToggleUnit: (String) -> Unit,
    onToggleInvoice: (String) -> Unit,
) {
    val sub = listOfNotNull(
        inv.studentName.takeIf { showStudentName && it.isNotBlank() },
        inv.dueDate.takeIf { it.isNotBlank() }?.let { "Due $it" },
    ).joinToString(" · ")
    // Lines only when EVERY bill on the screen has them — a half-itemized selection can't be expressed
    // on the wire, so the choice is made once for the whole account, not per bill.
    val units = t.unitsOf(inv)
    val lines = if (t.itemized) inv.items else emptyList()
    // One line is not a list. Render it as the single row it has always been — the tick target is the
    // line itself where there is one, so even this simple case is paid the precise way.
    if (lines.size <= 1) {
        val unit = units.firstOrNull() ?: inv.id
        val ticked = choosing && t.selected.contains(unit)
        TuitionRow(
            label = inv.label.ifBlank { "Tuition" },
            sub = sub,
            amount = formatMoney(inv.balanceMinor, currency),
            style = style,
            ticked = ticked,
            tickable = choosing,
            onClick = { onToggleUnit(unit) },
        )
        return
    }
    val allOn = choosing && units.isNotEmpty() && units.all { t.selected.contains(it) }
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = style.tile,
        contentColor = style.tileInk,
        border = BorderStroke(if (allOn) 2.dp else 1.dp, if (allOn) style.accent else style.tileInk.copy(alpha = 0.45f)),
        modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp),
    ) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp)) {
            // The bill's own heading. Tapping it takes (or leaves) the whole month in one go, so
            // "pay everything on this bill" never costs a tap per line.
            Surface(
                onClick = { onToggleInvoice(inv.id) },
                enabled = choosing,
                color = Color.Transparent,
                contentColor = style.tileInk,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(inv.label.ifBlank { "Tuition" }, style = MaterialTheme.typography.titleMedium, color = style.tileInk, fontWeight = FontWeight.Bold)
                        if (sub.isNotBlank()) {
                            Spacer(Modifier.height(2.dp))
                            Text(sub, style = MaterialTheme.typography.bodySmall, color = style.tileInk.copy(alpha = 0.78f))
                        }
                    }
                    Spacer(Modifier.size(10.dp))
                    Text(formatMoney(inv.balanceMinor, currency), style = MaterialTheme.typography.titleMedium, color = style.tileInk, fontWeight = FontWeight.Bold)
                    if (choosing) {
                        Spacer(Modifier.size(10.dp))
                        Text(if (allOn) "✓" else "○", style = MaterialTheme.typography.titleLarge, color = if (allOn) style.accent else style.tileInk.copy(alpha = 0.6f))
                    }
                }
            }
            lines.forEach { item ->
                Spacer(Modifier.height(6.dp))
                val ticked = choosing && t.selected.contains(item.id)
                val note = when {
                    item.isCredit -> "Already applied"
                    !item.payable -> "Paid"
                    else -> ""
                }
                Surface(
                    onClick = { onToggleUnit(item.id) },
                    enabled = choosing && item.payable,
                    shape = RoundedCornerShape(10.dp),
                    color = if (ticked) style.accent.copy(alpha = 0.16f) else Color.Transparent,
                    contentColor = style.tileInk,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                item.label.ifBlank { "Tuition" },
                                style = MaterialTheme.typography.bodyLarge,
                                // A line that can't be paid is stated, not offered.
                                color = if (item.payable) style.tileInk else style.tileInk.copy(alpha = 0.6f),
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (note.isNotBlank()) {
                                Spacer(Modifier.height(2.dp))
                                Text(note, style = MaterialTheme.typography.bodySmall, color = style.tileInk.copy(alpha = 0.6f))
                            }
                        }
                        Spacer(Modifier.size(10.dp))
                        Text(
                            // The line's own price, which for a bursary is the money coming OFF.
                            formatSignedMoney(if (item.payable) item.balanceMinor else item.amountMinor, currency),
                            style = MaterialTheme.typography.bodyLarge,
                            color = if (item.payable) style.tileInk else style.tileInk.copy(alpha = 0.6f),
                            fontWeight = FontWeight.Bold,
                        )
                        if (choosing) {
                            Spacer(Modifier.size(10.dp))
                            Text(
                                if (!item.payable) " " else if (ticked) "✓" else "○",
                                style = MaterialTheme.typography.titleLarge,
                                color = if (ticked) style.accent else style.tileInk.copy(alpha = 0.6f),
                            )
                        }
                    }
                }
            }
        }
    }
}

/** A single tappable bill row — the pre-0.43.0 shape, still exactly right for a one-line bill. */
@Composable
private fun TuitionRow(
    label: String,
    sub: String,
    amount: String,
    style: SceneStyle,
    ticked: Boolean,
    tickable: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        enabled = tickable,
        shape = RoundedCornerShape(12.dp),
        color = style.tile,
        contentColor = style.tileInk,
        border = BorderStroke(if (ticked) 2.dp else 1.dp, if (ticked) style.accent else style.tileInk.copy(alpha = 0.45f)),
        modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp),
    ) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.titleMedium, color = style.tileInk)
                if (sub.isNotBlank()) {
                    Spacer(Modifier.height(2.dp))
                    Text(sub, style = MaterialTheme.typography.bodySmall, color = style.tileInk.copy(alpha = 0.78f))
                }
            }
            Spacer(Modifier.size(10.dp))
            Text(amount, style = MaterialTheme.typography.titleMedium, color = style.tileInk, fontWeight = FontWeight.Bold)
            if (tickable) {
                Spacer(Modifier.size(10.dp))
                Text(if (ticked) "✓" else "○", style = MaterialTheme.typography.titleLarge, color = if (ticked) style.accent else style.tileInk.copy(alpha = 0.6f))
            }
        }
    }
}

/** A number pad for a typed tuition amount — a part payment, or money paid ahead. Floored at the
 *  school's minimum (the server re-checks it), and capped so a slipped finger can't charge a fortune.
 *  [forName] is the child it is for, when the parent picked one; [balanceMinor] is that child's own
 *  balance, so the wording matches whose money this is. */
@Composable
private fun TuitionAmountPad(
    t: TuitionState,
    style: SceneStyle,
    forName: String,
    balanceMinor: Long,
    onConfirm: (Long) -> Unit,
    onBack: () -> Unit,
) {
    val currency = t.currency.ifBlank { "USD" }
    val factor = factorFor(currency)
    var digits by remember(t.session, forName) { mutableStateOf("") }
    val major = digits.toLongOrNull() ?: 0L
    val minor = major * factor
    val min = t.minAmountMinor
    val valid = minor >= min && minor <= TUITION_MAX_MINOR
    val first = forName.substringBefore(' ').takeIf { it.isNotBlank() }
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            when {
                balanceMinor > 0 && first != null -> "How much towards $first's balance?"
                balanceMinor > 0 -> "How much would you like to pay?"
                first != null -> "Pay towards $first's next bill"
                else -> "Pay towards the next bill"
            },
            style = MaterialTheme.typography.headlineSmall,
            color = style.onScene,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(12.dp))
        Text(formatMoney(minor, currency), style = MaterialTheme.typography.displayMedium, color = style.accent, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text(
            if (minor in 1 until min) "Smallest payment is ${formatMoney(min, currency)}" else "Smallest payment ${formatMoney(min, currency)}",
            style = MaterialTheme.typography.bodyMedium,
            color = if (minor in 1 until min) DangerDark else style.onSceneMuted,
            textAlign = TextAlign.Center,
        )
        t.error?.let {
            Spacer(Modifier.height(10.dp))
            Text(it, color = DangerDark, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
        }
        Spacer(Modifier.height(18.dp))
        listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("⌫", "0", "OK")).forEach { row ->
            Row(Modifier.fillMaxWidth().widthIn(max = 520.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { keyLabel ->
                    val isOk = keyLabel == "OK"
                    Button(
                        onClick = {
                            when (keyLabel) {
                                "⌫" -> if (digits.isNotEmpty()) digits = digits.dropLast(1)
                                "OK" -> if (valid) onConfirm(minor)
                                else -> if (digits.length < 7) digits = (digits + keyLabel).trimStart('0')
                            }
                        },
                        enabled = !isOk || valid,
                        shape = RoundedCornerShape(16.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (isOk) style.accent else style.tile,
                            contentColor = if (isOk) style.onAccent else style.tileInk,
                        ),
                        modifier = Modifier.weight(1f).height(78.dp),
                    ) { Text(keyLabel, style = MaterialTheme.typography.titleLarge) }
                }
            }
            Spacer(Modifier.height(12.dp))
        }
        TextButton(onClick = onBack) { Text("Back", color = style.onSceneMuted, style = MaterialTheme.typography.titleMedium) }
    }
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
        // No "swipe": see ReaderManager.onRequestReaderInput. This is only the fallback shown before
        // the reader has said anything; a real swipe request from the reader still comes through.
        text = if (preparing) "Opening secure card entry…" else (readerPrompt?.takeIf { it.isNotBlank() } ?: "Tap or insert your card"),
        style = MaterialTheme.typography.headlineMedium,
        color = style.onScene,
        textAlign = TextAlign.Center,
    )
    if (!preparing) {
        // The single most common failure at the reader is lifting the card too early — a contactless
        // read plus the online authorisation takes a few seconds, and a card pulled away mid-read
        // reads to the donor as "it didn't work". Say the quiet part out loud, in the accent color
        // so it is not mistaken for fine print.
        Spacer(Modifier.height(14.dp))
        Text(
            "Hold your card on the reader for at least 5 seconds",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            color = style.accent,
            textAlign = TextAlign.Center,
        )
    }
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
    // Tuition is a "payment", never a "donation" (contract §5) — different default wording + label.
    val isTuition = campaign.type == "tuition"
    val msg = campaign.thankYouMessage.takeIf { it.isNotBlank() }
        ?: if (isTuition) "JazākAllāhu khayran — your payment was received." else "JazākAllāhu khayran — thank you for your generous donation."
    Text("✓", style = MaterialTheme.typography.displayLarge, color = SuccessDark)
    Spacer(Modifier.height(12.dp))
    if (chargeMinor > 0) {
        Text(
            text = when {
                isTuition -> "You paid ${formatMoney(chargeMinor, currency)}"
                giving.monthly -> "${formatMoney(chargeMinor, currency)} / month"
                else -> "You gave ${formatMoney(chargeMinor, currency)}"
            },
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
        modifier = Modifier.fillMaxWidth().height(72.dp),
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

// ── Money formatting ───────────────────────────────────────────
// formatMoney / symbolFor / decimals / factorFor MOVED to :core (ui/Money.kt), so the kiosk and
// OpenMasjid Mobile Donations cannot render the same masjid's amounts two different ways. They kept
// this exact package, so nothing here needed an import.

/** A SIGNED amount, for the one place a negative can appear: a credit line on a bill (a bursary, a
 *  correction). The minus belongs in front of the symbol — "−$30", not "$-30". Stays here: it is
 *  used by the tuition bill list only, which is a kiosk screen. */
private fun formatSignedMoney(minor: Long, currency: String): String =
    if (minor < 0) "−${formatMoney(-minor, currency)}" else formatMoney(minor, currency)
