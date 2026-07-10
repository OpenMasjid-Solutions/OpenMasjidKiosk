// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import android.annotation.SuppressLint
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.openmasjidos.kiosk.ManualResult

/**
 * Keyed / typed card entry via Stripe.js Payment Element in an in-app WebView (the OpenMasjidDonations
 * approach). The page is served LOCALLY over https://appassets.androidplatform.net by
 * [WebViewAssetLoader], so it runs inside our own (Lock-Task allow-listed) activity and never launches
 * an external browser — card authentication (3-D Secure) renders in an iframe on the page. That's why
 * this works on a device-owner kiosk where Stripe's PaymentSheet (which opens a Chrome Custom Tab for
 * 3DS/Link) silently could not. The PAN is entered into Stripe's iframe + tokenised on-device; our
 * code never sees it, and the VM still verifies the PaymentIntent server-side before recording.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun ManualCardWebView(
    clientSecret: String,
    publishableKey: String,
    accentHex: String,
    payLabel: String,
    amountLabel: String,
    onResult: (ManualResult, String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val loader = remember {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()
    }
    AndroidView(
        modifier = modifier.fillMaxSize(),
        factory = { ctx ->
            WebView(ctx).apply {
                // Opaque dark backdrop (matches kioskpay.html) so the giving screen never shows
                // through and there's no white flash before the page paints.
                setBackgroundColor(0xFF071726.toInt())
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                webViewClient = object : WebViewClientCompat() {
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                        loader.shouldInterceptRequest(request.url)
                }
                addJavascriptInterface(
                    object {
                        // Called by kioskpay.html on a JS thread → marshal to the UI thread via post{}.
                        @JavascriptInterface
                        fun onResult(status: String, detail: String) {
                            post {
                                when (status) {
                                    "completed" -> onResult(ManualResult.Completed, detail)
                                    "failed" -> onResult(ManualResult.Failed, detail)
                                    else -> onResult(ManualResult.Canceled, null)
                                }
                            }
                        }
                    },
                    "KioskPay",
                )
                val frag = "#cs=" + Uri.encode(clientSecret) +
                    "&pk=" + Uri.encode(publishableKey) +
                    "&ac=" + Uri.encode(accentHex) +
                    "&pay=" + Uri.encode(payLabel) +
                    "&amt=" + Uri.encode(amountLabel)
                loadUrl("https://appassets.androidplatform.net/assets/kioskpay.html$frag")
            }
        },
    )
}
