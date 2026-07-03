// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.work

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import org.openmasjidos.kiosk.KioskApp
import org.openmasjidos.kiosk.kiosk.DeviceStatus
import org.openmasjidos.kiosk.net.HeartbeatOutcome
import org.openmasjidos.kiosk.readers.ReaderManager
import java.util.concurrent.TimeUnit

/**
 * The heartbeat BACKSTOP.
 *
 * The tablet's live ~45s cadence is driven by a foreground coroutine in the ViewModel while the
 * kiosk is on screen (which, for a wall device, is nearly always). WorkManager's minimum periodic
 * interval is 15 minutes, so this worker can't hit 45s — its job is liveness: even if the app is
 * backgrounded or the foreground loop dies, we still check in, pick up config changes, and — most
 * importantly — notice a REVOKE so a removed kiosk stops itself.
 */
class HeartbeatWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val repo = (applicationContext as KioskApp).repository
        val battery = DeviceStatus.battery(applicationContext)
        val reader = ReaderManager.statusForHeartbeat()
        return when (repo.heartbeat(
            battery.level,
            battery.charging,
            readerStatus = reader.status,
            readerSerial = reader.serial,
            readerBattery = reader.battery,
        )) {
            is HeartbeatOutcome.Ok,
            HeartbeatOutcome.Revoked,
            HeartbeatOutcome.NotPaired,
            HeartbeatOutcome.CertMismatch -> {
                repo.flushLogs()
                Result.success()
            }
            // Transient LAN/internet blip — let WorkManager retry with backoff.
            HeartbeatOutcome.NetworkError -> Result.retry()
        }
    }

    companion object {
        private const val UNIQUE_NAME = "kiosk-heartbeat"

        /** Schedule (or keep) the periodic backstop. Safe to call every launch. */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<HeartbeatWorker>(15L, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                UNIQUE_NAME,
                // KEEP: don't reset the schedule on every process start.
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }
    }
}
