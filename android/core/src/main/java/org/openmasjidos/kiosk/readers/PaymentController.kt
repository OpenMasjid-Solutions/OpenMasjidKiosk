// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.readers

import com.stripe.stripeterminal.Terminal
import com.stripe.stripeterminal.external.callable.Callback
import com.stripe.stripeterminal.external.callable.Cancelable
import com.stripe.stripeterminal.external.callable.PaymentIntentCallback
import com.stripe.stripeterminal.external.models.AllowRedisplay
import com.stripe.stripeterminal.external.models.CollectPaymentIntentConfiguration
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

    /**
     * retrieve(clientSecret) → collectPaymentMethod (reader prompts tap/insert/swipe) →
     * confirmPaymentIntent. Returns the confirmed PaymentIntent id; throws [TerminalException]
     * on failure or cancellation.
     *
     * [savingCard] must be true whenever the PaymentIntent was created with `setup_future_usage`,
     * i.e. a MONTHLY donation. Terminal then requires the collect to state how the donor allows the
     * saved card to be shown again, and refuses the command outright without it:
     *
     *     TerminalException: This command requires allow_redisplay to be set as always or limited
     *                        when saving payment methods with Terminal.
     *
     * That refusal is immediate, so the reader never prompts at all — which is exactly the reported
     * "monthly errors without even asking to tap". It is a CLIENT-side requirement: nothing the
     * server puts on the intent can satisfy it, which is why fixing setup_future_usage server-side
     * (dev.12) got us a correctly-configured intent that the tablet then couldn't collect.
     */
    suspend fun collectAndConfirm(clientSecret: String, savingCard: Boolean = false): String {
        val pi = retrieve(clientSecret)
        val collected = collect(pi, savingCard)
        val confirmed = confirm(collected)
        // The SDK types the id as nullable; a confirmed PI always has one. Treat a null as failure
        // (the caller runCatching { … } maps the thrown error to the "try again" path).
        return confirmed.id ?: error("Confirmed payment has no id")
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

    private suspend fun collect(pi: PaymentIntent, savingCard: Boolean): PaymentIntent =
        suspendCancellableCoroutine { cont ->
            // ALWAYS rather than LIMITED: the donor has deliberately chosen to give monthly, so this
            // masjid may charge the card again off-session for as long as the plan runs. LIMITED
            // restricts reuse to flows the customer starts themselves, which a standing order is not.
            val config = CollectPaymentIntentConfiguration.Builder()
                .setAllowRedisplay(if (savingCard) AllowRedisplay.ALWAYS else AllowRedisplay.UNSPECIFIED)
                .build()
            collectCancelable = Terminal.getInstance().collectPaymentMethod(pi, object : PaymentIntentCallback {
                override fun onSuccess(paymentIntent: PaymentIntent) {
                    collectCancelable = null
                    cont.resume(paymentIntent)
                }
                override fun onFailure(e: TerminalException) {
                    collectCancelable = null
                    cont.resumeWithException(e)
                }
            }, config)
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
