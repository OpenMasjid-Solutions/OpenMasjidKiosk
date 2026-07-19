// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.net

import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Builds the OkHttp clients the kiosk uses to talk to its server over HTTPS.
 *
 * SECURITY MODEL — why this is hand-rolled rather than OkHttp's [okhttp3.CertificatePinner]:
 * the OpenMasjidOS platform serves each app over HTTPS with a *self-signed* certificate for the
 * LAN, addressed by IP. OkHttp's CertificatePinner only runs AFTER the default trust manager has
 * already validated the chain against the system CA store — a self-signed cert fails that step
 * first, so the pinner never gets a say. Instead we install our OWN [X509TrustManager] as the
 * sole trust anchor. It ignores the system CA store entirely and trusts exactly one fingerprint,
 * which is stronger for this threat model (a fixed, known LAN peer) than public-CA validation.
 *
 * Two clients exist:
 *  - [tofuClient]: used ONLY for the very first `pair` request (trust-on-first-use). It accepts
 *    whatever certificate the server presents and records its fingerprint, which we then persist.
 *  - [pinnedClient]: used for EVERY other call. It accepts ONLY the persisted fingerprint and
 *    fails closed (throws) on any mismatch — the server rotating its cert means "re-pair needed",
 *    surfaced to the admin, never a silent downgrade.
 *
 * Both clients refuse plain HTTP by construction: the caller only ever passes https:// URLs, and
 * there is no cleartext fallback anywhere in the app.
 */
object PinnedHttp {

    /** SHA-256 of a certificate's DER encoding, as lowercase hex with no separators. */
    fun fingerprint(cert: X509Certificate): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(cert.encoded)
        return digest.joinToString("") { "%02x".format(it.toInt() and 0xFF) }
    }

    /**
     * First-use client: captures the leaf certificate fingerprint into [captured] and accepts the
     * connection. This is intentional TOFU — the volunteer is standing at the tablet typing the
     * pairing code, and the fingerprint we capture here becomes the pin for all future traffic.
     */
    fun tofuClient(captured: AtomicReference<String?>): OkHttpClient {
        val trustManager = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                val leaf = chain?.firstOrNull()
                    ?: throw CertificateException("Server presented no certificate")
                // Record, then accept — this is the one moment we trust on first use.
                captured.set(fingerprint(leaf))
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        return build(trustManager)
    }

    /**
     * Pinned client: trusts ONLY [pinnedSha256]. Any other certificate (including a valid,
     * publicly-trusted one) is rejected, so a MITM cannot substitute its own cert and the app
     * never silently accepts a rotated server cert.
     */
    fun pinnedClient(pinnedSha256: String): OkHttpClient {
        val expected = pinnedSha256.lowercase()
        val trustManager = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                val leaf = chain?.firstOrNull()
                    ?: throw CertificateException("Server presented no certificate")
                val actual = fingerprint(leaf)
                // Constant-time comparison, and a distinctive message so callers can detect a
                // pin mismatch (→ "re-pair needed") versus an ordinary network failure.
                val match = MessageDigest.isEqual(
                    actual.toByteArray(Charsets.US_ASCII),
                    expected.toByteArray(Charsets.US_ASCII),
                )
                if (!match) throw CertificateException(CERT_PIN_MISMATCH)
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        return build(trustManager)
    }

    /** Sentinel stored in place of a pinned fingerprint when the server has a REAL, publicly-trusted
     *  certificate — a remotely-adopted kiosk reached over the OpenMasjidOS Cloudflare tunnel. Traffic
     *  then uses [systemClient] (system-CA validation + hostname verification), and the server's cert
     *  may rotate freely (no re-pair on renewal). Non-blank, so it satisfies DeviceStore's "a paired
     *  record must carry a cert" invariant. */
    const val SYSTEM_TRUST = "system"

    /**
     * Client for a server with a real, publicly-trusted certificate (e.g. Cloudflare in front of the
     * OS tunnel, for remote adoption). Ordinary system-CA trust + REAL hostname verification — NOT the
     * accept-anything TOFU path and NOT a fixed pin. Correct for a public domain: the cert must chain
     * to a system CA AND match the typed hostname, so a MITM can't substitute its own. Longer timeouts
     * than the LAN clients since it crosses the internet.
     */
    fun systemClient(): OkHttpClient =
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .callTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()

    private fun build(trustManager: X509TrustManager): OkHttpClient {
        val sslContext = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf<TrustManager>(trustManager), SecureRandom())
        }
        return OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            // Hostname verification is meaningless for a self-signed cert addressed by LAN IP:
            // the certificate PIN above is our sole, stronger trust anchor. We never fall back
            // to system CAs and never speak plain HTTP.
            .hostnameVerifier { _, _ -> true }
            // Fabric/LAN timeouts kept short so a slow or absent server fails soft quickly.
            .connectTimeout(4, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .writeTimeout(8, TimeUnit.SECONDS)
            .callTimeout(12, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()
    }

    /** Marker message thrown when the pinned fingerprint does not match the presented cert. */
    const val CERT_PIN_MISMATCH = "openmasjid_pinned_certificate_mismatch"

    /** True if [t] (or any cause) is our pin-mismatch signal. */
    fun isCertMismatch(t: Throwable?): Boolean {
        var cause = t
        while (cause != null) {
            if (cause is CertificateException && cause.message == CERT_PIN_MISMATCH) return true
            cause = cause.cause
        }
        return false
    }
}
