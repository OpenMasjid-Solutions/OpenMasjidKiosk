// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import java.util.Locale

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
 */

private val ZERO_DECIMAL = setOf(
    "JPY", "KRW", "VND", "CLP", "XAF", "XOF", "BIF", "DJF", "GNF", "KMF", "MGA", "PYG", "RWF", "UGX", "VUV", "XPF",
)
private val THREE_DECIMAL = setOf("BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND")

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

fun symbolFor(currency: String) = when (currency.uppercase()) {
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
