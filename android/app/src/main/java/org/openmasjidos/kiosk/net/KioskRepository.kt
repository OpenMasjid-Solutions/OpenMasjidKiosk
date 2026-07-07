// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.net

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import org.openmasjidos.kiosk.local.DeviceStore
import org.openmasjidos.kiosk.local.KioskConfig
import org.openmasjidos.kiosk.local.LogEntry
import org.openmasjidos.kiosk.local.PairingRecord
import org.openmasjidos.kiosk.kiosk.DeviceStatus
import org.openmasjidos.kiosk.security.ScryptPin
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
        val client = PinnedHttp.pinnedClient(fingerprint)
        cachedClient.set(fingerprint to client)
        return client
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

        // Trust-on-first-use: capture the leaf cert fingerprint during this one request, then
        // pin to it forever after.
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
            val reason = when (e.status) {
                400, 401, 403, 404, 409, 410, 422 -> PairResult.Reason.CODE_REJECTED
                else -> PairResult.Reason.GENERIC
            }
            PairResult.Failed(reason)
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

    // ---- Donations (server validates the amount + verifies the payment) ────────────────

    /** Ask the server to create a card-present PaymentIntent for [amountMinor] (validated against
     *  the configured presets/limits server-side). [idempotencyKey] is stable per attempt so a
     *  network retry can't double-charge. */
    suspend fun createPaymentIntent(
        amountMinor: Long,
        donorName: String?,
        donorEmail: String?,
        monthly: Boolean,
        manual: Boolean,
        idempotencyKey: String,
    ): CreatedPaymentIntent = withContext(Dispatchers.IO) {
        val p = store.pairing.first() ?: throw IOException("Not paired")
        KioskApi(pinnedClientFor(p.certSha256))
            .createPaymentIntent(p.serverUrl, p.deviceToken, amountMinor, donorName, donorEmail, monthly, manual, idempotencyKey)
    }

    /** After the reader confirms, ask the server to verify + capture with Stripe and record the
     *  donation. The returned outcome is Stripe's truth, not the tablet's. */
    suspend fun completePaymentIntent(id: String): CompletedDonation = withContext(Dispatchers.IO) {
        val p = store.pairing.first() ?: throw IOException("Not paired")
        KioskApi(pinnedClientFor(p.certSha256)).completePaymentIntent(p.serverUrl, p.deviceToken, id)
    }


    // ---- Reader memory (auto-reconnect the same reader on boot) ────────────────────────

    /** Remember (blank transport = forget) the reader to auto-reconnect on boot. */
    suspend fun saveLastReader(transport: String, serial: String?) = store.saveLastReader(transport, serial)

    /** The last-connected reader as (transport, serial?) — or null if none. */
    suspend fun getLastReader(): Pair<String, String?>? = store.getLastReader()

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
    }
}
