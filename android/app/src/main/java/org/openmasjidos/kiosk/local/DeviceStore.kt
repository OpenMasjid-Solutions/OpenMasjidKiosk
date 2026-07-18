// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.local

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
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
        val CFG_MASJID_NAME = stringPreferencesKey("cfg_masjid_name")
        // Global giving policy + campaigns (the per-appeal giving screens). Campaigns are stored as a
        // JSON string; without persisting them the tablet would fetch the config but drop the amounts/
        // colours/messages on save, so the kiosk would never reflect edits.
        val CFG_MANUAL = booleanPreferencesKey("cfg_manual")
        val CFG_PUBKEY = stringPreferencesKey("cfg_pubkey")
        val CFG_NAME_POLICY = stringPreferencesKey("cfg_name_policy")
        val CFG_EMAIL_POLICY = stringPreferencesKey("cfg_email_policy")
        val CFG_FEE_BPS = intPreferencesKey("cfg_fee_bps")
        val CFG_FEE_FIXED = longPreferencesKey("cfg_fee_fixed")
        val CFG_MAX_BRIGHTNESS = booleanPreferencesKey("cfg_max_brightness")
        val CFG_FOOTER = stringPreferencesKey("cfg_footer")
        val CFG_ORIENTATION = stringPreferencesKey("cfg_orientation")
        val CFG_LARGE_THRESHOLD = longPreferencesKey("cfg_large_threshold")
        val CFG_LARGE_NOTE = stringPreferencesKey("cfg_large_note")
        val CFG_LARGE_IMAGE = stringPreferencesKey("cfg_large_image")
        val CFG_CELEBRATE = booleanPreferencesKey("cfg_celebrate")
        val CFG_CELEBRATE_THRESHOLD = longPreferencesKey("cfg_celebrate_threshold")
        val CFG_MAIN_CAMPAIGN = stringPreferencesKey("cfg_main_campaign")
        val CFG_CAMPAIGNS = stringPreferencesKey("cfg_campaigns") // JSON array of campaigns

        // The reader the admin last connected, so it auto-reconnects on boot. USB stores just the
        // transport ("Usb"); Bluetooth also stores the serial so we reconnect that exact reader.
        val LAST_READER_TRANSPORT = stringPreferencesKey("last_reader_transport")
        val LAST_READER_SERIAL = stringPreferencesKey("last_reader_serial")
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
                masjidName = p[Keys.CFG_MASJID_NAME]?.takeIf { it.isNotBlank() },
                manualEntryEnabled = p[Keys.CFG_MANUAL] ?: false,
                publishableKey = p[Keys.CFG_PUBKEY].orEmpty(),
                namePolicy = p[Keys.CFG_NAME_POLICY]?.takeIf { it.isNotBlank() } ?: "optional",
                emailPolicy = p[Keys.CFG_EMAIL_POLICY]?.takeIf { it.isNotBlank() } ?: "optional",
                feeBps = p[Keys.CFG_FEE_BPS] ?: 290,
                feeFixedMinor = p[Keys.CFG_FEE_FIXED] ?: 30L,
                maxBrightness = p[Keys.CFG_MAX_BRIGHTNESS] ?: true,
                footerText = p[Keys.CFG_FOOTER] ?: "OpenMasjid Solutions",
                orientation = p[Keys.CFG_ORIENTATION] ?: "0",
                largeAmountThresholdMinor = p[Keys.CFG_LARGE_THRESHOLD] ?: 0L,
                largeAmountNote = p[Keys.CFG_LARGE_NOTE].orEmpty(),
                largeAmountImage = p[Keys.CFG_LARGE_IMAGE].orEmpty(),
                celebrateEnabled = p[Keys.CFG_CELEBRATE] ?: false,
                celebrateThresholdMinor = p[Keys.CFG_CELEBRATE_THRESHOLD] ?: 0L,
                mainCampaignId = p[Keys.CFG_MAIN_CAMPAIGN].orEmpty(),
                campaigns = CampaignJson.parseString(p[Keys.CFG_CAMPAIGNS]),
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
            p[Keys.CFG_MASJID_NAME] = config.masjidName.orEmpty()
            p[Keys.CFG_MANUAL] = config.manualEntryEnabled
            p[Keys.CFG_PUBKEY] = config.publishableKey
            p[Keys.CFG_NAME_POLICY] = config.namePolicy
            p[Keys.CFG_EMAIL_POLICY] = config.emailPolicy
            p[Keys.CFG_FEE_BPS] = config.feeBps
            p[Keys.CFG_FEE_FIXED] = config.feeFixedMinor
            p[Keys.CFG_MAX_BRIGHTNESS] = config.maxBrightness
            p[Keys.CFG_FOOTER] = config.footerText
            p[Keys.CFG_ORIENTATION] = config.orientation
            p[Keys.CFG_LARGE_THRESHOLD] = config.largeAmountThresholdMinor
            p[Keys.CFG_LARGE_NOTE] = config.largeAmountNote
            p[Keys.CFG_LARGE_IMAGE] = config.largeAmountImage
            p[Keys.CFG_CELEBRATE] = config.celebrateEnabled
            p[Keys.CFG_CELEBRATE_THRESHOLD] = config.celebrateThresholdMinor
            p[Keys.CFG_MAIN_CAMPAIGN] = config.mainCampaignId
            p[Keys.CFG_CAMPAIGNS] = CampaignJson.toJsonString(config.campaigns)
        }
    }

    /** Remember (or, with a blank transport, forget) the reader to auto-reconnect on boot. */
    suspend fun saveLastReader(transport: String, serial: String?) {
        store.edit { p ->
            p[Keys.LAST_READER_TRANSPORT] = transport
            p[Keys.LAST_READER_SERIAL] = serial.orEmpty()
        }
    }

    /** The last-connected reader as (transport, serial?) — or null if none remembered. */
    suspend fun getLastReader(): Pair<String, String?>? {
        val p = store.data.first()
        val t = p[Keys.LAST_READER_TRANSPORT]?.takeIf { it.isNotBlank() } ?: return null
        return t to p[Keys.LAST_READER_SERIAL]?.takeIf { it.isNotBlank() }
    }

    /**
     * Wipe all pairing + config. Called when the server reports the device is revoked, or when
     * the volunteer chooses to re-pair. After this the app returns to the pairing screen.
     */
    suspend fun clear() {
        store.edit { it.clear() }
    }
}
