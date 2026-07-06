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
 * The versioned config pushed by the server (`GET /api/kiosk/config`). Later slices add
 * amounts, messages, wallpaper, accent, etc.; slice 4 only needs what unlock + attract use.
 */
data class KioskConfig(
    val version: Int,
    val pinHash: String,          // scrypt hash string; verified OFFLINE (see ScryptPin)
    val currency: String,
    val locationId: String,
    val attractTitle: String?,
    val masjidName: String?,
    // ── Giving screen (slice 6) ──
    val presetsMinor: List<Long> = emptyList(),
    val allowCustom: Boolean = true,
    val customMinMinor: Long = 100,
    val customMaxMinor: Long = 1_000_000,
    val monthlyEnabled: Boolean = false, // slice 7
    val namePolicy: String = "optional", // off | optional | required
    val emailPolicy: String = "optional",
    val thankYouMessage: String = "",
)

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
)

/** One structured device log line, batched and flushed to `POST /api/kiosk/logs`. */
data class LogEntry(
    val level: String,   // "info" | "warn" | "error"
    val event: String,
    val detail: String? = null,
    val ts: Long = System.currentTimeMillis(),
)
