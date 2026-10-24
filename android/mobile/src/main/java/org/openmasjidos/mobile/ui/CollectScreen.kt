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
import androidx.compose.material3.LocalTextStyle
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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.unit.dp
import org.openmasjidos.kiosk.local.Campaign
import org.openmasjidos.kiosk.ui.decimals
import org.openmasjidos.kiosk.ui.factorFor
import org.openmasjidos.kiosk.ui.formatMoney
import org.openmasjidos.kiosk.ui.typedDecimals
import org.openmasjidos.mobile.Collect
import java.math.RoundingMode
import java.text.DecimalFormatSymbols

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
                    // The server's answer arrives on its own, seconds after the card was read. The
                    // amount and nothing else is announced — this app never holds a donor's name.
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
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
    // Why the last keystroke was refused, if it was. Shown under the field until one is accepted.
    var refused by remember { mutableStateOf<String?>(null) }
    val factor = factorFor(currency)
    val places = decimals(currency)
    // What may be TYPED, which is fewer than `places` where Stripe charges whole units (ISK, UGX) or
    // a last 0 (the dinars): "5.125 KWD" would be refused at the payment, so it is refused here.
    val typedPlaces = typedDecimals(currency)
    // Whether this phone's own keyboard writes decimals with a comma. Read once: it is the device's
    // locale, not anything the server sends.
    val commaIsDecimal = remember { DecimalFormatSymbols.getInstance().decimalSeparator == ',' }

    // Parsed from a MAJOR-unit string the volunteer typed, into the minor units everything else
    // uses. The scale comes from the currency code — never from inspecting formatted output, which
    // is exactly the mistake that made the admin panel refund a hundredth of every partial refund.
    // Decimal arithmetic, not a double: `typed` has at most [places] decimals (normaliseAmount sees
    // to that), so moving the point is exact and there is nothing to round. A comma here is only
    // ever a decimal point — normaliseAmount refuses every comma that could be anything else.
    val typedMinor: Long? = typed.replace(',', '.').toBigDecimalOrNull()
        ?.takeIf { it.signum() > 0 }
        ?.movePointRight(places)
        ?.setScale(0, RoundingMode.HALF_UP)
        ?.toLong()

    // A campaign always carries its own bounds; these only apply before the first config lands. They
    // are one and ten thousand MAJOR units of whatever the currency is. The raw 100 and 1,000,000 they
    // used to be were two-decimal minor units, so they meant a floor of ¥100 and a tenth of a dinar.
    val min = campaign?.customMinMinor ?: factor
    val max = campaign?.customMaxMinor ?: (10_000L * factor)
    // A refused keystroke leaves `typed` at the last string that WAS accepted, which can be a prefix of
    // what the volunteer meant — so while one is showing, nothing can be taken. Without this, typing
    // "1,000" stopped at "1,00" and the button offered "Take £1.00" for a thousand-pound gift.
    val typedOk = typedMinor != null && typedMinor in min..max && refused == null

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
            Text(
                it,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
                // Like the result above, this arrives on its own once the reader or the server answers.
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
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
            // Digits and at most one separator. Checked as it is typed, so the field can never hold
            // something that parses to a different number than it looks like — and a keystroke that
            // would is REFUSED, visibly, rather than quietly dropped. Dropping is what this used to
            // do with a comma, and on a keyboard whose decimal key is ',' that turned "12,50" into
            // "1250": the button offered "Take £1250", which is inside the default ceiling.
            onValueChange = { raw ->
                val clean = normaliseAmount(raw, typedPlaces, commaIsDecimal)
                when {
                    clean == null -> {
                        refused = amountHint(typedPlaces)
                    }
                    clean.length > MAX_AMOUNT_CHARS -> {
                        refused = "That’s more digits than any amount here can have."
                    }
                    else -> {
                        typed = clean
                        refused = null
                    }
                }
            },
            label = { Text("Other amount") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            // An amount is letterless, so under an Arabic or Urdu phone it would otherwise take the
            // page's right-to-left direction and sit against the wrong edge as it is typed.
            textStyle = LocalTextStyle.current.merge(TextStyle(textDirection = TextDirection.Ltr)),
            modifier = Modifier.fillMaxWidth(),
        )
        refused?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                // The field did not change, so without this a screen-reader user would hear nothing
                // at all and could not tell a refused keystroke from one that never registered.
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        if (typed.isNotBlank() && refused == null && !typedOk) {
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


/** The longest "other amount" the field takes — far past any campaign's ceiling already. */
private const val MAX_AMOUNT_CHARS = 12

/**
 * The typed amount made safe to parse, or null when the keystroke has to be refused.
 *
 * ARABIC AND URDU ARE FIRST-CLASS (app UI spec §6), so digits from any script are mapped to 0–9 —
 * "١٢" is twelve, and `toBigDecimal` would otherwise reject it and show a range error for an amount
 * that was perfectly clear. The Arabic decimal separator "٫" is a point.
 *
 * THE COMMA IS THE HARD PART, because it means opposite things: "12,50" is twelve and a half across
 * most of Europe, and "1,000" is a thousand in English. Guessing either way misreports someone, so a
 * comma is accepted as the decimal point only on a phone whose own locale writes decimals with one
 * ([commaIsDecimal]) — anywhere else it is refused AS IT IS TYPED, so "1," never reaches the field —
 * and even then only where it cannot be a thousands separator: it is the ONLY separator, and no more
 * than the currency's decimals follow it — and never exactly three, which is how a thousands group
 * looks, even for a three-decimal currency where "2,500" could be read either way. Everything else is
 * refused. Refusing is always safe; the volunteer sees why and types it with a point, and nothing can
 * be taken while a refusal is showing. The web panel's parser takes the same line (it rejects both).
 *
 * Also refused: a second separator, any separator in a currency with no decimals at all, more
 * decimals than the currency has, and any other character. Spaces are the one thing dropped, because
 * a space changes no amount.
 */
private fun normaliseAmount(raw: String, places: Int, commaIsDecimal: Boolean): String? {
    val out = StringBuilder(raw.length)
    for (ch in raw) {
        when {
            ch == ',' && !commaIsDecimal -> return null
            ch == '.' || ch == ',' -> out.append(ch)
            ch == '٫' -> out.append('.') // ARABIC DECIMAL SEPARATOR
            ch.isDigit() -> out.append('0' + Character.digit(ch, 10))
            ch.isWhitespace() -> Unit
            else -> return null
        }
    }
    val text = out.toString()
    val sepAt = text.indexOfFirst { it == '.' || it == ',' }
    if (sepAt < 0) return text
    if (text.count { it == '.' || it == ',' } > 1) return null
    if (places == 0) return null
    val after = text.length - sepAt - 1
    if (after > places) return null
    if (text[sepAt] == ',' && after == 3) return null
    return text
}

/** What to type instead, for a refused keystroke — with an example in this currency's own shape. */
private fun amountHint(places: Int): String =
    if (places == 0) {
        "Type a whole amount, like 1250 — no commas or points."
    } else {
        "Type it like 1250 or 12.${"5".padEnd(places, '0')} — a point before the decimals, and no commas."
    }
