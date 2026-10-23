// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.math.BigDecimal
import java.text.NumberFormat
import java.util.Currency
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Formatting an amount for a human. Shared by the kiosk and OpenMasjid Mobile Donations.
 *
 * MOVED HERE FROM `GivingScreen.kt` rather than copied, and that is the whole point: two apps
 * belonging to one masjid must never render the same amount two different ways. A volunteer's
 * phone showing "$25" while the wall kiosk shows "25 USD" for the same campaign is the kind of
 * inconsistency nobody files a bug for and everybody notices.
 *
 * The package is deliberately still `org.openmasjidos.kiosk.ui`, matching where these lived, so
 * `:app` needed no import changes at all — a Gradle module's namespace is independent of Kotlin
 * package declarations. Same technique as the rest of the `:core` split.
 *
 * These were `private` in that file; they are public now because they must cross a module
 * boundary. `internal` would not do it — Kotlin's `internal` is module-scoped, so `:app` could not
 * see them.
 *
 * MINOR UNITS THROUGHOUT. Nothing here ever takes or returns a float amount of money, and the
 * scale comes from the currency CODE, never from inspecting formatted output. (The web admin panel
 * learned that the hard way: it derived the scale by formatting zero and looking for a decimal
 * point, and refunded a hundredth of every partial refund. See CHANGELOG 0.12.0.)
 *
 * THE SAME OUTPUT AS THE ADMIN PANEL, for the same reason as the paragraph above, one level up: the
 * designer's live preview (web/src/money.ts) imitates this tablet, and the donor's receipt is
 * formatted on the server. All three now go through the platform's currency formatter — ICU, via
 * `java.text.NumberFormat` here and `Intl.NumberFormat` there — in the masjid's own locale, with the
 * fraction digits taken from OUR table rather than ICU's. So the symbol, its position and the digit
 * grouping are the currency's real conventions ("$1,234,500", "₹12,34,500", "KWD 2.500"), and a
 * whole amount drops its decimals ("$25", not "$25.00"), which server/src/refund-amount.test.ts pins
 * on the web side. Before this the tablet wrote "$2500" while the receipt said "$2,500".
 */

// Stripe's minor units — keep identical to server/src/stripe.ts. UGX is NOT zero-decimal to Stripe:
// like ISK it is a two-decimal value always ending 00, so it is in WHOLE_UNITS_IN_HUNDREDTHS instead.
private val ZERO_DECIMAL = setOf(
    "JPY", "KRW", "VND", "CLP", "XAF", "XOF", "BIF", "DJF", "GNF", "KMF", "MGA", "PYG", "RWF", "VUV", "XPF",
)
private val WHOLE_UNITS_IN_HUNDREDTHS = setOf("ISK", "UGX")
private val THREE_DECIMAL = setOf("BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND")

/** The smallest amount Stripe can charge, in minor units — the server's `minorStep`: 100 for ISK and
 *  UGX (whole units only), 10 for the three-decimal dinars (last digit 0), 1 everywhere else. */
fun minorStep(currency: String): Long = when (currency.uppercase()) {
    in WHOLE_UNITS_IN_HUNDREDTHS -> 100L
    in THREE_DECIMAL -> 10L
    else -> 1L
}

/** How many decimals a person may TYPE: what [minorStep] leaves of [decimals] (none for ISK/UGX,
 *  two for the dinars). */
fun typedDecimals(currency: String): Int = when (minorStep(currency)) {
    100L -> 0
    10L -> 2
    else -> decimals(currency)
}

fun isZeroDecimal(currency: String) = currency.uppercase() in ZERO_DECIMAL

fun decimals(currency: String): Int = when {
    isZeroDecimal(currency) -> 0
    currency.uppercase() in THREE_DECIMAL -> 3
    else -> 2
}

fun factorFor(currency: String): Long = when (decimals(currency)) {
    0 -> 1L
    3 -> 1000L
    else -> 100L
}

/**
 * The locale every amount is written in: English in the masjid's own region ("en-GB", "en-IN"),
 * exactly the tag the admin panel formats with (web/src/locale.ts `localeForCountry`), because the
 * server sends that same tag in the kiosk config. English because every string on the tablet is;
 * only the conventions follow the masjid's country — and never the TABLET's own locale, which is
 * whatever the tablet shipped with and says nothing about where the masjid is.
 *
 * Process-wide, because an amount is formatted from dozens of places (tiles, the pad, the thank-you,
 * the mobile collector) and threading a locale through every one of them is how one gets missed.
 * The core sets it whenever it parses or loads a config — `KioskApi.getConfig` and
 * `DeviceStore.config` — so it is right from the first frame after launch, before any network.
 *
 * SNAPSHOT STATE, not a plain field. [formatMoney] is called during composition, so reading this
 * registers the read and every amount on screen re-renders when the masjid's country changes. A
 * plain volatile var would leave an amount whose own inputs did not change showing the old format
 * until something else happened to recompose it. Writes come from background threads (the config
 * parse runs on Dispatchers.IO), which the global snapshot allows; writing the value it already
 * holds is a no-op, so the config flow re-setting it on every emission costs nothing.
 */
object MoneyFormat {
    var locale: Locale by mutableStateOf(Locale.US)

    /** Set [locale] from the config's BCP-47 tag. A blank or unreadable tag means en-US — what an
     *  older server that sends no tag at all has always rendered — never the tablet's own locale. */
    fun setFromTag(tag: String?) {
        val parsed = tag?.trim()?.takeIf { it.isNotEmpty() }?.let { Locale.forLanguageTag(it) }
        // forLanguageTag never throws: an ill-formed tag comes back with an empty language.
        locale = if (parsed == null || parsed.language.isNullOrEmpty()) Locale.US else parsed
    }
}

/**
 * One formatter per (locale, currency, fraction digits) — building one is not free (ICU loads its
 * data), and a tile grid formats six amounts on every recomposition. `NumberFormat` is not
 * thread-safe, so a cached instance is only ever used inside `synchronized` on itself.
 */
private val formatters = ConcurrentHashMap<String, NumberFormat>()

private fun formatterFor(locale: Locale, code: String, minDigits: Int, maxDigits: Int): NumberFormat =
    formatters.getOrPut("${locale.toLanguageTag()}|$code|$minDigits|$maxDigits") {
        NumberFormat.getCurrencyInstance(locale).apply {
            // Currency FIRST: setting it resets the fraction digits to ICU's idea of the currency, and
            // ICU and Stripe disagree (ICU gives PKR and IQD fewer digits than Stripe uses). Ours win.
            currency = Currency.getInstance(code)
            maximumFractionDigits = maxDigits
            minimumFractionDigits = minDigits
        }
    }

/** Format integer minor units as a human amount: 2500 USD → "$25", 2550 → "$25.50", 2500 KWD → "KWD 2.500". */
fun formatMoney(minor: Long, currency: String): String {
    val code = currency.trim().uppercase()
    val d = decimals(code)
    val f = factorFor(code)
    return try {
        val fmt = formatterFor(MoneyFormat.locale, code, if (minor % f == 0L) 0 else d, d)
        // BigDecimal, never a double: minor units with the currency's scale is the exact amount, so
        // there is nothing for the formatter to round.
        synchronized(fmt) { fmt.format(BigDecimal.valueOf(minor, d)) }
    } catch (e: Exception) {
        // Not an ISO currency this device knows (or a blank one): what this function always wrote.
        legacyFormat(minor, code, d, f)
    }
}

/** The hand-rolled output from before [formatMoney] used the platform formatter — kept only as its
 *  fallback, so a code ICU rejects still reads as an amount rather than an exception. */
private fun legacyFormat(minor: Long, code: String, d: Int, f: Long): String {
    val sym = when (code) {
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
    val body = when {
        d == 0 -> minor.toString()
        minor % f == 0L -> (minor / f).toString()
        else -> BigDecimal.valueOf(minor, d).toPlainString()
    }
    return if (sym.isNotEmpty()) "$sym$body" else "$body $code".trim()
}
