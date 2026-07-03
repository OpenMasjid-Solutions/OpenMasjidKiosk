// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.kiosk

import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.openmasjidos.kiosk.KioskAdminReceiver

/**
 * Kiosk lockdown helpers (§10).
 *
 * Two tiers, best-effort and honest about their limits:
 *  1. DEVICE OWNER (provisioned once via ADB — see the summary / docs/TABLET_SETUP.md): we
 *     allow-list ourselves with [DevicePolicyManager.setLockTaskPackages] and enter true Lock
 *     Task Mode — no status bar, no recents, no home escape. This is the real kiosk.
 *  2. NOT DEVICE OWNER: [Activity.startLockTask] degrades to screen pinning, which shows a
 *     one-time system confirmation and is escapable by a deliberate gesture. We still apply it,
 *     plus keep-screen-on and immersive-sticky bars, so a casual passer-by can't wander off.
 *
 * We never crash if a call is not permitted — every OS call is guarded.
 */
object KioskController {

    /** Keep the screen awake and hide the system bars (immersive sticky). Safe to call often. */
    fun applyWindow(activity: Activity) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
    }

    /**
     * Enter kiosk lockdown. Idempotent: does nothing if already locked/pinned, so it is safe to
     * call from onResume without re-triggering the screen-pinning confirmation each time.
     */
    fun enterKiosk(activity: Activity) {
        applyWindow(activity)

        val dpm = activity.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
        if (dpm != null && dpm.isDeviceOwnerApp(activity.packageName)) {
            val admin = ComponentName(activity, KioskAdminReceiver::class.java)
            runCatching { dpm.setLockTaskPackages(admin, arrayOf(activity.packageName)) }
        }

        val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        if (am != null && am.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE) {
            // As device owner this is true Lock Task Mode; otherwise it degrades to screen pinning.
            runCatching { activity.startLockTask() }
        }
    }

    /** Leave kiosk lockdown (used by "Exit kiosk" on the maintenance screen). */
    fun exitKiosk(activity: Activity) {
        val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        if (am != null && am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE) {
            runCatching { activity.stopLockTask() }
        }
    }

    /** True when the tablet has been provisioned as device owner (real kiosk available). */
    fun isDeviceOwner(context: Context): Boolean {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
        return dpm?.isDeviceOwnerApp(context.packageName) == true
    }
}
