// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.security

import android.util.Base64
import org.bouncycastle.crypto.generators.SCrypt
import java.security.MessageDigest

/**
 * Offline verification of the kiosk exit PIN against an scrypt hash synced from the server.
 *
 * WHY OFFLINE: the volunteer must be able to unlock a wall tablet even when the LAN/server is
 * down, so unlock verifies against the hash stored in the last-synced config — never a network
 * call. The server rotates the hash from Admin → Devices; the kiosk picks it up on the next
 * heartbeat, at which point the old PIN stops working.
 *
 * HASH FORMAT (coordinate the server to emit exactly this — see the summary):
 *
 *     scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>
 *
 *   - literal prefix "scrypt"
 *   - N, r, p: scrypt cost parameters as base-10 integers (N is the CPU/memory cost, a power of
 *     two, e.g. 16384; r the block size, e.g. 8; p the parallelisation, e.g. 1)
 *   - saltB64: the salt, standard Base64 (may include padding)
 *   - hashB64: the derived key, standard Base64; its decoded length is the derived-key length,
 *     so the server picks the dkLen (32 bytes recommended) and we mirror it automatically
 *
 * All five `$`-separated fields are required; anything else is treated as an invalid hash and
 * verification fails closed. Base64 is decoded permissively (URL-safe or standard, with/without
 * padding). Comparison is constant-time.
 */
object ScryptPin {

    private const val PREFIX = "scrypt"
    private val B64_FLAGS = Base64.NO_WRAP or Base64.URL_SAFE

    /**
     * @return true iff [pin] matches [hashString]. Any parse/format error returns false — we never
     *   throw into the unlock path, and an unparseable hash must not unlock the kiosk.
     */
    fun verify(pin: String, hashString: String): Boolean {
        val parts = hashString.split('$')
        if (parts.size != 6 || parts[0] != PREFIX) return false

        val n = parts[1].toIntOrNull() ?: return false
        val r = parts[2].toIntOrNull() ?: return false
        val p = parts[3].toIntOrNull() ?: return false
        val salt = decode(parts[4]) ?: return false
        val expected = decode(parts[5]) ?: return false
        if (n < 2 || r < 1 || p < 1 || salt.isEmpty() || expected.isEmpty()) return false

        return try {
            val actual = SCrypt.generate(
                pin.toByteArray(Charsets.UTF_8),
                salt,
                n,
                r,
                p,
                expected.size, // derived-key length mirrors the stored hash length
            )
            MessageDigest.isEqual(actual, expected)
        } catch (_: Exception) {
            // e.g. IllegalArgumentException for out-of-range scrypt params → fail closed.
            false
        }
    }

    /** Decode standard OR URL-safe Base64, tolerating missing padding. Null on failure. */
    private fun decode(value: String): ByteArray? = runCatching {
        // URL_SAFE flag also accepts standard '+'/'/' via Android's decoder tolerance; NO_PADDING
        // is not set so padded input is fine too. Normalise just in case the server used '+'/'/'.
        val normalised = value.replace('+', '-').replace('/', '_')
        Base64.decode(normalised, B64_FLAGS)
    }.getOrNull()
}
