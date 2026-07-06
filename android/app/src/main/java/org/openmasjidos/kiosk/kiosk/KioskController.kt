// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.kiosk

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.view.WindowManager
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.openmasjidos.kiosk.KioskAdminReceiver
import org.openmasjidos.kiosk.MainActivity

/**
 * Kiosk lockdown helpers (§10).
 *
 * Two tiers, honest about their limits:
 *  1. DEVICE OWNER (provisioned once via ADB — see docs/TABLET_SETUP.md) — the REAL kiosk. We
 *     allow-list ourselves and enter true **Lock Task Mode**, then lock it down further: the status
 *     bar is disabled (no notification shade / quick-settings pulldown), lock-task features are set
 *     to HOME-only (Home returns to us; recents / global power menu / system info / notifications are
 *     all blocked), and we register as the persistent HOME so Home always lands back on the kiosk.
 *     In this mode the ONLY way out is this app calling [exitKiosk] — which happens solely behind the
 *     verified exit PIN. There is no OS gesture to escape it.
 *  2. NOT DEVICE OWNER: [Activity.startLockTask] degrades to **screen pinning**, which the OS lets a
 *     determined user escape (swipe + confirm) and does NOT block the notification shade. We still
 *     apply it + keep-awake + immersive bars as a best effort, but a truly locked, un-leavable kiosk
 *     REQUIRES device-owner provisioning. The maintenance screen says so when we're not device owner.
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

    private fun dpmIfOwner(context: Context): Pair<DevicePolicyManager, ComponentName>? {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager ?: return null
        if (!dpm.isDeviceOwnerApp(context.packageName)) return null
        return dpm to ComponentName(context, KioskAdminReceiver::class.java)
    }

    /**
     * One-time device-owner provisioning of the persistent HOME (call from onCreate). Makes this app
     * the default launcher so pressing Home — the classic "escape" — always reopens the kiosk. No-op
     * unless we're device owner. Cleared by [releaseHome] when a maintainer exits.
     */
    fun provisionHome(activity: Activity) {
        val (dpm, admin) = dpmIfOwner(activity) ?: return
        runCatching {
            dpm.clearPackagePersistentPreferredActivities(admin, activity.packageName)
            val filter = IntentFilter(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME)
                addCategory(Intent.CATEGORY_DEFAULT)
            }
            dpm.addPersistentPreferredActivity(admin, filter, ComponentName(activity, MainActivity::class.java))
        }
    }

    /**
     * Enter kiosk lockdown. Idempotent: safe to call from onResume. As device owner this is true Lock
     * Task Mode with the status bar disabled and HOME-only features; otherwise it degrades to screen
     * pinning (escapable — see the class note).
     */
    fun enterKiosk(activity: Activity) {
        applyWindow(activity)

        dpmIfOwner(activity)?.let { (dpm, admin) ->
            runCatching { dpm.setLockTaskPackages(admin, arrayOf(activity.packageName)) }
            // Allow Home (→ us) but block the notification shade, recents, the power menu and system
            // info from within Lock Task. (setLockTaskFeatures is API 28+.)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                runCatching { dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_HOME) }
            }
            // Belt-and-braces: kill the status bar entirely so the notification shade / quick settings
            // can't be pulled down at all while the kiosk runs.
            runCatching { dpm.setStatusBarDisabled(admin, true) }
        }

        val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        if (am != null && am.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE) {
            runCatching { activity.startLockTask() }
        }
    }

    /** Leave kiosk lockdown (used by "Exit kiosk" after a verified PIN, and momentarily to open the
     *  browser for an app update). Restores the status bar so the maintainer can use the tablet. */
    fun exitKiosk(activity: Activity) {
        dpmIfOwner(activity)?.let { (dpm, admin) ->
            runCatching { dpm.setStatusBarDisabled(admin, false) }
        }
        val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        if (am != null && am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE) {
            runCatching { activity.stopLockTask() }
        }
    }

    /** Fully hand the tablet back (device-owner "Exit kiosk"): also drop the persistent HOME so the
     *  maintainer can reach the real launcher. onResume re-locks until this is called. */
    fun releaseHome(activity: Activity) {
        val (dpm, admin) = dpmIfOwner(activity) ?: return
        runCatching { dpm.clearPackagePersistentPreferredActivities(admin, activity.packageName) }
    }

    /**
     * Device owner: silently grant the reader's discovery permission (location, and Bluetooth on
     * 31+) so a USB reader auto-connects with no dialog on a locked-down kiosk. No-op if not device
     * owner — a non-owner tablet is asked for location once at startup instead (see MainActivity).
     */
    fun grantReaderPermissions(activity: Activity) {
        val (dpm, admin) = dpmIfOwner(activity) ?: return
        val perms = listOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.BLUETOOTH_SCAN,
        )
        perms.forEach { p ->
            runCatching {
                dpm.setPermissionGrantState(admin, activity.packageName, p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
            }
        }
    }

    /** True when the tablet has been provisioned as device owner (real kiosk available). */
    fun isDeviceOwner(context: Context): Boolean {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as? DevicePolicyManager
        return dpm?.isDeviceOwnerApp(context.packageName) == true
    }
}
