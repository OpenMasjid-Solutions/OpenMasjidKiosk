// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk

import android.app.Application
import org.openmasjidos.kiosk.net.KioskRepository

/**
 * Application entry point.
 *
 * Owns the single [KioskRepository] instance so both the UI (ViewModel) and the background
 * [org.openmasjidos.kiosk.work.HeartbeatWorker] share one store, one log buffer and one pinned
 * HTTP client cache. The Stripe Terminal SDK will also be initialised here in a later slice.
 */
class KioskApp : Application() {

    /** Lazily built so it exists for both the foreground loop and the WorkManager backstop. */
    val repository: KioskRepository by lazy { KioskRepository(this) }
}
