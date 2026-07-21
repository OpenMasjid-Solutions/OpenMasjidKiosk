// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.net

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.openmasjidos.kiosk.local.Campaign
import org.openmasjidos.kiosk.local.CampaignJson
import org.openmasjidos.kiosk.local.KioskConfig
import org.openmasjidos.kiosk.local.LogEntry
import java.io.IOException

/** Raised on a non-2xx response; [status] lets callers map codes to friendly messages. */
class ApiException(val status: Int, message: String) : IOException(message)

/** Parsed result of `POST /api/kiosk/pair`. */
data class PairResponse(val deviceToken: String, val deviceId: String, val configVersion: Int)

/** Parsed result of `POST /api/kiosk/payment-intents`. [publishableKey] is present only for a manual
 *  (keyed) intent — the tablet needs it to drive Stripe's on-device card form. [chargeMinor] is what
 *  will actually be charged (base + any cover-fee, computed server-side). */
data class CreatedPaymentIntent(
    val id: String,
    val clientSecret: String,
    val publishableKey: String? = null,
    val chargeMinor: Long = 0L,
    val coverFees: Boolean = false,
)

/** Parsed result of `POST /api/kiosk/payment-intents/{id}/complete` (server-verified).
 *  [monthlyRequested]/[monthlyCreated] tell the tablet whether an ongoing monthly subscription was
 *  set up, so it can thank the donor accordingly (or say monthly couldn't be arranged with the card). */
data class CompletedDonation(
    val status: String,
    val succeeded: Boolean,
    val amountMinor: Long,
    val currency: String,
    val monthlyRequested: Boolean = false,
    val monthlyCreated: Boolean = false,
)

/** Tuition (students/billing) shell data — the tile label + whether tuition is available at all. */
data class TuitionInfo(val enabled: Boolean, val schoolName: String, val currency: String, val tagline: String)

/** One open invoice a parent can choose to pay. [balanceMinor] is the smallest currency unit. */
data class TuitionInvoice(val id: String, val label: String, val dueDate: String, val balanceMinor: Long)

/** A looked-up family + its balance. [session] is the OPAQUE server-side session id used to pay — the
 *  real family/student ids stay on the server. */
data class TuitionFamily(
    val session: String,
    val label: String,
    val students: List<String>,
    val balanceMinor: Long,
    val currency: String,
    val invoices: List<TuitionInvoice>,
)

/** Result of a tuition lookup: found (+ family), or a uniform not-found. An UNAVAILABLE broker error is
 *  surfaced as an ApiException (so the UI says "temporarily unavailable", never "wrong PIN"). */
data class TuitionLookupResult(val found: Boolean, val family: TuitionFamily?)

/** Server-verified outcome of a tuition payment (recorded to Students, never as a kiosk donation). */
data class CompletedTuition(val status: String, val succeeded: Boolean, val amountMinor: Long, val currency: String)

/** Parsed result of `POST /api/kiosk/heartbeat`. */
data class HeartbeatResponse(
    val configVersion: Int,
    val identify: Boolean,
    val latestAppVersion: String,
    val revoked: Boolean,
)

/**
 * Thin, blocking JSON client over an already-configured (pinned or TOFU) [OkHttpClient].
 * All methods run their network I/O synchronously and must be called off the main thread
 * (see [org.openmasjidos.kiosk.net.KioskRepository], which wraps them on Dispatchers.IO).
 *
 * The device token is sent as the `X-Device-Token` header on every call except pair, exactly
 * as the server contract requires. We build request bodies with org.json (no extra dependency).
 */
class KioskApi(private val client: OkHttpClient) {

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    /** `POST /api/kiosk/pair` — no token; returns the device token exactly once. */
    fun pair(baseUrl: String, code: String, name: String): PairResponse {
        val body = JSONObject()
            .put("code", code)
            .put("name", name)
            .put("platform", "android")
        val json = post(baseUrl, "/api/kiosk/pair", body, token = null)
        return PairResponse(
            deviceToken = json.getString("deviceToken"),
            deviceId = json.getString("deviceId"),
            configVersion = json.optInt("configVersion", 0),
        )
    }

    /** `POST /api/kiosk/heartbeat` (device token). */
    fun heartbeat(
        baseUrl: String,
        token: String,
        appVersion: String,
        configVersion: Int,
        battery: Int?,
        charging: Boolean?,
        readerStatus: String?,
        readerSerial: String?,
        readerBattery: Int?,
        foreground: Boolean,
    ): HeartbeatResponse {
        val body = JSONObject()
            .put("appVersion", appVersion)
            .put("configVersion", configVersion)
            .put("foreground", foreground)
        if (battery != null) body.put("battery", battery)
        if (charging != null) body.put("charging", charging)
        if (readerStatus != null) body.put("readerStatus", readerStatus)
        if (readerSerial != null) body.put("readerSerial", readerSerial)
        if (readerBattery != null) body.put("readerBattery", readerBattery)
        val json = post(baseUrl, "/api/kiosk/heartbeat", body, token)
        return HeartbeatResponse(
            configVersion = json.optInt("configVersion", configVersion),
            identify = json.optBoolean("identify", false),
            latestAppVersion = json.optString("latestAppVersion", ""),
            revoked = json.optBoolean("revoked", false),
        )
    }

    /** `GET /api/kiosk/config` (device token). */
    fun getConfig(baseUrl: String, token: String): KioskConfig {
        val json = get(baseUrl, "/api/kiosk/config", token)
        val version = json.optInt("version", 0)
        val cfg = json.optJSONObject("config") ?: JSONObject()
        var campaigns = CampaignJson.parseList(cfg.optJSONArray("campaigns"))
        // Backward-compat: an older server that still sends a single flat giving screen (no
        // `campaigns`) → synthesise one main campaign so the tablet still works.
        if (campaigns.isEmpty() && cfg.has("presetsMinor")) {
            val presetsArr = cfg.optJSONArray("presetsMinor")
            val presets = buildList { if (presetsArr != null) for (i in 0 until presetsArr.length()) add(presetsArr.optLong(i)) }
            campaigns = listOf(
                Campaign(
                    id = "main",
                    title = cfg.optString("masjidName", "").ifBlank { "General Fund" },
                    presetsMinor = presets,
                    allowCustom = cfg.optBoolean("allowCustom", true),
                    customMinMinor = cfg.optLong("customMinMinor", 100),
                    customMaxMinor = cfg.optLong("customMaxMinor", 1_000_000),
                    monthlyEnabled = cfg.optBoolean("monthlyEnabled", false),
                    thankYouMessage = cfg.optString("thankYouMessage", ""),
                    isMain = true,
                    readerCapable = true,
                ),
            )
        }
        return KioskConfig(
            version = version,
            pinHash = cfg.optString("pinHash", ""),
            currency = cfg.optString("currency", ""),
            locationId = cfg.optString("locationId", ""),
            masjidName = cfg.optString("masjidName", "").takeIf { it.isNotBlank() },
            manualEntryEnabled = cfg.optBoolean("manualEntryEnabled", false),
            publishableKey = cfg.optString("publishableKey", ""),
            namePolicy = cfg.optString("namePolicy", "optional"),
            emailPolicy = cfg.optString("emailPolicy", "optional"),
            feeBps = cfg.optInt("feeBps", 290),
            feeFixedMinor = cfg.optLong("feeFixedMinor", 30),
            maxBrightness = cfg.optBoolean("maxBrightness", true),
            footerText = cfg.optString("footerText", "OpenMasjid Solutions"),
            orientation = cfg.optString("orientation", "0"),
            largeAmountThresholdMinor = cfg.optLong("largeAmountThresholdMinor", 0L),
            largeAmountNote = cfg.optString("largeAmountNote", ""),
            largeAmountImage = cfg.optString("largeAmountImage", ""),
            celebrateEnabled = cfg.optBoolean("celebrateEnabled", false),
            celebrateThresholdMinor = cfg.optLong("celebrateThresholdMinor", 0L),
            mainCampaignId = cfg.optString("mainCampaignId", ""),
            campaigns = campaigns,
        )
    }

    /** `POST /api/kiosk/connection-token` (device token). Returns the short-lived Stripe Terminal
     *  connection token — the only Stripe credential the tablet ever holds. */
    fun connectionToken(baseUrl: String, token: String): String {
        val json = post(baseUrl, "/api/kiosk/connection-token", JSONObject(), token)
        return json.getString("secret")
    }

    /** `POST /api/kiosk/payment-intents` — the server validates the amount against the configured
     *  presets/limits and creates a card-present PaymentIntent. Returns its id + client secret. */
    fun createPaymentIntent(
        baseUrl: String,
        token: String,
        amountMinor: Long,
        campaignId: String?,
        donorName: String?,
        donorEmail: String?,
        monthly: Boolean,
        manual: Boolean,
        coverFees: Boolean,
        idempotencyKey: String,
    ): CreatedPaymentIntent {
        val body = JSONObject()
            .put("amountMinor", amountMinor)
            .put("monthly", monthly)
            .put("manual", manual)
            .put("coverFees", coverFees)
            .put("idempotencyKey", idempotencyKey)
        if (!campaignId.isNullOrBlank()) body.put("campaignId", campaignId)
        if (!donorName.isNullOrBlank()) body.put("donorName", donorName)
        if (!donorEmail.isNullOrBlank()) body.put("donorEmail", donorEmail)
        val json = post(baseUrl, "/api/kiosk/payment-intents", body, token)
        return CreatedPaymentIntent(
            json.getString("paymentIntentId"),
            json.getString("clientSecret"),
            json.optString("publishableKey", "").takeIf { it.isNotBlank() },
            json.optLong("chargeMinor", amountMinor),
            json.optBoolean("coverFees", false),
        )
    }

    /** `POST /api/kiosk/payment-intents/{id}/complete` — the server verifies + captures with Stripe
     *  and records the donation only if it truly succeeded. Returns the verified outcome. */
    fun completePaymentIntent(baseUrl: String, token: String, id: String): CompletedDonation {
        val json = post(baseUrl, "/api/kiosk/payment-intents/$id/complete", JSONObject(), token)
        val monthly = json.optJSONObject("monthly")
        return CompletedDonation(
            status = json.optString("status"),
            succeeded = json.optBoolean("succeeded", false),
            amountMinor = json.optLong("amountMinor", 0L),
            currency = json.optString("currency"),
            monthlyRequested = monthly?.optBoolean("requested", false) ?: false,
            monthlyCreated = monthly?.optBoolean("created", false) ?: false,
        )
    }

    // ---- Tuition (students/billing) — the tuition tile shells out to OpenMasjid Students ----------
    /** `GET /api/kiosk/tuition/info` — whether the tuition tile shows + its school label. */
    fun tuitionInfo(baseUrl: String, token: String): TuitionInfo {
        val json = get(baseUrl, "/api/kiosk/tuition/info", token)
        return TuitionInfo(json.optBoolean("enabled", false), json.optString("schoolName"), json.optString("currency"), json.optString("tagline"))
    }

    /** `POST /api/kiosk/tuition/lookup` — student name + PIN → family + balance. The PIN is sent in the
     *  body only. `found:false` is uniform; a broker outage throws ApiException(503). */
    fun tuitionLookup(baseUrl: String, token: String, campaignId: String, name: String, pin: String): TuitionLookupResult {
        val body = JSONObject().put("campaignId", campaignId).put("name", name).put("pin", pin)
        val json = post(baseUrl, "/api/kiosk/tuition/lookup", body, token)
        if (!json.optBoolean("found", false)) return TuitionLookupResult(false, null)
        val f = json.getJSONObject("family")
        val invArr = f.optJSONArray("openInvoices") ?: JSONArray()
        val invoices = (0 until invArr.length()).map { i ->
            val o = invArr.getJSONObject(i)
            TuitionInvoice(o.optString("id"), o.optString("label"), o.optString("dueDate"), o.optLong("balanceCents", 0L))
        }
        val stuArr = f.optJSONArray("students") ?: JSONArray()
        val students = (0 until stuArr.length()).map { i ->
            val o = stuArr.getJSONObject(i)
            listOf(o.optString("firstName"), o.optString("lastInitial")).filter { it.isNotBlank() }.joinToString(" ")
        }
        return TuitionLookupResult(
            true,
            TuitionFamily(json.optString("session"), f.optString("label"), students, f.optLong("balanceCents", 0L), f.optString("currency"), invoices),
        )
    }

    /** `POST /api/kiosk/tuition/payment-intents` — the server recomputes the amount from the session
     *  (full balance or the ticked invoices) and mints a card-present PaymentIntent. */
    fun createTuitionPaymentIntent(baseUrl: String, token: String, session: String, payFull: Boolean, invoiceIds: List<String>, idempotencyKey: String): CreatedPaymentIntent {
        val selection = JSONObject().put("kind", if (payFull) "full" else "invoices")
        if (!payFull) selection.put("invoiceIds", JSONArray(invoiceIds))
        val body = JSONObject().put("session", session).put("selection", selection).put("idempotencyKey", idempotencyKey)
        val json = post(baseUrl, "/api/kiosk/tuition/payment-intents", body, token)
        return CreatedPaymentIntent(json.getString("paymentIntentId"), json.getString("clientSecret"), null, json.optLong("chargeMinor", 0L), false)
    }

    /** `POST /api/kiosk/tuition/payment-intents/{id}/complete` — verify with Stripe + record to Students. */
    fun completeTuitionPaymentIntent(baseUrl: String, token: String, id: String): CompletedTuition {
        val json = post(baseUrl, "/api/kiosk/tuition/payment-intents/$id/complete", JSONObject(), token)
        return CompletedTuition(json.optString("status"), json.optBoolean("succeeded", false), json.optLong("amountMinor", 0L), json.optString("currency"))
    }

    /** `POST /api/kiosk/logs` (device token). Returns true on `{ ok: true }`. */
    fun postLogs(baseUrl: String, token: String, entries: List<LogEntry>): Boolean {
        val arr = JSONArray()
        entries.forEach { e ->
            val o = JSONObject()
                .put("level", e.level)
                .put("event", e.event)
                .put("ts", e.ts)
            if (e.detail != null) o.put("detail", e.detail)
            arr.put(o)
        }
        val json = post(baseUrl, "/api/kiosk/logs", JSONObject().put("entries", arr), token)
        return json.optBoolean("ok", false)
    }

    // ---- transport helpers -------------------------------------------------------------

    private fun post(baseUrl: String, path: String, body: JSONObject, token: String?): JSONObject {
        val req = Request.Builder()
            .url(url(baseUrl, path))
            .post(body.toString().toRequestBody(jsonMedia))
            .apply { if (token != null) header("X-Device-Token", token) }
            .header("Accept", "application/json")
            .build()
        return execute(req)
    }

    private fun get(baseUrl: String, path: String, token: String): JSONObject {
        val req = Request.Builder()
            .url(url(baseUrl, path))
            .get()
            .header("X-Device-Token", token)
            .header("Accept", "application/json")
            .build()
        return execute(req)
    }

    private fun execute(req: Request): JSONObject {
        client.newCall(req).execute().use { resp ->
            val raw = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                throw ApiException(resp.code, extractError(raw) ?: "HTTP ${resp.code}")
            }
            val obj = if (raw.isBlank()) JSONObject() else JSONObject(raw)
            // The server wraps every success response in a { "data": … } envelope; the fields
            // we want (deviceToken, config, …) live inside it. Unwrap it (fall back to the raw
            // object for any endpoint that ever replies unwrapped).
            return obj.optJSONObject("data") ?: obj
        }
    }

    /** Pull a human message out of a `{ "error": "…" }` body if the server sent one. */
    private fun extractError(raw: String): String? =
        runCatching { JSONObject(raw).optString("error").takeIf { it.isNotBlank() } }.getOrNull()

    private fun url(baseUrl: String, path: String) = baseUrl.trimEnd('/') + path
}
