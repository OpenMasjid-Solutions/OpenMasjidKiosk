// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import org.openmasjidos.kiosk.local.Campaign
import org.openmasjidos.kiosk.ui.factorFor
import org.openmasjidos.kiosk.ui.formatMoney
import org.openmasjidos.mobile.Collect

/**
 * Taking a donation at a fundraising event.
 *
 * BUILT FOR REPETITION, which is the whole difference from the kiosk's giving flow. That one is
 * designed for a stranger who walks up to a wall unaided and may never have used it: an attract
 * screen, big tiles, an optional details step, a celebratory thank-you that lingers. This is for a
 * volunteer doing it fifty times in an evening with people waiting. So: no attract screen, presets
 * one tap away, a keyboard for anything else, and a result that clears itself out of the way.
 *
 * Monthly giving is deliberately absent. It needs a name and an email, and nobody fills a form in
 * at a fundraising table — that belongs on the kiosk or the website.
 */
@Composable
fun CollectScreen(
    campaigns: List<Campaign>,
    chosenCampaignId: String,
    currency: String,
    state: Collect,
    readerReady: Boolean,
    onChooseCampaign: (String) -> Unit,
    onTake: (Long) -> Unit,
    onCancel: () -> Unit,
    onReset: () -> Unit,
) {
    val campaign = campaigns.firstOrNull { it.id == chosenCampaignId } ?: campaigns.firstOrNull()

    when (state) {
        is Collect.Idle, is Collect.Failed -> AmountEntry(
            campaigns = campaigns,
            campaign = campaign,
            chosenCampaignId = campaign?.id.orEmpty(),
            currency = currency,
            readerReady = readerReady,
            failure = (state as? Collect.Failed)?.message,
            onChooseCampaign = onChooseCampaign,
            onTake = onTake,
        )

        is Collect.Preparing -> Busy("Starting the payment…")

        is Collect.Tap -> Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(formatMoney(state.amountMinor, currency), style = MaterialTheme.typography.headlineMedium)
                Text(
                    state.prompt ?: "Ask the donor to tap or insert their card on the reader.",
                    style = MaterialTheme.typography.bodyLarge,
                )
                OutlinedButton(onClick = onCancel, modifier = Modifier.fillMaxWidth()) { Text("Cancel") }
            }
        }

        // No cancel button here, on purpose. The card has been read and the server is deciding;
        // there is nothing left to cancel, and offering it would invite someone to walk away at the
        // one moment the outcome is genuinely unknown.
        is Collect.Verifying -> Busy("Confirming with the masjid…")

        is Collect.Done -> Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Thank you", style = MaterialTheme.typography.titleMedium)
                Text(
                    "${formatMoney(state.amountMinor, state.currency)} received",
                    style = MaterialTheme.typography.headlineMedium,
                )
                // A deliberate tap rather than a timer. The volunteer decides when they have
                // finished with this donor, and an auto-reset mid-sentence is how you end up
                // charging the wrong person.
                Button(
                    onClick = onReset,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(52.dp),
                ) { Text("Next donation") }
            }
        }
    }
}

@Composable
private fun Busy(label: String) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(modifier = Modifier.height(22.dp), strokeWidth = 2.dp)
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable
private fun AmountEntry(
    campaigns: List<Campaign>,
    campaign: Campaign?,
    chosenCampaignId: String,
    currency: String,
    readerReady: Boolean,
    failure: String?,
    onChooseCampaign: (String) -> Unit,
    onTake: (Long) -> Unit,
) {
    var typed by remember { mutableStateOf("") }
    val factor = factorFor(currency)

    // Parsed from a MAJOR-unit string the volunteer typed, into the minor units everything else
    // uses. The scale comes from the currency code — never from inspecting formatted output, which
    // is exactly the mistake that made the admin panel refund a hundredth of every partial refund.
    val typedMinor: Long? = typed.trim().toDoubleOrNull()
        ?.takeIf { it > 0 }
        ?.let { Math.round(it * factor) }

    val min = campaign?.customMinMinor ?: 100L
    val max = campaign?.customMaxMinor ?: 1_000_000L
    val typedOk = typedMinor != null && typedMinor in min..max

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (campaigns.size > 1) {
            Text("Fund", style = MaterialTheme.typography.labelLarge)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(campaigns.size) { i ->
                    val c = campaigns[i]
                    FilterChip(
                        selected = c.id == chosenCampaignId,
                        onClick = { onChooseCampaign(c.id) },
                        label = { Text(c.title) },
                    )
                }
            }
        }

        failure?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
        }

        if (!readerReady) {
            Text(
                "Connect a card reader below before taking a donation.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        val presets = campaign?.presetsMinor.orEmpty()
        if (presets.isNotEmpty()) {
            Text("Amount", style = MaterialTheme.typography.labelLarge)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(presets.size) { i ->
                    val p = presets[i]
                    OutlinedButton(onClick = { onTake(p) }, enabled = readerReady) {
                        Text(formatMoney(p, currency))
                    }
                }
            }
        }

        OutlinedTextField(
            value = typed,
            // Digits and at most one separator. Filtering as it is typed means the field can never
            // hold something that parses to a different number than it looks like.
            onValueChange = { raw ->
                val cleaned = raw.filter { ch -> ch.isDigit() || ch == '.' }
                typed = if (cleaned.count { it == '.' } > 1) typed else cleaned.take(12)
            },
            label = { Text("Other amount") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth(),
        )
        if (typed.isNotBlank() && !typedOk) {
            Text(
                "Enter between ${formatMoney(min, currency)} and ${formatMoney(max, currency)}.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        Button(
            onClick = { typedMinor?.let(onTake) },
            enabled = readerReady && typedOk,
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp),
        ) {
            Text(if (typedOk && typedMinor != null) "Take ${formatMoney(typedMinor, currency)}" else "Take payment")
        }
    }
}
