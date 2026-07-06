// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.readers

import com.stripe.stripeterminal.Terminal
import com.stripe.stripeterminal.external.callable.Callback
import com.stripe.stripeterminal.external.callable.Cancelable
import com.stripe.stripeterminal.external.callable.PaymentIntentCallback
import com.stripe.stripeterminal.external.models.PaymentIntent
import com.stripe.stripeterminal.external.models.TerminalException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Drives the Stripe Terminal collect + confirm for a single donation, bridging the SDK's
 * callback API to suspend functions so the giving flow reads top-to-bottom.
 *
 * The tablet never sees card data — the reader + SDK handle it end to end. All we ever get back is
 * a PaymentIntent **id**, which the SERVER re-verifies with Stripe before recording anything.
 */
object PaymentController {

    @Volatile private var collectCancelable: Cancelable? = null

    /** retrieve(clientSecret) → collectPaymentMethod (reader prompts tap/insert/swipe) →
     *  confirmPaymentIntent. Returns the confirmed PaymentIntent id; throws [TerminalException]
     *  on failure or cancellation. */
    suspend fun collectAndConfirm(clientSecret: String): String {
        val pi = retrieve(clientSecret)
        val collected = collect(pi)
        val confirmed = confirm(collected)
        return confirmed.id
    }

    /** Cancel an in-progress card collection (donor pressed cancel / timed out back to attract). */
    fun cancelCollect() {
        collectCancelable?.let { c ->
            runCatching {
                if (!c.isCompleted) {
                    c.cancel(object : Callback {
                        override fun onSuccess() {}
                        override fun onFailure(e: TerminalException) {}
                    })
                }
            }
        }
        collectCancelable = null
    }

    private suspend fun retrieve(clientSecret: String): PaymentIntent =
        suspendCancellableCoroutine { cont ->
            Terminal.getInstance().retrievePaymentIntent(clientSecret, object : PaymentIntentCallback {
                override fun onSuccess(paymentIntent: PaymentIntent) = cont.resume(paymentIntent)
                override fun onFailure(e: TerminalException) = cont.resumeWithException(e)
            })
        }

    private suspend fun collect(pi: PaymentIntent): PaymentIntent =
        suspendCancellableCoroutine { cont ->
            collectCancelable = Terminal.getInstance().collectPaymentMethod(pi, object : PaymentIntentCallback {
                override fun onSuccess(paymentIntent: PaymentIntent) {
                    collectCancelable = null
                    cont.resume(paymentIntent)
                }
                override fun onFailure(e: TerminalException) {
                    collectCancelable = null
                    cont.resumeWithException(e)
                }
            })
            cont.invokeOnCancellation { cancelCollect() }
        }

    private suspend fun confirm(pi: PaymentIntent): PaymentIntent =
        suspendCancellableCoroutine { cont ->
            Terminal.getInstance().confirmPaymentIntent(pi, object : PaymentIntentCallback {
                override fun onSuccess(paymentIntent: PaymentIntent) = cont.resume(paymentIntent)
                override fun onFailure(e: TerminalException) = cont.resumeWithException(e)
            })
        }
}
