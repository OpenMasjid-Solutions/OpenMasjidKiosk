// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.local

/**
 * Plain data models shared across the networking, storage and UI layers.
 * Kept deliberately small — later slices (reader, giving flow) extend the config.
 */

/**
 * Everything the tablet needs to talk securely to its server after pairing.
 * Present in full only once a device has been paired; otherwise the store emits null.
 *
 * [certSha256] is the SHA-256 (lowercase hex, no separators) of the server's leaf
 * certificate captured on the FIRST pair (trust-on-first-use). Every subsequent call is
 * pinned to exactly this fingerprint.
 */
data class PairingRecord(
    val serverUrl: String,
    val deviceToken: String,
    val deviceId: String,
    val certSha256: String,
)

/**
 * One giving campaign (an "appeal") the kiosk shows as a browser-style tab. Each has its own
 * amounts, colour, background, thank-you and monthly/cover-fees options — designed in the admin
 * panel. Exactly one is the [isMain] campaign (the always-present first tab the kiosk idles on).
 *
 * [readerCapable] is computed by the server: false means this campaign settles to a DIFFERENT
 * Stripe account than the reader is bound to, so it must be taken by keyed (typed) card entry.
 */
data class Campaign(
    val id: String,
    val title: String,
    /** Campaign type: 'donation' | 'zakat' | 'tuition'. Drives the card-fee wording (the actual fee
     *  rule is already resolved server-side into coverFees/forceCoverFees). */
    val type: String = "donation",
    val description: String = "",
    /** '#rrggbb' background colour for this tab, or '' to inherit. Drives the giving-screen gradient. */
    val primaryColor: String = "",
    /** '#rrggbb' or '' to inherit the kiosk default accent. Drives the "Donate" band + buttons. */
    val accentColor: String = "",
    /** Full-screen background image URL ('/uploads/…' or 'https://…') or '' for the default scene. */
    val backgroundImage: String = "",
    val coverImage: String = "",
    val logo: String = "",
    val presetsMinor: List<Long> = emptyList(),
    val allowCustom: Boolean = true,
    val customMinMinor: Long = 100,
    val customMaxMinor: Long = 1_000_000,
    val monthlyEnabled: Boolean = false,
    val coverFees: Boolean = false,
    /** Zakat-only: the card fee is ALWAYS added and the donor is told it's required because this is
     *  Zakat (the full Zakat must reach the masjid). Implies [coverFees]. */
    val forceCoverFees: Boolean = false,
    /** '' inherits the global default thank-you. */
    val thankYouMessage: String = "",
    /** Kiosk appearance for this tab: 'auto' (bright by default), 'light', or 'dark'. */
    val theme: String = "auto",
    val isMain: Boolean = false,
    val readerCapable: Boolean = true,
)

/**
 * The versioned config pushed by the server (`GET /api/kiosk/config`): the exit PIN, currency,
 * Terminal location, masjid name, the GLOBAL giving policy (manual entry, name/email prompts, the
 * cover-fee estimate), and the ordered list of [campaigns] the kiosk shows as tabs (main first).
 */
data class KioskConfig(
    val version: Int,
    val pinHash: String,          // scrypt hash string; verified OFFLINE (see ScryptPin)
    val currency: String,
    val locationId: String,
    val masjidName: String?,
    val manualEntryEnabled: Boolean = false, // keyed card entry via Stripe's on-device form
    val publishableKey: String = "",     // Stripe publishable key (public), for the manual card sheet
    val namePolicy: String = "optional", // off | optional | required
    val emailPolicy: String = "optional",
    val feeBps: Int = 290,               // cover-fees estimate: 2.9%
    val feeFixedMinor: Long = 30,        //                    + a small fixed fee
    val maxBrightness: Boolean = true,   // force the tablet to full screen brightness
    val footerText: String = "OpenMasjid Solutions", // bottom tagline ('' hides it)
    /** UI rotation in DEGREES, set from the web UI: "0" (as mounted) | "90" | "180" | "270". The app
     *  rotates its own content by this angle (RotatedRoot), so it works even on tablets that ignore
     *  system orientation requests. Legacy named values are still accepted + mapped by orientationDegrees. */
    val orientation: String = "0",
    /** Large-donation alternative: at/above this many MINOR units the kiosk suggests a cheaper way
     *  to give (bank transfer / Zelle QR) before the card. 0 disables it. */
    val largeAmountThresholdMinor: Long = 0,
    val largeAmountNote: String = "",
    val largeAmountImage: String = "", // '/uploads/…' | 'https://…' | ''
    /** Play a fireworks celebration on the thank-you screen after a successful donation. */
    val celebrateEnabled: Boolean = false,
    /** Only celebrate when the gift is at least this many MINOR units (0 = celebrate every gift). */
    val celebrateThresholdMinor: Long = 0,
    val mainCampaignId: String = "",
    val campaigns: List<Campaign> = emptyList(),
) {
    /** The main campaign (first tab) — or the first campaign, or null if none synced yet. */
    val mainCampaign: Campaign? get() = campaigns.firstOrNull { it.isMain } ?: campaigns.firstOrNull()

    fun campaignById(id: String?): Campaign? = id?.let { cid -> campaigns.firstOrNull { it.id == cid } }
}

/** A snapshot of device health sent on each heartbeat and shown on the maintenance screen. */
data class Diagnostics(
    val battery: Int? = null,
    val charging: Boolean? = null,
    val readerStatus: String = "not_connected", // reader arrives in slice 5
    val appVersion: String = "",
    val latestAppVersion: String = "", // the server's bundled APK version (for "update available")
    val pinnedCertSha256: String? = null,
    val deviceId: String? = null,
    val serverUrl: String? = null,
    val lastHeartbeatMs: Long? = null,
    val online: Boolean = false,
    val uptimeMs: Long = 0, // how long this kiosk app has been running
)

/** One structured device log line, batched and flushed to `POST /api/kiosk/logs`. */
data class LogEntry(
    val level: String,   // "info" | "warn" | "error"
    val event: String,
    val detail: String? = null,
    val ts: Long = System.currentTimeMillis(),
)
