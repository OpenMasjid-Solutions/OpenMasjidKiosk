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
import java.util.concurrent.TimeUnit

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

/** Tuition (students/billing) shell data — the tile label + whether tuition is available at all.
 *  [allowAdvance] means the school takes money when nothing is due (pay a term up front); the tablet
 *  offers an amount pad in that case. [minAmountMinor] is the floor for a typed amount. */
data class TuitionInfo(
    val enabled: Boolean,
    val schoolName: String,
    val currency: String,
    val tagline: String,
    val allowAdvance: Boolean = false,
    val minAmountMinor: Long = 100L,
)

/** One LINE of a bill (contract 0.43.0 §11.0b) — "Monthly tuition £200", "Book fee £50", "Bursary −£30".
 *  [kind] is `tuition` | `charge` | `credit` and is an OPEN set: an unrecognised kind is still rendered,
 *  because dropping one would make the lines stop adding up to the bill. [amountMinor] is signed (a
 *  credit line is negative); [balanceMinor] is what is still payable — 0 for a settled or credit line. */
data class TuitionItem(
    val id: String,
    val label: String,
    val kind: String,
    val amountMinor: Long,
    val balanceMinor: Long,
)

/** One open invoice a parent can choose to pay. [balanceMinor] is the smallest currency unit.
 *  [studentName] is whose bill it is — blank for an only child (contract v2: bills are per student).
 *  [items] is what the bill is made of (0.43.0); empty against an older Students, and then the bill
 *  behaves exactly as it did before — one label, one number, one tick. */
data class TuitionInvoice(
    val id: String,
    val label: String,
    val dueDate: String,
    val balanceMinor: Long,
    val studentName: String = "",
    val items: List<TuitionItem> = emptyList(),
)

/** One CHILD's section of the account: their own balance, their own credit, and their own bills.
 *  [key] is the opaque per-session handle used to pay towards this child specifically — the school's
 *  internal student id never reaches the tablet. Blank for the (defensive) unattributed section. */
data class TuitionStudent(
    val key: String,
    val name: String,
    val balanceMinor: Long,
    val creditMinor: Long,
    val invoices: List<TuitionInvoice>,
)

/** A looked-up family + its balance. [session] is the OPAQUE server-side session id used to pay — the
 *  real family/student ids stay on the server.
 *
 *  [creditMinor] is money already paid ahead (0.41.0): at most one of balance/credit is non-zero, and
 *  without it a zero balance can't be told apart from "paid ahead". [allowAdvance]/[minAmountMinor]
 *  ride along from the school's settings so the pay screen can offer an amount and floor it.
 *  [students] is the account split child by child — with one bill per child, a household total can't
 *  say who owes what, and one flat list of "Tuition — Feb" rows for three children is unreadable. */
data class TuitionFamily(
    val session: String,
    val label: String,
    val students: List<TuitionStudent>,
    val balanceMinor: Long,
    val creditMinor: Long,
    val currency: String,
    val allowAdvance: Boolean,
    val minAmountMinor: Long,
)

/** What the parent chose to pay. The server recomputes the amount from its own held session whatever
 *  this says — it only ever names ids the server itself handed out. */
sealed interface TuitionPay {
    /** The whole household balance. */
    data object Full : TuitionPay
    /** Whole bills, for a provider that gave us no lines to tick. */
    data class Invoices(val ids: List<String>) : TuitionPay
    /** Ticked bill LINES (0.43.0) — "just the book fee". */
    data class Items(val ids: List<String>) : TuitionPay
    /** A typed amount, for [studentKey]'s ledger when a child was named (blank = the household). */
    data class Amount(val minor: Long, val studentKey: String = "") : TuitionPay
}

/** Result of `identify`: the child a typed Student ID belongs to, so the parent can confirm the name
 *  before any balance is shown (contract v2 §11.0 — this replaced the PIN). [name] is a first name +
 *  last initial and nothing else; blank when [found] is false. */
data class TuitionIdentifyResult(val found: Boolean, val name: String)

/** Result of a tuition lookup: found (+ family), or a uniform not-found. An UNAVAILABLE broker error is
 *  surfaced as an ApiException (so the UI says "temporarily unavailable", never "wrong ID"). */
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

    /**
     * A more patient client for the two calls that go through our server to STRIPE.
     *
     * The ordinary client is deliberately impatient (8s read / 12s call) so heartbeats and config
     * polls fail soft against an absent server. That is wrong for a payment: creating a
     * PaymentIntent means our server making one or two round trips to Stripe over the masjid's
     * uplink, and a MONTHLY needs two (a customer, then the intent). Giving up at 8s there doesn't
     * "fail soft" — it shows a donor "Sorry, we couldn't start the payment" while the server was
     * still going, and it hit monthly two to three times more often than a one-off. That is the
     * exact reported symptom, including the tap prompt appearing for a split second when the
     * timeout landed just after the intent was created.
     *
     * The server bounds its own Stripe work well inside this (see stripe.ts PAY_TIMEOUT_MS), so the
     * SERVER is always the one that decides the outcome and can report a real reason. Sharing the
     * connection pool via newBuilder keeps the pinned trust and costs nothing.
     */
    private val payClient: OkHttpClient by lazy {
        client.newBuilder()
            .readTimeout(45, TimeUnit.SECONDS)
            .writeTimeout(45, TimeUnit.SECONDS)
            .callTimeout(60, TimeUnit.SECONDS)
            .build()
    }

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
            tabSize = cfg.optString("tabSize", "medium"),
            orientation = cfg.optString("orientation", "0"),
            nfcSide = cfg.optString("nfcSide", "off"),
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
        val json = post(baseUrl, "/api/kiosk/payment-intents", body, token, patient = true)
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
        val json = post(baseUrl, "/api/kiosk/payment-intents/$id/complete", JSONObject(), token, patient = true)
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
        return TuitionInfo(
            json.optBoolean("enabled", false),
            json.optString("schoolName"),
            json.optString("currency"),
            json.optString("tagline"),
            json.optBoolean("allowAdvance", false),
            json.optLong("minAmountMinor", 100L),
        )
    }

    /** `POST /api/kiosk/tuition/identify` — Student ID → the child's name, for the "is this the right
     *  child?" confirmation. Answers a name and nothing else; `found:false` is uniform (unknown,
     *  withdrawn or locked ID all look the same); a broker outage throws ApiException(503). */
    fun tuitionIdentify(baseUrl: String, token: String, campaignId: String, studentCode: String): TuitionIdentifyResult {
        val body = JSONObject().put("campaignId", campaignId).put("studentCode", studentCode)
        val json = post(baseUrl, "/api/kiosk/tuition/identify", body, token)
        if (!json.optBoolean("found", false)) return TuitionIdentifyResult(false, "")
        val s = json.optJSONObject("student") ?: JSONObject()
        val name = listOf(s.optString("firstName"), s.optString("lastInitial")).filter { it.isNotBlank() }.joinToString(" ")
        return TuitionIdentifyResult(true, name)
    }

    /** `POST /api/kiosk/tuition/lookup` — Student ID → family + balance (contract v2: no name, no PIN).
     *  Called only AFTER the parent confirmed the name from `identify`. The ID is sent in the body only.
     *  `found:false` is uniform; a broker outage throws ApiException(503). */
    fun tuitionLookup(baseUrl: String, token: String, campaignId: String, studentCode: String): TuitionLookupResult {
        val body = JSONObject().put("campaignId", campaignId).put("studentCode", studentCode)
        val json = post(baseUrl, "/api/kiosk/tuition/lookup", body, token)
        if (!json.optBoolean("found", false)) return TuitionLookupResult(false, null)
        val f = json.getJSONObject("family")
        val stuArr = f.optJSONArray("students") ?: JSONArray()
        val students = (0 until stuArr.length()).map { i ->
            val o = stuArr.getJSONObject(i)
            TuitionStudent(
                key = o.optString("key"),
                name = o.optString("name").ifBlank {
                    listOf(o.optString("firstName"), o.optString("lastInitial")).filter { it.isNotBlank() }.joinToString(" ")
                },
                balanceMinor = o.optLong("balanceCents", 0L),
                creditMinor = o.optLong("creditCents", 0L),
                invoices = parseInvoices(o.optJSONArray("invoices")),
            )
        }
        return TuitionLookupResult(
            true,
            TuitionFamily(
                session = json.optString("session"),
                label = f.optString("label"),
                students = students,
                balanceMinor = f.optLong("balanceCents", 0L),
                creditMinor = f.optLong("creditCents", 0L),
                currency = f.optString("currency"),
                allowAdvance = json.optBoolean("allowAdvance", false),
                minAmountMinor = json.optLong("minAmountMinor", 100L),
            ),
        )
    }

    private fun parseInvoices(arr: JSONArray?): List<TuitionInvoice> {
        val a = arr ?: return emptyList()
        return (0 until a.length()).map { i ->
            val o = a.getJSONObject(i)
            val itemArr = o.optJSONArray("items") ?: JSONArray()
            TuitionInvoice(
                id = o.optString("id"),
                label = o.optString("label"),
                dueDate = o.optString("dueDate"),
                balanceMinor = o.optLong("balanceCents", 0L),
                studentName = o.optString("studentName"),
                items = (0 until itemArr.length()).map { j ->
                    val line = itemArr.getJSONObject(j)
                    TuitionItem(
                        id = line.optString("id"),
                        label = line.optString("label"),
                        kind = line.optString("kind"),
                        amountMinor = line.optLong("amountCents", 0L),
                        balanceMinor = line.optLong("balanceCents", 0L),
                    )
                },
            )
        }
    }

    /** `POST /api/kiosk/tuition/payment-intents` — the server recomputes the amount from the session
     *  (full balance, ticked bills or lines, or a typed amount) and mints a card-present PaymentIntent.
     *  Everything in [pay] is an id or key the SERVER issued; it re-checks the floor, the school's
     *  advance policy and its own copy of the balances before charging anything. */
    fun createTuitionPaymentIntent(
        baseUrl: String,
        token: String,
        session: String,
        pay: TuitionPay,
        idempotencyKey: String,
    ): CreatedPaymentIntent {
        val selection = when (pay) {
            is TuitionPay.Amount -> JSONObject().put("kind", "amount").put("amountMinor", pay.minor).apply {
                if (pay.studentKey.isNotBlank()) put("studentKey", pay.studentKey)
            }
            is TuitionPay.Items -> JSONObject().put("kind", "items").put("itemIds", JSONArray(pay.ids))
            is TuitionPay.Invoices -> JSONObject().put("kind", "invoices").put("invoiceIds", JSONArray(pay.ids))
            TuitionPay.Full -> JSONObject().put("kind", "full")
        }
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

    private fun post(baseUrl: String, path: String, body: JSONObject, token: String?, patient: Boolean = false): JSONObject {
        val req = Request.Builder()
            .url(url(baseUrl, path))
            .post(body.toString().toRequestBody(jsonMedia))
            .apply { if (token != null) header("X-Device-Token", token) }
            .header("Accept", "application/json")
            .build()
        return execute(req, patient)
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

    private fun execute(req: Request, patient: Boolean = false): JSONObject {
        (if (patient) payClient else client).newCall(req).execute().use { resp ->
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
