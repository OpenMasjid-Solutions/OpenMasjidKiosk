// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.local

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import java.io.IOException

// Single DataStore instance for the whole process. The delegate must be declared exactly
// once per file/name, so all kiosk persistence funnels through this one store.
private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "kiosk")

/**
 * The kiosk's local persistence: the pairing (server URL, device token, device id, pinned
 * certificate fingerprint) and the last synced config.
 *
 * Security notes:
 *  - The device token and pinned fingerprint are device-bound secrets; backup is disabled at
 *    the app level (see AndroidManifest / data_extraction_rules) so they never leave the tablet.
 *  - We store the scrypt PIN *hash* only — never a plaintext PIN — so offline unlock verifies
 *    against the hash and a stolen device yields nothing reusable.
 *  - No Stripe material is ever stored here (that lives only in the server's memory, per the
 *    Fabric rules); the tablet only ever handles connection tokens at runtime, never at rest.
 */
class DeviceStore(private val context: Context) {

    private val store get() = context.dataStore

    private object Keys {
        val SERVER_URL = stringPreferencesKey("server_url")
        val DEVICE_TOKEN = stringPreferencesKey("device_token")
        val DEVICE_ID = stringPreferencesKey("device_id")
        val CERT_SHA256 = stringPreferencesKey("cert_sha256")

        val CFG_VERSION = intPreferencesKey("cfg_version")
        val CFG_PIN_HASH = stringPreferencesKey("cfg_pin_hash")
        val CFG_CURRENCY = stringPreferencesKey("cfg_currency")
        val CFG_LOCATION_ID = stringPreferencesKey("cfg_location_id")
        val CFG_ATTRACT_TITLE = stringPreferencesKey("cfg_attract_title")
        val CFG_MASJID_NAME = stringPreferencesKey("cfg_masjid_name")
    }

    /** Emits the current pairing, or null when the kiosk is not (yet) paired. */
    val pairing: Flow<PairingRecord?> = store.data
        .catch { e -> if (e is IOException) emit(emptyPreferences()) else throw e }
        .map { p ->
            val url = p[Keys.SERVER_URL]
            val token = p[Keys.DEVICE_TOKEN]
            val id = p[Keys.DEVICE_ID]
            val cert = p[Keys.CERT_SHA256]
            if (!url.isNullOrBlank() && !token.isNullOrBlank() && !id.isNullOrBlank() && !cert.isNullOrBlank()) {
                PairingRecord(url, token, id, cert)
            } else {
                null
            }
        }

    /** Emits the last synced config, or null before the first config fetch. */
    val config: Flow<KioskConfig?> = store.data
        .catch { e -> if (e is IOException) emit(emptyPreferences()) else throw e }
        .map { p ->
            val version = p[Keys.CFG_VERSION] ?: return@map null
            KioskConfig(
                version = version,
                pinHash = p[Keys.CFG_PIN_HASH].orEmpty(),
                currency = p[Keys.CFG_CURRENCY].orEmpty(),
                locationId = p[Keys.CFG_LOCATION_ID].orEmpty(),
                attractTitle = p[Keys.CFG_ATTRACT_TITLE]?.takeIf { it.isNotBlank() },
                masjidName = p[Keys.CFG_MASJID_NAME]?.takeIf { it.isNotBlank() },
            )
        }

    /** Persist a fresh pairing (called after a successful `POST /api/kiosk/pair`). */
    suspend fun savePairing(serverUrl: String, deviceToken: String, deviceId: String, certSha256: String) {
        store.edit { p ->
            p[Keys.SERVER_URL] = serverUrl.trimEnd('/')
            p[Keys.DEVICE_TOKEN] = deviceToken
            p[Keys.DEVICE_ID] = deviceId
            p[Keys.CERT_SHA256] = certSha256.lowercase()
        }
    }

    /** Persist a freshly fetched config. */
    suspend fun saveConfig(config: KioskConfig) {
        store.edit { p ->
            p[Keys.CFG_VERSION] = config.version
            p[Keys.CFG_PIN_HASH] = config.pinHash
            p[Keys.CFG_CURRENCY] = config.currency
            p[Keys.CFG_LOCATION_ID] = config.locationId
            p[Keys.CFG_ATTRACT_TITLE] = config.attractTitle.orEmpty()
            p[Keys.CFG_MASJID_NAME] = config.masjidName.orEmpty()
        }
    }

    /**
     * Wipe all pairing + config. Called when the server reports the device is revoked, or when
     * the volunteer chooses to re-pair. After this the app returns to the pairing screen.
     */
    suspend fun clear() {
        store.edit { it.clear() }
    }
}
