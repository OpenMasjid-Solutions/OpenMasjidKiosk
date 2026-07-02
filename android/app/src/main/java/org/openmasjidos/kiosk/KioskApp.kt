// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk

import android.app.Application

/**
 * Application entry point. Empty for now; later slices will use it to initialise
 * app-wide state (device config store, heartbeat scheduling, the Stripe Terminal SDK).
 */
class KioskApp : Application()
