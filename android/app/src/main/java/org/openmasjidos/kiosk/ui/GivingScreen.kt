// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.openmasjidos.kiosk.GivingState
import org.openmasjidos.kiosk.GivingStep
import org.openmasjidos.kiosk.MonthlyOutcome
import org.openmasjidos.kiosk.local.KioskConfig
import org.openmasjidos.kiosk.ui.theme.DangerDark
import org.openmasjidos.kiosk.ui.theme.GoldDark
import org.openmasjidos.kiosk.ui.theme.InkDark
import org.openmasjidos.kiosk.ui.theme.InkMutedDark
import org.openmasjidos.kiosk.ui.theme.SceneEnd
import org.openmasjidos.kiosk.ui.theme.SceneMid
import org.openmasjidos.kiosk.ui.theme.SceneStart
import org.openmasjidos.kiosk.ui.theme.SuccessDark
import java.util.Locale

/**
 * The donor-facing giving flow (§9): amount → (details) → card → thank-you. GiveALittle-simple —
 * huge targets, warm wording, no jargon. Card data is never touched here; the reader + Stripe SDK
 * handle it, and the server verifies every payment before it counts.
 */
@Composable
fun GivingScreen(
    giving: GivingState,
    config: KioskConfig?,
    readerPrompt: String?,
    onSetMonthly: (Boolean) -> Unit,
    onChooseAmount: (Long) -> Unit,
    onDonorName: (String) -> Unit,
    onDonorEmail: (String) -> Unit,
    onSubmitDetails: () -> Unit,
    onRetry: () -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val currency = config?.currency?.ifBlank { "USD" } ?: "USD"
    SceneBox(modifier) {
        when (giving.step) {
            GivingStep.Amount -> AmountStep(giving, config, currency, onSetMonthly, onChooseAmount, onCancel)
            GivingStep.Details -> DetailsStep(giving, config, onDonorName, onDonorEmail, onSubmitDetails, onCancel)
            GivingStep.Card -> CardStep(giving.amountMinor, currency, readerPrompt, onCancel)
            GivingStep.Processing -> ProcessingStep(giving.amountMinor, currency)
            GivingStep.Thanks -> ThanksStep(giving, config, currency, onCancel)
            GivingStep.Error -> ErrorStep(giving.error, onRetry, onCancel)
            GivingStep.Idle -> Unit
        }
    }
}

@Composable
private fun SceneBox(
    modifier: Modifier = Modifier,
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit,
) {
    val scene = Brush.linearGradient(listOf(SceneStart, SceneMid, SceneEnd), Offset(0f, 0f), Offset(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY))
    Box(modifier = modifier.fillMaxSize().background(scene), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.widthIn(max = 620.dp).fillMaxWidth().padding(28.dp),
            content = content,
        )
    }
}

// ── Step: choose an amount ───────────────────────────────────────────────────
@Composable
private fun ColumnScopeAmountHeader(masjid: String?) {
    Text(
        text = masjid?.takeIf { it.isNotBlank() } ?: "Support your masjid",
        style = MaterialTheme.typography.displaySmall,
        color = InkDark,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(6.dp))
    Text("Choose an amount to give", style = MaterialTheme.typography.bodyLarge, color = InkMutedDark)
    Spacer(Modifier.height(24.dp))
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun androidx.compose.foundation.layout.ColumnScope.AmountStep(
    giving: GivingState,
    config: KioskConfig?,
    currency: String,
    onSetMonthly: (Boolean) -> Unit,
    onChoose: (Long) -> Unit,
    onCancel: () -> Unit,
) {
    var showPad by remember { mutableStateOf(false) }
    if (showPad) {
        Numpad(config, currency, onConfirm = onChoose, onBack = { showPad = false })
        return
    }
    ColumnScopeAmountHeader(config?.masjidName)
    // One-time vs monthly (only when the admin enabled monthly giving).
    if (config?.monthlyEnabled == true) {
        SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
            SegmentedButton(
                selected = !giving.monthly,
                onClick = { onSetMonthly(false) },
                shape = SegmentedButtonDefaults.itemShape(0, 2),
            ) { Text("One-time") }
            SegmentedButton(
                selected = giving.monthly,
                onClick = { onSetMonthly(true) },
                shape = SegmentedButtonDefaults.itemShape(1, 2),
            ) { Text("Monthly") }
        }
        if (giving.monthly) {
            Spacer(Modifier.height(8.dp))
            Text(
                "Give this amount automatically every month. We'll ask for your name and email to set it up and send receipts.",
                style = MaterialTheme.typography.bodySmall,
                color = InkMutedDark,
                textAlign = TextAlign.Center,
            )
        }
        Spacer(Modifier.height(18.dp))
    }
    val presets = (config?.presetsMinor ?: emptyList()).ifEmpty { listOf(500L, 1000L, 2000L, 5000L, 10000L, 25000L) }
    // 2-column grid of big tiles.
    presets.chunked(2).forEach { row ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            row.forEach { minor ->
                Button(
                    onClick = { onChoose(minor) },
                    shape = RoundedCornerShape(18.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.55f), contentColor = InkDark),
                    modifier = Modifier.weight(1f).aspectRatio(2.1f),
                ) {
                    Text(formatMoney(minor, currency), style = MaterialTheme.typography.headlineMedium)
                }
            }
            if (row.size == 1) Spacer(Modifier.weight(1f))
        }
        Spacer(Modifier.height(12.dp))
    }
    if (config?.allowCustom != false) {
        Spacer(Modifier.height(4.dp))
        Button(
            onClick = { showPad = true },
            shape = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary),
            modifier = Modifier.fillMaxWidth().height(64.dp),
        ) { Text("Other amount", style = MaterialTheme.typography.titleLarge) }
    }
    Spacer(Modifier.height(16.dp))
    TextButton(onClick = onCancel) { Text("Cancel", color = InkMutedDark) }
}

// ── Step: custom amount numpad ───────────────────────────────────────────────
@Composable
private fun androidx.compose.foundation.layout.ColumnScope.Numpad(
    config: KioskConfig?,
    currency: String,
    onConfirm: (Long) -> Unit,
    onBack: () -> Unit,
) {
    // Whole-currency-unit entry (donors rarely type cents at a kiosk). minor = major * factor.
    val factor = if (isZeroDecimal(currency)) 1L else 100L
    var digits by remember { mutableStateOf("") }
    val major = digits.toLongOrNull() ?: 0L
    val minor = major * factor
    val min = config?.customMinMinor ?: 100L
    val max = config?.customMaxMinor ?: 1_000_000L
    val valid = minor in min..max

    Text("Enter an amount", style = MaterialTheme.typography.headlineSmall, color = InkDark)
    Spacer(Modifier.height(16.dp))
    Text(if (major == 0L) formatMoney(0, currency) else formatMoney(minor, currency), style = MaterialTheme.typography.displayMedium, color = InkDark)
    Spacer(Modifier.height(6.dp))
    Text("Between ${formatMoney(min, currency)} and ${formatMoney(max, currency)}", style = MaterialTheme.typography.bodySmall, color = InkMutedDark)
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
                        containerColor = if (isOk) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface.copy(alpha = 0.5f),
                        contentColor = if (isOk) MaterialTheme.colorScheme.onPrimary else InkDark,
                    ),
                    modifier = Modifier.weight(1f).height(66.dp),
                ) { Text(key, style = MaterialTheme.typography.titleLarge) }
            }
        }
        Spacer(Modifier.height(12.dp))
    }
    TextButton(onClick = onBack) { Text("Back", color = InkMutedDark) }
}

// ── Step: optional donor details ─────────────────────────────────────────────
@Composable
private fun androidx.compose.foundation.layout.ColumnScope.DetailsStep(
    giving: GivingState,
    config: KioskConfig?,
    onName: (String) -> Unit,
    onEmail: (String) -> Unit,
    onSubmit: () -> Unit,
    onCancel: () -> Unit,
) {
    // Monthly always needs a name + email (to create the customer/subscription and send receipts).
    val nameOn = giving.monthly || (config?.namePolicy ?: "off") != "off"
    val emailOn = giving.monthly || (config?.emailPolicy ?: "off") != "off"
    val nameReq = giving.monthly || config?.namePolicy == "required"
    val emailReq = giving.monthly || config?.emailPolicy == "required"
    Text("Your details", style = MaterialTheme.typography.headlineSmall, color = InkDark)
    Spacer(Modifier.height(6.dp))
    Text(
        if (giving.monthly) "For your monthly giving and receipts." else "For your receipt — optional unless marked required.",
        style = MaterialTheme.typography.bodyMedium,
        color = InkMutedDark,
    )
    Spacer(Modifier.height(20.dp))
    if (nameOn) {
        OutlinedTextField(
            value = giving.donorName,
            onValueChange = onName,
            label = { Text(if (nameReq) "Name (required)" else "Name (optional)") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
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
    giving.error?.let {
        Spacer(Modifier.height(12.dp))
        Text(it, color = DangerDark, style = MaterialTheme.typography.bodyMedium)
    }
    Spacer(Modifier.height(24.dp))
    Button(
        onClick = onSubmit,
        shape = RoundedCornerShape(16.dp),
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary),
        modifier = Modifier.fillMaxWidth().height(60.dp),
    ) { Text("Continue", style = MaterialTheme.typography.titleLarge) }
    Spacer(Modifier.height(8.dp))
    TextButton(onClick = onCancel) { Text("Cancel", color = InkMutedDark) }
}

// ── Step: collect the card ───────────────────────────────────────────────────
@Composable
private fun androidx.compose.foundation.layout.ColumnScope.CardStep(
    amountMinor: Long,
    currency: String,
    readerPrompt: String?,
    onCancel: () -> Unit,
) {
    Text(formatMoney(amountMinor, currency), style = MaterialTheme.typography.displayMedium, color = GoldDark)
    Spacer(Modifier.height(20.dp))
    CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
    Spacer(Modifier.height(20.dp))
    Text(
        text = readerPrompt?.takeIf { it.isNotBlank() } ?: "Tap, insert or swipe your card",
        style = MaterialTheme.typography.headlineSmall,
        color = InkDark,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(28.dp))
    OutlinedButton(onClick = onCancel, shape = RoundedCornerShape(14.dp)) { Text("Cancel", color = InkMutedDark) }
}

// ── Step: processing (card read; server verifying) ───────────────────────────
@Composable
private fun androidx.compose.foundation.layout.ColumnScope.ProcessingStep(amountMinor: Long, currency: String) {
    Text(formatMoney(amountMinor, currency), style = MaterialTheme.typography.displayMedium, color = GoldDark)
    Spacer(Modifier.height(20.dp))
    CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
    Spacer(Modifier.height(20.dp))
    Text(
        text = "Processing your donation…",
        style = MaterialTheme.typography.headlineSmall,
        color = InkDark,
        textAlign = TextAlign.Center,
    )
}

// ── Step: thank you ──────────────────────────────────────────────────────────
@Composable
private fun androidx.compose.foundation.layout.ColumnScope.ThanksStep(
    giving: GivingState,
    config: KioskConfig?,
    currency: String,
    onCancel: () -> Unit,
) {
    val msg = config?.thankYouMessage?.takeIf { it.isNotBlank() }
        ?: "JazākAllāhu khayran — thank you for your generous donation."
    Text("✓", style = MaterialTheme.typography.displayLarge, color = SuccessDark)
    Spacer(Modifier.height(12.dp))
    // Concrete acknowledgement of what was given, so a successful tap is unmistakable.
    if (giving.amountMinor > 0) {
        Text(
            text = if (giving.monthly) "${formatMoney(giving.amountMinor, currency)} / month" else "You gave ${formatMoney(giving.amountMinor, currency)}",
            style = MaterialTheme.typography.headlineMedium,
            color = GoldDark,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(12.dp))
    }
    Text(msg, style = MaterialTheme.typography.headlineSmall, color = InkDark, textAlign = TextAlign.Center)
    // Monthly outcome (warm, honest if the card couldn't be set up for recurring giving).
    when (giving.monthlyOutcome) {
        MonthlyOutcome.Created -> {
            Spacer(Modifier.height(10.dp))
            Text(
                "Your monthly donation is set up — we'll email your receipts.",
                style = MaterialTheme.typography.bodyLarge,
                color = SuccessDark,
                textAlign = TextAlign.Center,
            )
        }
        MonthlyOutcome.NotSupported -> {
            Spacer(Modifier.height(10.dp))
            Text(
                "We couldn't set up monthly giving with this card, but your gift today went through. Thank you!",
                style = MaterialTheme.typography.bodyMedium,
                color = InkMutedDark,
                textAlign = TextAlign.Center,
            )
        }
        MonthlyOutcome.None -> Unit
    }
    Spacer(Modifier.height(28.dp))
    OutlinedButton(onClick = onCancel, shape = RoundedCornerShape(14.dp)) { Text("Done", color = InkDark) }
}

// ── Step: error ──────────────────────────────────────────────────────────────
@Composable
private fun androidx.compose.foundation.layout.ColumnScope.ErrorStep(error: String?, onRetry: () -> Unit, onCancel: () -> Unit) {
    Text("Sorry", style = MaterialTheme.typography.displaySmall, color = InkDark)
    Spacer(Modifier.height(12.dp))
    Text(
        error ?: "That didn’t go through — no charge was made.",
        style = MaterialTheme.typography.bodyLarge,
        color = InkMutedDark,
        textAlign = TextAlign.Center,
    )
    Spacer(Modifier.height(28.dp))
    Button(
        onClick = onRetry,
        shape = RoundedCornerShape(16.dp),
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary),
        modifier = Modifier.fillMaxWidth().height(58.dp),
    ) { Text("Try again", style = MaterialTheme.typography.titleLarge) }
    Spacer(Modifier.height(8.dp))
    TextButton(onClick = onCancel) { Text("Not now", color = InkMutedDark) }
}

// ── Money formatting ─────────────────────────────────────────────────────────
private val ZERO_DECIMAL = setOf(
    "JPY", "KRW", "VND", "CLP", "XAF", "XOF", "BIF", "DJF", "GNF", "KMF", "MGA", "PYG", "RWF", "UGX", "VUV", "XPF",
)

private fun isZeroDecimal(currency: String) = currency.uppercase() in ZERO_DECIMAL

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
    val body = if (isZeroDecimal(currency)) {
        minor.toString()
    } else if (minor % 100 == 0L) {
        (minor / 100).toString()
    } else {
        String.format(Locale.US, "%.2f", minor / 100.0)
    }
    return if (sym.isNotEmpty()) "$sym$body" else "$body ${currency.uppercase()}"
}
