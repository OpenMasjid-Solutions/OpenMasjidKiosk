// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Brings the kiosk back up after a reboot so a wall tablet self-heals without a human.
 * This works even when the app is not provisioned as device owner. Lock-task hardening
 * is layered on top in a later slice.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            val launch = Intent(context, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(launch)
        }
    }
}
