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
import android.content.pm.PackageManager
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
 *  2. NOT DEVICE OWNER: we do NOT use screen pinning (it shows a confirmation, is escapable by a
 *     swipe+hold, and doesn't block the notification shade). Instead we act like a real single-app
 *     kiosk — the HOME launcher + a re-launch-on-leave watchdog ([MainActivity.onUserLeaveHint])
 *     bounce the user back in whenever they press Home/Recents, and we boot straight into the app +
 *     keep-awake + immersive bars. Android still can't fully block the shade/settings without device
 *     owner, so a truly un-leavable kiosk REQUIRES it. The maintenance screen says so.
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

        val owner = dpmIfOwner(activity)
        if (owner != null) {
            val (dpm, admin) = owner
            // Allow-list OUR package + the device's browser(s). The browser is needed so Stripe's card
            // authentication (3DS) can open its Chrome Custom Tab during a KEYED card payment — a
            // device-owner Lock Task kiosk silently blocks launching any non-allow-listed package, which
            // is why keyed entry couldn't confirm before (tap-to-pay is in-process, so it was fine). The
            // Custom Tab has no address bar and auto-returns, so this doesn't create an escape route.
            runCatching {
                val pkgs = linkedSetOf(activity.packageName)
                runCatching {
                    val pm = activity.packageManager
                    val view = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("https://stripe.com"))
                    pm.resolveActivity(view, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName?.let { pkgs.add(it) }
                    pm.queryIntentActivities(view, 0).forEach { it.activityInfo?.packageName?.let { p -> pkgs.add(p) } }
                }
                dpm.setLockTaskPackages(admin, pkgs.toTypedArray())
            }
            // Lock EVERYTHING down: Home, recents, the notification shade, the power menu and system
            // info are all disabled in Lock Task — you can't even press Home. (setLockTaskFeatures is
            // API 28+; LOCK_TASK_FEATURE_NONE is the most restrictive set.)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                runCatching { dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE) }
            }
            // Belt-and-braces: kill the status bar entirely so the notification shade / quick settings
            // can't be pulled down at all while the kiosk runs.
            runCatching { dpm.setStatusBarDisabled(admin, true) }
            val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            if (am != null && am.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE) {
                runCatching { activity.startLockTask() }
            }
        }
        // NOT device owner: we deliberately do NOT screen-pin. Pinning shows a confirmation, is
        // escapable by a swipe+hold, and is exactly the "app pinning" that doesn't hold. Instead the
        // HOME launcher + the re-launch-on-leave watchdog (MainActivity.onUserLeaveHint) bounce the
        // user back into the kiosk whenever they try to leave. A fully un-leavable kiosk that also
        // blocks the notification shade still requires device-owner provisioning (docs/TABLET_SETUP.md).
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
     * Fully leave kiosk mode (the maintenance "Exit kiosk" button). Stops Lock Task, re-enables the
     * status bar, and — as device owner — hands the HOME role to the device's OWN launcher so we
     * actually leave. Just *clearing* our forced-HOME isn't enough: this app is still a registered
     * HOME app (CATEGORY_HOME in the manifest, so a wall tablet boots into the kiosk), so with no
     * preference set the system either reopens us or shows a chooser we bounce out of. The definitive
     * fix is to point the persistent HOME preference at ANOTHER launcher on the device — then pressing
     * Home lands on the real Android launcher, not the kiosk. Re-arming the kiosk (reopening the app)
     * calls [provisionHome], which flips the preference back to us.
     *
     * Returns true if we were device owner and handed HOME to another launcher (caller then navigates
     * HOME); false if not device owner (Android won't let a plain app change the default launcher, so
     * the caller opens the Home-app picker instead). onResume won't re-lock because the caller sets
     * its `exiting` guard.
     */
    fun exitKioskFully(activity: Activity): Boolean {
        val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        if (am != null && am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE) {
            runCatching { activity.stopLockTask() }
        }
        val owner = dpmIfOwner(activity) ?: return false
        val (dpm, admin) = owner
        runCatching { dpm.setStatusBarDisabled(admin, false) }
        runCatching { dpm.clearPackagePersistentPreferredActivities(admin, activity.packageName) }
        // Find the device's OTHER launcher (any HOME activity that isn't us) and make IT the persistent
        // HOME, so pressing Home leaves the kiosk for the real launcher instead of reopening us.
        runCatching {
            val homeIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
            val other = activity.packageManager
                .queryIntentActivities(homeIntent, PackageManager.MATCH_DEFAULT_ONLY)
                .map { it.activityInfo }
                .firstOrNull { it.packageName != activity.packageName }
            if (other != null) {
                val filter = IntentFilter(Intent.ACTION_MAIN).apply {
                    addCategory(Intent.CATEGORY_HOME)
                    addCategory(Intent.CATEGORY_DEFAULT)
                }
                dpm.addPersistentPreferredActivity(admin, filter, ComponentName(other.packageName, other.name))
            }
        }
        return true
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
