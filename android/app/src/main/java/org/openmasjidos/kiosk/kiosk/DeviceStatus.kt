// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.kiosk

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager

/** A point-in-time battery reading for heartbeats and the diagnostics screen. */
data class BatterySnapshot(val level: Int?, val charging: Boolean?)

/**
 * Reads device health without any special permission. Battery state comes from the sticky
 * ACTION_BATTERY_CHANGED broadcast, so a wall kiosk can report "not charging" (a fallen cable)
 * to the admin. The reader's status is added in slice 5.
 */
object DeviceStatus {

    fun battery(context: Context): BatterySnapshot {
        val intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?: return BatterySnapshot(null, null)

        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val pct = if (level >= 0 && scale > 0) (level * 100) / scale else null

        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val charging = when (status) {
            -1 -> null
            BatteryManager.BATTERY_STATUS_CHARGING, BatteryManager.BATTERY_STATUS_FULL -> true
            else -> false
        }
        return BatterySnapshot(pct, charging)
    }

    /** The app's own versionName via PackageManager (avoids needing the BuildConfig feature). */
    fun appVersion(context: Context): String = runCatching {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0.0.0"
    }.getOrDefault("0.0.0")
}
