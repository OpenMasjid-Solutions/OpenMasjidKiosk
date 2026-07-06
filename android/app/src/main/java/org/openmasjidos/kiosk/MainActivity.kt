// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import org.openmasjidos.kiosk.kiosk.KioskController
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        KioskController.applyWindow(this)

        val deviceOwner = KioskController.isDeviceOwner(this)

        setContent {
            // The kiosk is a dark-by-design giving station: force dark so a tablet set to LIGHT
            // system theme still renders the (dark-scene) donor + maintenance screens legibly.
            SakinaTheme(darkTheme = true) {
                KioskRoot(
                    vm = vm,
                    isDeviceOwner = deviceOwner,
                    onExitKiosk = {
                        // Real escape hatch for a maintainer: drop lock task and leave the app.
                        // (If this app is the only HOME launcher and still device owner, the
                        // system will relaunch it — full exit needs another launcher or the
                        // device-owner removed; documented in docs/TABLET_SETUP.md.)
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
        // Idempotent: only enters lock task if not already locked/pinned.
        KioskController.enterKiosk(this)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // Re-hide the system bars whenever we regain focus (immersive sticky).
        if (hasFocus) KioskController.applyWindow(this)
    }
}
