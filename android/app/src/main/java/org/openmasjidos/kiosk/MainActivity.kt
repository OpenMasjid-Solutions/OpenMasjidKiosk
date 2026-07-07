// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
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
            if (granted) ReaderManager.retryUsbAutoConnect()
        }

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

        val deviceOwner = KioskController.isDeviceOwner(this)

        setContent {
            // The kiosk is a dark-by-design giving station: force dark so a tablet set to LIGHT
            // system theme still renders the (dark-scene) donor + maintenance screens legibly.
            SakinaTheme(darkTheme = true) {
                KioskRoot(
                    vm = vm,
                    isDeviceOwner = deviceOwner,
                    onExitKiosk = {
                        // Real escape hatch for a maintainer (only reachable behind a verified PIN):
                        // let the leave-watchdog go, drop the persistent HOME + lock task, and leave.
                        // (On a dedicated tablet with no other launcher the system may relaunch us;
                        // documented in docs/TABLET_SETUP.md.)
                        exiting = true
                        KioskController.releaseHome(this)
                        KioskController.exitKiosk(this)
                        finishAndRemoveTask()
                    },
                    onOpenBrowser = { url ->
                        // Updating = install the newest APK from the server via the browser (Android
                        // can't update an ordinary app itself). Drop lock task so the browser + the
                        // installer can appear; onResume re-locks the kiosk when we return.
                        KioskController.exitKiosk(this)
                        runCatching {
                            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        }
                    },
                )
            }
        }

        // Schedule the heartbeat backstop and run the live loop while paired.
        vm.start()
    }

    override fun onResume() {
        super.onResume()
        // Idempotent: enters lock task (device owner) / re-applies immersive.
        KioskController.enterKiosk(this)
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
