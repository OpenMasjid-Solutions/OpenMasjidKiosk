// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk

import android.app.Application
import com.stripe.stripeterminal.TerminalApplicationDelegate
import org.openmasjidos.kiosk.net.KioskRepository

/**
 * Application entry point.
 *
 * Owns the single [KioskRepository] instance so both the UI (ViewModel) and the background
 * [org.openmasjidos.kiosk.work.HeartbeatWorker] share one store, one log buffer and one pinned
 * HTTP client cache.
 *
 * Slice 5: the Stripe Terminal SDK requires the app to forward Application lifecycle callbacks
 * to [TerminalApplicationDelegate]. This only wires the delegate — the Terminal instance itself
 * is created lazily by [org.openmasjidos.kiosk.readers.ReaderManager] the first time an admin
 * opens the reader settings (so an un-paired / not-yet-configured kiosk does nothing Stripe-y).
 */
class KioskApp : Application() {

    /** Lazily built so it exists for both the foreground loop and the WorkManager backstop. */
    val repository: KioskRepository by lazy { KioskRepository(this) }

    override fun onCreate() {
        super.onCreate()
        // The Terminal SDK (5.x) only needs onCreate forwarded; it manages memory itself.
        TerminalApplicationDelegate.onCreate(this)
    }
}
