// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk

import android.Manifest
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import org.openmasjidos.kiosk.kiosk.KioskController
import org.openmasjidos.kiosk.readers.ReaderManager
import org.openmasjidos.kiosk.ui.KioskRoot
import org.openmasjidos.kiosk.ui.theme.SakinaTheme

/**
 * The single kiosk activity, and the device HOME launcher (see AndroidManifest), so a wall tablet
 * boots straight into the kiosk.
 *
 * Slice 4 wires the full state machine: pairing → attract, the hidden-gesture PIN unlock, the
 * maintenance screen, heartbeats, and kiosk lockdown. Lock Task Mode is re-asserted on every
 * resume (idempotently) so returning from maintenance re-locks the device.
 */
class MainActivity : ComponentActivity() {

    private val vm: KioskViewModel by viewModels()

    /** Set true only for a deliberate departure (PIN-verified exit) so the leave-watchdog lets go. */
    private var exiting = false

    // A USB reader needs the location permission to be discovered. On a device-owner kiosk it's
    // granted silently; otherwise we ask once at startup and, on grant, kick the auto-connect.
    private val readerPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) ReaderManager.retryAutoConnect()
        }

    // Result of asking to become the default Home app (so pressing Home returns straight to the
    // kiosk with no launcher chooser). We don't need the result — onResume re-asserts kiosk mode.
    private val homeRoleLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        KioskController.applyWindow(this)
        // Device owner: become the persistent HOME so pressing Home always reopens the kiosk (a real
        // single-app kiosk, not escapable screen-pinning), and silently grant the reader permission.
        KioskController.provisionHome(this)
        KioskController.grantReaderPermissions(this)
        // Non-owner: ask for location once so a USB reader can be discovered (USB has no manual
        // setup UI). On a device-owner tablet this is already granted above, so no dialog appears.
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            readerPermissionLauncher.launch(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        // Become the default Home app so pressing Home returns straight to the kiosk (no launcher
        // chooser, no way to pick a different launcher). Device owner already set this persistently;
        // otherwise ask once. This is how a single-app kiosk stops Home being an escape.
        requestHomeApp(force = false)

        val deviceOwner = KioskController.isDeviceOwner(this)

        setContent {
            // The kiosk is a dark-by-design giving station: force dark so a tablet set to LIGHT
            // system theme still renders the (dark-scene) donor + maintenance screens legibly.
            SakinaTheme(darkTheme = true) {
                KioskRoot(
                    vm = vm,
                    isDeviceOwner = deviceOwner,
                    onExitKiosk = {
                        // Real escape hatch for a maintainer (only reachable behind a verified PIN).
                        // Stop the leave-watchdog + Lock Task, drop our forced-HOME, then hand off to
                        // the device's OWN launcher so we actually leave (Home no longer reopens us).
                        exiting = true
                        if (KioskController.exitKioskFully(this)) {
                            // Device owner: our forced-HOME is cleared → send to the system launcher.
                            runCatching {
                                startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                            }
                        } else {
                            // Not device owner: Android won't let an app change the default launcher,
                            // so open the Home-app picker for the maintainer to switch it themselves.
                            runCatching { startActivity(Intent(Settings.ACTION_HOME_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                        }
                        finishAndRemoveTask()
                    },
                    onOpenBrowser = { url ->
                        // Updating means leaving the app for the browser to download + install the new
                        // APK. Because we're the HOME launcher with a re-launch-on-leave watchdog, we
                        // must FULLY END kiosk mode first — otherwise Home/leave bounces straight back
                        // and the browser can never stay open. (The new version relaunches into kiosk;
                        // if they cancel, a reboot returns to kiosk.)
                        exiting = true
                        KioskController.releaseHome(this)
                        KioskController.exitKiosk(this)
                        runCatching {
                            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        }
                    },
                    onSetHomeApp = { requestHomeApp(force = true) },
                    onOpenSettings = {
                        // A maintenance excursion to Android Settings (Wi-Fi, launcher, etc.). Drop
                        // lock task + re-enable the status bar so Settings can open, but stay the
                        // kiosk (exiting stays false) so onResume re-locks the moment they return.
                        KioskController.exitKiosk(this)
                        runCatching { startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                    },
                )
            }
        }

        // Schedule the heartbeat backstop and run the live loop while paired.
        vm.start()
    }

    override fun onResume() {
        super.onResume()
        // Idempotent: enters lock task (device owner) / re-applies immersive. Skipped once we've
        // ended kiosk mode for an update (exiting) so the browser/installer isn't yanked away.
        if (!exiting) KioskController.enterKiosk(this)
    }

    /**
     * Ask to become the device's default Home app, so pressing Home returns to the kiosk instead of
     * showing a launcher chooser (or letting the user pick another launcher). [force] = the admin
     * tapped "Set as Home app" in maintenance; otherwise we only prompt when it isn't already ours.
     * Device owner sets this persistently elsewhere, so this is a no-op there.
     */
    private fun requestHomeApp(force: Boolean) {
        if (KioskController.isDeviceOwner(this)) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val rm = getSystemService(RoleManager::class.java)
            if (rm != null && rm.isRoleAvailable(RoleManager.ROLE_HOME)) {
                if (!force && rm.isRoleHeld(RoleManager.ROLE_HOME)) return
                val launched = runCatching { homeRoleLauncher.launch(rm.createRequestRoleIntent(RoleManager.ROLE_HOME)); true }.getOrDefault(false)
                if (launched) return
            }
        }
        // Pre-Q, or if the role request couldn't launch: open the system Home-app picker (only when
        // the admin explicitly asked, so we never surprise a donor with a settings screen).
        if (force) runCatching { startActivity(Intent(Settings.ACTION_HOME_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    /**
     * The kiosk leave-watchdog. Called when the user tries to leave via Home or Recents — bounce
     * straight back into the kiosk by bringing this activity to the front. This is how a real
     * single-app kiosk works (re-open the target app on every leave) rather than escapable screen-
     * pinning. On a device-owner tablet this never even fires (Lock Task blocks Home/Recents). During
     * a deliberate PIN-verified exit we let go via [exiting].
     */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (exiting) return
        runCatching {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // Re-hide the system bars whenever we regain focus (immersive sticky).
        if (hasFocus) KioskController.applyWindow(this)
    }
}
