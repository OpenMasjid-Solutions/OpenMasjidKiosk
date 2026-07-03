// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.net

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.openmasjidos.kiosk.local.KioskConfig
import org.openmasjidos.kiosk.local.LogEntry
import java.io.IOException

/** Raised on a non-2xx response; [status] lets callers map codes to friendly messages. */
class ApiException(val status: Int, message: String) : IOException(message)

/** Parsed result of `POST /api/kiosk/pair`. */
data class PairResponse(val deviceToken: String, val deviceId: String, val configVersion: Int)

/** Parsed result of `POST /api/kiosk/heartbeat`. */
data class HeartbeatResponse(val configVersion: Int, val identify: Boolean, val revoked: Boolean)

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
    ): HeartbeatResponse {
        val body = JSONObject()
            .put("appVersion", appVersion)
            .put("configVersion", configVersion)
        if (battery != null) body.put("battery", battery)
        if (charging != null) body.put("charging", charging)
        if (readerStatus != null) body.put("readerStatus", readerStatus)
        if (readerSerial != null) body.put("readerSerial", readerSerial)
        if (readerBattery != null) body.put("readerBattery", readerBattery)
        val json = post(baseUrl, "/api/kiosk/heartbeat", body, token)
        return HeartbeatResponse(
            configVersion = json.optInt("configVersion", configVersion),
            identify = json.optBoolean("identify", false),
            revoked = json.optBoolean("revoked", false),
        )
    }

    /** `GET /api/kiosk/config` (device token). */
    fun getConfig(baseUrl: String, token: String): KioskConfig {
        val json = get(baseUrl, "/api/kiosk/config", token)
        val version = json.optInt("version", 0)
        val cfg = json.optJSONObject("config") ?: JSONObject()
        return KioskConfig(
            version = version,
            pinHash = cfg.optString("pinHash", ""),
            currency = cfg.optString("currency", ""),
            locationId = cfg.optString("locationId", ""),
            attractTitle = cfg.optString("attractTitle", "").takeIf { it.isNotBlank() },
            masjidName = cfg.optString("masjidName", "").takeIf { it.isNotBlank() },
        )
    }

    /** `POST /api/kiosk/connection-token` (device token). Returns the short-lived Stripe Terminal
     *  connection token — the only Stripe credential the tablet ever holds. */
    fun connectionToken(baseUrl: String, token: String): String {
        val json = post(baseUrl, "/api/kiosk/connection-token", JSONObject(), token)
        return json.getString("secret")
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
