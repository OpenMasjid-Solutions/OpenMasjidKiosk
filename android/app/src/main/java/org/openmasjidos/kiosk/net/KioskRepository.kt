// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.net

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import org.openmasjidos.kiosk.local.DeviceStore
import org.openmasjidos.kiosk.local.KioskConfig
import org.openmasjidos.kiosk.local.LogEntry
import org.openmasjidos.kiosk.local.PairingRecord
import org.openmasjidos.kiosk.kiosk.DeviceStatus
import org.openmasjidos.kiosk.security.ScryptPin
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicReference

/** Friendly outcome of a pair attempt (messages are resolved to strings in the UI layer). */
sealed interface PairResult {
    data object Success : PairResult
    enum class Reason { INVALID_URL, INVALID_CODE, CODE_REJECTED, UNREACHABLE, CERT, GENERIC }
    data class Failed(val reason: Reason) : PairResult
}

/** Outcome of a heartbeat, driving the foreground loop and WorkManager backstop. */
sealed interface HeartbeatOutcome {
    data class Ok(val identify: Boolean, val latestAppVersion: String) : HeartbeatOutcome
    data object Revoked : HeartbeatOutcome       // server removed this device → wipe + re-pair
    data object CertMismatch : HeartbeatOutcome  // pinned cert changed → fail closed, re-pair
    data object NotPaired : HeartbeatOutcome
    data object NetworkError : HeartbeatOutcome  // fail soft: keep serving, try again next tick
}

/**
 * The single orchestration point for all server interaction. Both the foreground heartbeat loop
 * (in the ViewModel) and the WorkManager backstop go through here, so revoke/config/log handling
 * lives in exactly one place. Holds a small in-memory log buffer flushed opportunistically.
 *
 * RESTORE RESILIENCE (§6): nothing here persists Stripe material or a "linked" flag; the only
 * things at rest are the device token, pinned cert and last config (in [DeviceStore]). Every
 * call has a short timeout and fails soft to keep the kiosk usable when the LAN is flaky.
 */
class KioskRepository(context: Context) {

    private val appContext = context.applicationContext
    val store = DeviceStore(appContext)

    val pairing: Flow<PairingRecord?> get() = store.pairing
    val config: Flow<KioskConfig?> get() = store.config

    private val logBuffer = ConcurrentLinkedQueue<LogEntry>()

    // Cache one pinned client per fingerprint so we don't rebuild an SSLContext every call.
    private val cachedClient = AtomicReference<Pair<String, OkHttpClient>?>(null)

    private fun pinnedClientFor(fingerprint: String): OkHttpClient {
        cachedClient.get()?.let { (fp, client) -> if (fp == fingerprint) return client }
        // A remotely-adopted kiosk (public Cloudflare cert) is stored with the SYSTEM_TRUST sentinel
        // instead of a fingerprint → use system-CA trust + hostname verification, not a fixed pin.
        val client =
            if (fingerprint == PinnedHttp.SYSTEM_TRUST) PinnedHttp.systemClient()
            else PinnedHttp.pinnedClient(fingerprint)
        cachedClient.set(fingerprint to client)
        return client
    }

    /** Is [host] a PRIVATE / self-signed LAN address — an RFC1918 / loopback / link-local / ULA IP,
     *  `localhost`, or a `.local`/`.lan` name? Those are where the OS serves a self-signed cert, so we
     *  pair with trust-on-first-use pinning. Anything else — a real public domain OR a public IP — is
     *  treated as REMOTE and validated against the system CA store + hostname verification. Fail CLOSED:
     *  an empty / unrecognised host returns false (→ system trust), NEVER the weaker accept-any TOFU
     *  path. The host is taken from OkHttp's own parser (see pair()) so classification matches the
     *  address actually dialled. */
    private fun isPrivateHost(host: String): Boolean {
        val h = host.lowercase().removePrefix("[").removeSuffix("]").substringBefore('%') // strip IPv6 zone id
        if (h.isEmpty()) return false
        if (h == "localhost" || h.endsWith(".local") || h.endsWith(".lan")) return true
        val v4 = h.split('.')
        if (v4.size == 4 && v4.all { (it.toIntOrNull() ?: -1) in 0..255 }) {
            val a = v4[0].toInt()
            val b = v4[1].toInt()
            return a == 10 || a == 127 || (a == 192 && b == 168) || (a == 172 && b in 16..31) || (a == 169 && b == 254)
        }
        if (h.contains(':')) return h == "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")
        return false // a real public domain (or public IP) → system trust
    }

    private fun rejectReason(status: Int): PairResult.Reason = when (status) {
        400, 401, 403, 404, 409, 410, 422 -> PairResult.Reason.CODE_REJECTED
        else -> PairResult.Reason.GENERIC
    }

    // ---- Pairing -----------------------------------------------------------------------

    suspend fun pair(rawUrl: String, code: String, name: String): PairResult = withContext(Dispatchers.IO) {
        val url = rawUrl.trim()
        if (!url.startsWith("https://", ignoreCase = true) || url.length < "https://a".length) {
            return@withContext PairResult.Failed(PairResult.Reason.INVALID_URL)
        }
        if (!code.matches(Regex("^\\d{6}$"))) {
            return@withContext PairResult.Failed(PairResult.Reason.INVALID_CODE)
        }

        // Extract the host with OkHttp's OWN parser — the same one that dials the connection below — so
        // trust-mode classification can't diverge from the address actually contacted (a URL that this
        // parser rejects can't be dialled either → we fail below, never mis-trust it).
        val host = url.toHttpUrlOrNull()?.host ?: ""

        // REMOTE adoption: a real public domain or public IP (the OS Cloudflare tunnel, e.g.
        // https://omos.example.org/kiosk). Validate against the system CA store + hostname — no pin to
        // manage, and the cert may rotate. We do NOT fall back to trust-on-first-use here: a public
        // host that fails to present a valid, matching cert is a cert problem (→ re-pair), never a
        // silent TOFU downgrade a MITM could exploit. Fail closed: an unrecognised host lands here too.
        if (!isPrivateHost(host)) {
            return@withContext try {
                val resp = KioskApi(PinnedHttp.systemClient()).pair(url, code, name.ifBlank { "Kiosk" })
                store.savePairing(url, resp.deviceToken, resp.deviceId, PinnedHttp.SYSTEM_TRUST)
                log("info", "paired", "device ${resp.deviceId} (public cert)")
                runCatching { fetchConfig() }
                PairResult.Success
            } catch (e: ApiException) {
                log("warn", "pair_rejected", "status ${e.status}")
                PairResult.Failed(rejectReason(e.status))
            } catch (e: javax.net.ssl.SSLException) {
                log("warn", "pair_cert", e.javaClass.simpleName)
                PairResult.Failed(PairResult.Reason.CERT)
            } catch (_: IOException) {
                PairResult.Failed(PairResult.Reason.UNREACHABLE)
            } catch (_: Exception) {
                PairResult.Failed(PairResult.Reason.GENERIC)
            }
        }

        // LAN adoption: the OS serves a self-signed cert addressed by IP. Trust-on-first-use — capture
        // the leaf cert fingerprint during this one request, then pin to it forever after.
        val captured = AtomicReference<String?>(null)
        val api = KioskApi(PinnedHttp.tofuClient(captured))
        try {
            val resp = api.pair(url, code, name.ifBlank { "Kiosk" })
            val fingerprint = captured.get()
                ?: return@withContext PairResult.Failed(PairResult.Reason.CERT)

            store.savePairing(url, resp.deviceToken, resp.deviceId, fingerprint)
            log("info", "paired", "device ${resp.deviceId}")
            // Best-effort first config fetch so the attract screen personalises immediately.
            runCatching { fetchConfig() }
            PairResult.Success
        } catch (e: ApiException) {
            log("warn", "pair_rejected", "status ${e.status}")
            PairResult.Failed(rejectReason(e.status))
        } catch (e: IOException) {
            if (PinnedHttp.isCertMismatch(e)) PairResult.Failed(PairResult.Reason.CERT)
            else PairResult.Failed(PairResult.Reason.UNREACHABLE)
        } catch (_: Exception) {
            PairResult.Failed(PairResult.Reason.GENERIC)
        }
    }

    /** Clear the local pairing (revoke or volunteer-initiated re-pair). */
    suspend fun clearPairing() {
        store.clear()
        cachedClient.set(null)
        logBuffer.clear()
    }

    // ---- Heartbeat / config ------------------------------------------------------------

    suspend fun heartbeat(
        battery: Int?,
        charging: Boolean?,
        readerStatus: String,
        readerSerial: String? = null,
        readerBattery: Int? = null,
        // The live on-screen loop is foreground; the WorkManager backstop passes false so it never
        // consumes the server's one-shot "open update" flag (only the foreground loop can act on it).
        foreground: Boolean = true,
    ): HeartbeatOutcome = withContext(Dispatchers.IO) {
        val p = store.pairing.first() ?: return@withContext HeartbeatOutcome.NotPaired
        val localVersion = store.config.first()?.version ?: 0
        val api = KioskApi(pinnedClientFor(p.certSha256))
        try {
            val resp = api.heartbeat(
                baseUrl = p.serverUrl,
                token = p.deviceToken,
                appVersion = DeviceStatus.appVersion(appContext),
                configVersion = localVersion,
                battery = battery,
                charging = charging,
                readerStatus = readerStatus,
                readerSerial = readerSerial,
                readerBattery = readerBattery,
                foreground = foreground,
            )
            if (resp.revoked) {
                log("warn", "revoked")
                flushLogs() // try to deliver the revoke log before we wipe the token
                clearPairing()
                return@withContext HeartbeatOutcome.Revoked
            }
            if (resp.configVersion > localVersion) {
                runCatching { fetchConfig() }
            }
            HeartbeatOutcome.Ok(resp.identify, resp.latestAppVersion)
        } catch (e: IOException) {
            if (PinnedHttp.isCertMismatch(e)) HeartbeatOutcome.CertMismatch
            else HeartbeatOutcome.NetworkError
        } catch (_: Exception) {
            HeartbeatOutcome.NetworkError
        }
    }

    suspend fun fetchConfig() = withContext(Dispatchers.IO) {
        val p = store.pairing.first() ?: return@withContext
        val api = KioskApi(pinnedClientFor(p.certSha256))
        val cfg = api.getConfig(p.serverUrl, p.deviceToken)
        store.saveConfig(cfg)
    }

    // ---- Stripe Terminal connection token ----------------------------------------------

    /** Mint a short-lived Stripe Terminal connection token, server-side. Called by the reader's
     *  [com.stripe.stripeterminal.external.callable.ConnectionTokenProvider]. Throws if not paired
     *  or the server is unreachable — the SDK surfaces that as a reader error. */
    suspend fun getConnectionToken(): String = withContext(Dispatchers.IO) {
        val p = store.pairing.first() ?: throw IOException("Not paired")
        KioskApi(pinnedClientFor(p.certSha256)).connectionToken(p.serverUrl, p.deviceToken)
    }

    /** Download the server's bundled APK to a private cache file, so the app can update ITSELF via the
     *  system installer (no browser — see MainActivity.installApk). Uses the SAME pinned client as
     *  every other call (the /download route is public, needs no token). Returns the file, or null on
     *  any failure (the caller then falls back to opening the APK link in the browser). Fails soft. */
    suspend fun downloadUpdateApk(): File? = withContext(Dispatchers.IO) {
        val p = store.pairing.first() ?: return@withContext null
        val url = p.serverUrl.trimEnd('/') + "/download/openmasjidkiosk.apk"
        val req = Request.Builder().url(url).get().build()
        try {
            pinnedClientFor(p.certSha256).newCall(req).execute().use { resp ->
                val body = resp.body
                if (!resp.isSuccessful || body == null) return@withContext null
                // Overwrite any previous download; a fresh file each time avoids a stale/partial APK.
                val out = File(appContext.cacheDir, "update.apk")
                body.byteStream().use { input -> out.outputStream().use { input.copyTo(it) } }
                out
            }
        } catch (e: Exception) {
            null
        }
    }

    // ---- Donations (server validates the amount + verifies the payment) ────────────────

    /** Ask the server to create a card-present PaymentIntent for [amountMinor] (validated against
     *  the configured presets/limits server-side). [idempotencyKey] is stable per attempt so a
     *  network retry can't double-charge. */
    suspend fun createPaymentIntent(
        amountMinor: Long,
        campaignId: String?,
        donorName: String?,
        donorEmail: String?,
        monthly: Boolean,
        manual: Boolean,
        coverFees: Boolean,
        idempotencyKey: String,
    ): CreatedPaymentIntent = withContext(Dispatchers.IO) {
        val p = store.pairing.first() ?: throw IOException("Not paired")
        KioskApi(pinnedClientFor(p.certSha256))
            .createPaymentIntent(p.serverUrl, p.deviceToken, amountMinor, campaignId, donorName, donorEmail, monthly, manual, coverFees, idempotencyKey)
    }

    /** After the reader confirms, ask the server to verify + capture with Stripe and record the
     *  donation. The returned outcome is Stripe's truth, not the tablet's. */
    suspend fun completePaymentIntent(id: String): CompletedDonation = withContext(Dispatchers.IO) {
        val p = store.pairing.first() ?: throw IOException("Not paired")
        KioskApi(pinnedClientFor(p.certSha256)).completePaymentIntent(p.serverUrl, p.deviceToken, id)
    }

    // ---- Tuition (students/billing) — server holds the family/amount; the tablet never does ─────────

    /** Whether the tuition tile should show, and its school label (server-cached, fail-soft). */
    suspend fun tuitionInfo(): TuitionInfo = withContext(Dispatchers.IO) {
        val p = store.pairing.first() ?: throw IOException("Not paired")
        KioskApi(pinnedClientFor(p.certSha256)).tuitionInfo(p.serverUrl, p.deviceToken)
    }

    /** Resolve a student name + PIN to a family + balance (server-side; the PIN is in the body only). */
    suspend fun tuitionLookup(campaignId: String, name: String, pin: String): TuitionLookupResult = withContext(Dispatchers.IO) {
        val p = store.pairing.first() ?: throw IOException("Not paired")
        KioskApi(pinnedClientFor(p.certSha256)).tuitionLookup(p.serverUrl, p.deviceToken, campaignId, name, pin)
    }

    /** Mint the card-present tuition PaymentIntent for the full balance or the ticked invoices (the
     *  server recomputes the amount from its held session — the tablet only sends the selection). */
    suspend fun createTuitionPaymentIntent(session: String, payFull: Boolean, invoiceIds: List<String>, idempotencyKey: String): CreatedPaymentIntent = withContext(Dispatchers.IO) {
        val p = store.pairing.first() ?: throw IOException("Not paired")
        KioskApi(pinnedClientFor(p.certSha256)).createTuitionPaymentIntent(p.serverUrl, p.deviceToken, session, payFull, invoiceIds, idempotencyKey)
    }

    /** After the reader confirms, verify the tuition charge + record it into the Students ledger. */
    suspend fun completeTuitionPaymentIntent(id: String): CompletedTuition = withContext(Dispatchers.IO) {
        val p = store.pairing.first() ?: throw IOException("Not paired")
        KioskApi(pinnedClientFor(p.certSha256)).completeTuitionPaymentIntent(p.serverUrl, p.deviceToken, id)
    }


    // ---- Reader memory (auto-reconnect the same reader on boot) ────────────────────────

    /** Remember (blank transport = forget) the reader to auto-reconnect on boot. */
    suspend fun saveLastReader(transport: String, serial: String?) = store.saveLastReader(transport, serial)

    /** The last-connected reader as (transport, serial?) — or null if none. */
    suspend fun getLastReader(): Pair<String, String?>? = store.getLastReader()

    // ---- Campaign images (backgrounds / logos) -----------------------------------------
    // A few in-memory bitmaps for the campaign backgrounds/logos. Images on OUR server (/uploads or
    // the same host) are fetched over the PINNED client; an external https image uses a plain client
    // (it's presentation-only — never authenticated, never carries a token).
    private val imageCache = LruCache<String, Bitmap>(8)
    private val plainClient by lazy { OkHttpClient.Builder().build() }

    /** Download + decode a campaign image (cached). Returns null on any error (the UI falls back to
     *  the default look). [url] may be an absolute http(s) URL or a server-relative '/uploads/…' path. */
    suspend fun image(url: String): Bitmap? = withContext(Dispatchers.IO) {
        if (url.isBlank()) return@withContext null
        imageCache.get(url)?.let { return@withContext it }
        val p = store.pairing.first()
        val full: String
        val client: OkHttpClient
        when {
            url.startsWith("/") -> {
                val base = p?.serverUrl ?: return@withContext null
                full = base.trimEnd('/') + url
                client = pinnedClientFor(p.certSha256)
            }
            url.startsWith("http://", true) || url.startsWith("https://", true) -> {
                full = url
                client = if (p != null && sameHost(url, p.serverUrl)) pinnedClientFor(p.certSha256) else plainClient
            }
            else -> return@withContext null
        }
        val bmp = runCatching {
            client.newCall(Request.Builder().url(full).get().build()).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val body = resp.body ?: return@use null
                // Reject an oversized body BEFORE buffering it (protects the buffer allocation), then
                // read at most MAX bytes so a lying/absent Content-Length can't blow past the cap either.
                if (body.contentLength() > MAX_IMAGE_BYTES) return@use null
                val bytes = body.byteStream().use { readBounded(it, MAX_IMAGE_BYTES) } ?: return@use null
                // Downsample large images so the DECODED bitmap allocation is bounded too, regardless
                // of the source dimensions. (Keep ARGB_8888 so a logo's transparency survives.)
                val probe = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, probe)
                val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(probe.outWidth, probe.outHeight, 2048) }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
            }
        }.getOrNull()
        if (bmp != null) imageCache.put(url, bmp)
        bmp
    }

    /** Read up to [max] bytes; return null if the stream exceeds it (so a huge image can't OOM us). */
    private fun readBounded(input: java.io.InputStream, max: Long): ByteArray? {
        val out = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(16 * 1024)
        var total = 0L
        while (true) {
            val n = input.read(chunk)
            if (n < 0) break
            total += n
            if (total > max) return null
            out.write(chunk, 0, n)
        }
        return out.toByteArray()
    }

    /** Power-of-two downsample factor so the decoded image fits within ~[target]px on its long edge. */
    private fun sampleSize(w: Int, h: Int, target: Int): Int {
        if (w <= 0 || h <= 0) return 1
        var s = 1
        while (w / (s * 2) >= target || h / (s * 2) >= target) s *= 2
        return s
    }

    private fun sameHost(a: String, b: String): Boolean = runCatching {
        java.net.URI(a).host?.equals(java.net.URI(b).host, ignoreCase = true) == true
    }.getOrDefault(false)

    // ---- PIN ---------------------------------------------------------------------------

    /** Offline scrypt verification of the exit PIN against the last-synced config hash. */
    suspend fun verifyPin(pin: String, pinHash: String): Boolean = withContext(Dispatchers.Default) {
        ScryptPin.verify(pin, pinHash)
    }

    // ---- Logs --------------------------------------------------------------------------

    fun log(level: String, event: String, detail: String? = null) {
        logBuffer.add(LogEntry(level = level, event = event, detail = detail))
        // Keep the buffer bounded so an offline kiosk can't grow it without limit.
        while (logBuffer.size > MAX_BUFFERED_LOGS) logBuffer.poll()
    }

    suspend fun flushLogs() = withContext(Dispatchers.IO) {
        if (logBuffer.isEmpty()) return@withContext
        val p = store.pairing.first() ?: return@withContext
        val batch = ArrayList<LogEntry>()
        while (true) {
            val e = logBuffer.poll() ?: break
            batch.add(e)
            if (batch.size >= MAX_LOG_BATCH) break
        }
        if (batch.isEmpty()) return@withContext
        try {
            KioskApi(pinnedClientFor(p.certSha256)).postLogs(p.serverUrl, p.deviceToken, batch)
        } catch (_: Exception) {
            // Delivery failed — re-queue so we try again next flush (bounded above).
            batch.forEach { logBuffer.add(it) }
        }
    }

    private companion object {
        const val MAX_BUFFERED_LOGS = 200
        const val MAX_LOG_BATCH = 50
        const val MAX_IMAGE_BYTES = 8L * 1024 * 1024
    }
}
