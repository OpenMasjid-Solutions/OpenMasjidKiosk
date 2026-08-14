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
 *     verified exit PIN. There is no OS gesture to escape it. Because that is absolute, tier 1 is
 *     applied ONLY while the kiosk is actually running (`locked`): an unpaired or re-pairing tablet
 *     is released, or it would be sealed on a screen that has no exit gesture (see [enterKiosk]).
 *  2. NOT DEVICE OWNER — the SOFT kiosk (no ADB, no computer). We are the HOME launcher, so Home
 *     returns to the kiosk; a re-launch-on-leave watchdog ([MainActivity.onUserLeaveHint]) brings us
 *     back if we're backgrounded; an opt-in accessibility helper closes the notification shade; and
 *     boot-into-app + keep-awake + immersive bars keep the tablet on the giving screen. The volunteer
 *     hides the navigation bar itself, which is what removes the Home/Recents buttons.
 *
 *     ANDROID SCREEN PINNING USED TO BE PART OF THIS AND WAS REMOVED. It existed only to block those
 *     nav-bar buttons, which hiding the bar already does — and it broke maintenance: a pinned app may
 *     not launch another package and Android refuses SILENTLY, so Settings, the permission prompts and
 *     the APK installer all appeared dead or were snatched away, and unpinning around each trip raced
 *     our own re-pin watchdogs. Device owner (tier 1) remains the only way to make the shade truly
 *     unreachable, and it has none of these problems.
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
     *
     * [locked] = a PAIRED kiosk that is not in a re-pair lockout, i.e. a screen a donor may actually
     * use. When it is false we RELEASE the lock on BOTH tiers, so the setup / re-pair screens (which
     * carry no donor flow, no configuration and their own plain Exit button) can never strand a
     * tablet. Pairing flips it back and re-locks on the next call.
     */
    fun enterKiosk(activity: Activity, locked: Boolean) {
        applyWindow(activity)

        val owner = dpmIfOwner(activity)
        if (owner != null && !locked) {
            // NOT a running kiosk (setup screen, or a cert-mismatch re-pair lockout). Release Lock
            // Task and give the status bar back, exactly as the soft-kiosk branch below does.
            //
            // This is the difference between "recoverable" and "needs ADB": with LOCK_TASK_FEATURE_NONE
            // there is no Home, no Recents, no shade and no power menu, and the only in-app way out —
            // the 10-tap maintenance gesture — lives on the PAIRED giving screen. So a device-owner
            // tablet that is unpaired (never set up, or freshly REVOKED by an admin) would otherwise be
            // sealed shut on a screen with no exit at all. Nothing is lost by unlocking: there is no
            // donor flow and no configuration on those screens. We stay the persistent HOME, so the
            // kiosk still owns the Home button and still comes back after a reboot, and pairing
            // re-locks everything on the very next call.
            val (dpm, admin) = owner
            runCatching { dpm.setStatusBarDisabled(admin, false) }
            val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            if (am != null && am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE) {
                runCatching { activity.stopLockTask() }
            }
        } else if (owner != null) {
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
                // Allow-list SETTINGS and the package installer too. Maintenance drops Lock Task before
                // opening either, so this is not the primary mechanism — it is the safety net for the
                // case that made "Open Android Settings" look broken: if the unpin hasn't taken effect
                // by the time we start the activity, a non-allow-listed package is refused SILENTLY,
                // with no error and no visible change. Allow-listing costs nothing in security terms —
                // these can only be launched from behind the maintenance PIN, never by a donor.
                runCatching {
                    val pm = activity.packageManager
                    pm.resolveActivity(Intent(android.provider.Settings.ACTION_SETTINGS), PackageManager.MATCH_DEFAULT_ONLY)
                        ?.activityInfo?.packageName?.let { pkgs.add(it) }
                    val install = Intent(Intent.ACTION_VIEW).setDataAndType(
                        android.net.Uri.parse("file:///dummy.apk"),
                        "application/vnd.android.package-archive",
                    )
                    pm.resolveActivity(install, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName?.let { pkgs.add(it) }
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
        } else {
            // SOFT KIOSK — no device owner, no ADB, no computer.
            //
            // WE NO LONGER USE ANDROID SCREEN PINNING. It was here for exactly one reason: to block the
            // Home and Recents buttons on the navigation bar. On these installs the volunteer hides the
            // navigation bar itself, so pinning was buying nothing that the bar being gone doesn't
            // already give — while costing a great deal. A pinned app may not start another package,
            // and Android refuses SILENTLY, so every maintenance route out (Android Settings, the
            // permission prompts, the "allow installs" screen, the APK installer) either did nothing or
            // flickered and was snatched back. Unpinning around each excursion turned into a race with
            // our own re-pin watchdogs, and getting out by hand needs a device PIN a volunteer often
            // doesn't have. It made the tablet hard to maintain and never made it meaningfully harder
            // for a donor to escape.
            //
            // What holds the kiosk on screen instead, all of it already here and none of it fighting
            // the maintainer: we are the HOME launcher (Home returns to the kiosk), the leave-watchdog
            // relaunches us if we are backgrounded, the shade-guard helper closes the notification shade
            // if the volunteer opts in, immersive-sticky hides the bars, and the screen is kept awake.
            // A tablet that needs a HARD lock should be provisioned as device owner (tier 1 above),
            // which is the only way to make the shade truly unreachable and does not have any of these
            // problems.
            //
            // Anything this app pinned in a PREVIOUS version must still be released, or a tablet
            // updating into this build would stay pinned for ever with nothing left to unpin it.
            val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            if (am != null && am.lockTaskModeState == ActivityManager.LOCK_TASK_MODE_PINNED) {
                runCatching { activity.stopLockTask() }
            }
        }

        // Re-assert immersive LAST: entering Lock Task / screen pinning (or a just-granted HOME role)
        // can momentarily re-show the status/navigation bars, so hide them again after all the above.
        applyWindow(activity)

        // Let the (opt-in) shade-guard accessibility service close the notification shade — but ONLY
        // while the kiosk is actually LOCKED (paired, not re-pairing), so it never fights the shade on
        // the pairing / re-pair screens or after the maintainer has stepped out.
        ShadeGuard.active = locked
    }

    /** Leave kiosk lockdown (used by "Exit kiosk" after a verified PIN, and momentarily to open the
     *  browser for an app update). Restores the status bar so the maintainer can use the tablet. */
    fun exitKiosk(activity: Activity) {
        // Stop guarding the shade first — the maintainer (in Settings / the installer) must be able to
        // use it; onResume re-arms it when the kiosk re-locks.
        ShadeGuard.active = false
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
        ShadeGuard.active = false // fully leaving — never keep guarding the shade
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
