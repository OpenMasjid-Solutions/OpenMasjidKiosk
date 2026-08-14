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
import android.os.SystemClock
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import org.openmasjidos.kiosk.kiosk.KioskController
import java.io.File
import org.openmasjidos.kiosk.readers.ReaderManager
import org.openmasjidos.kiosk.ui.KioskRoot
import org.openmasjidos.kiosk.ui.RotatedRoot
import org.openmasjidos.kiosk.ui.orientationDegrees
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

    /**
     * A MAINTENANCE EXCURSION: the maintainer is deliberately in another system screen (Android
     * Settings, the package installer, a permission dialog) and we must stay out of their way until
     * they come back. [SystemClock.elapsedRealtime] when it started, or 0 when we are not out.
     *
     * WHY THIS EXISTS. Unpinning and then calling startActivity is not enough on its own, because
     * this activity runs three watchdogs whose whole job is to drag the kiosk back:
     *
     *   • [onWindowFocusChanged] re-enters lock task on every focus REGAIN. `stopLockTask()` brings
     *     the system bars back, which is itself a window change — so a focus event can land between
     *     the unpin and the startActivity, RE-PIN us, and then the launch is silently suppressed
     *     because a pinned app may not start another package. The button looks broken, which is
     *     exactly what "it keeps clashing with app pinning" looks like from the tablet.
     *   • [onUserLeaveHint] bounces this activity back to the front whenever the kiosk is backgrounded.
     *     When it fires on the way into Settings, Settings appears and is instantly covered.
     *   • [onResume] re-locks. Harmless on a real return, harmful mid-launch.
     *
     * So an excursion does two things. For [EXCURSION_SETTLING_MS] after it begins we ignore resume
     * and focus events entirely — that is the window in which the other app has not yet appeared and
     * re-locking would kill it. And for as long as we are out, the leave-watchdog stands down, so
     * Settings is allowed to actually be in front. The FIRST resume or focus-regain after the settling
     * window is treated as the maintainer returning: the excursion ends and the kiosk re-locks itself.
     */
    private var excursionSinceMs = 0L

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
                // Rotate the whole UI by the web-set angle (Admin → Devices). We rotate the CONTENT
                // ourselves rather than asking the system (setRequestedOrientation), because many
                // tablets ignore orientation requests — drawing it rotated always works.
                val uiState by vm.ui.collectAsStateWithLifecycle()
                // Re-assert lockdown whenever the LOCKED state flips WHILE the kiosk is on screen (e.g.
                // an admin REVOKE or a cert-mismatch RE-PAIR arriving on a heartbeat): screen-pin when
                // locked, and RELEASE the pin the moment it drops to the pairing / re-pair screen so
                // the tablet is never trapped on a screen with no in-app exit. LOCKED = paired AND not
                // in a re-pair lockout. onResume covers the return-from-Settings case; this covers a
                // state change that happens with no resume.
                val locked = uiState.phase == Phase.Paired && uiState.rePair == null
                LaunchedEffect(locked) {
                    // Not `relockUnlessAway`: a REVOKE arriving while the maintainer is in Settings must
                    // still be able to RELEASE the lock (locked=false), or a revoked tablet is stranded.
                    // Only skip the case that would fight the excursion — re-locking mid-excursion.
                    if (exiting) return@LaunchedEffect
                    if (locked && excursionSinceMs != 0L) return@LaunchedEffect
                    KioskController.enterKiosk(this@MainActivity, locked)
                }
                RotatedRoot(orientationDegrees(uiState.config?.orientation)) {
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
                    onInstallApk = { path -> installApk(path) },
                    onOpenBrowser = { url ->
                        // FALLBACK app-update path (used only if the in-app download failed): leaving the
                        // app for the browser to download + install the new APK. Because we're the HOME
                        // launcher with a re-launch-on-leave watchdog, we must FULLY END kiosk mode first
                        // — otherwise Home/leave bounces straight back and the browser can never stay
                        // open. (The new version relaunches into kiosk; if they cancel, a reboot returns.)
                        exiting = true
                        KioskController.releaseHome(this)
                        KioskController.exitKiosk(this)
                        runCatching {
                            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        }
                    },
                    onSetHomeApp = { requestHomeApp(force = true) },
                    onOpenSettings = {
                        // A maintenance excursion to Android Settings (Wi-Fi, launcher, etc.). Unpins,
                        // re-enables the status bar and holds the watchdogs off until they come back —
                        // we stay the kiosk (`exiting` stays false), so the first resume after that
                        // re-locks. Falls back to this app's own settings page on the rare OEM build
                        // whose top-level Settings action can't be launched by a third-party app.
                        openSystemScreen(
                            Intent(Settings.ACTION_SETTINGS),
                            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")),
                        )
                    },
                    // Drop screen pinning / Lock Task so a SYSTEM DIALOG (a runtime permission prompt)
                    // can actually appear — while pinned, one is silently suppressed and the button
                    // looks broken. Used by the checklist for prompts it launches itself; anything that
                    // opens another ACTIVITY goes through onOpenIntent instead, which also marks the
                    // excursion. A temporary excursion (NOT `exiting`): the next resume re-locks.
                    onLeaveLockdown = { beginExcursion() },
                    onOpenIntent = { intent ->
                        // Not every OEM build ships every settings screen (unknown-app-sources in
                        // particular), and a checklist button that throws away an
                        // ActivityNotFoundException is just a dead button — so fall back to this app's
                        // own "App info" page, which always exists and from which every one of these
                        // can be reached by hand.
                        openSystemScreen(
                            intent,
                            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")),
                        )
                    },
                )
                }
            }
        }

        // Schedule the heartbeat backstop and run the live loop while paired.
        vm.start()
    }

    /** LOCKED = a paired kiosk that isn't in a re-pair lockout, i.e. a screen a donor may use. */
    private fun kioskLocked(): Boolean = vm.ui.value.phase == Phase.Paired && vm.ui.value.rePair == null

    /** Still setting up an excursion — the other app hasn't appeared yet, so re-locking now kills it. */
    private fun excursionSettling(): Boolean =
        excursionSinceMs != 0L && SystemClock.elapsedRealtime() - excursionSinceMs < EXCURSION_SETTLING_MS

    /**
     * Begin an excursion: unpin, and arm a backstop that re-locks if nothing actually came to the front.
     *
     * The backstop matters because an excursion is ended by the maintainer RETURNING — a resume or a
     * focus-regain. If the thing we unpinned for never appears (a permission already granted, so no
     * dialog is shown; a settings screen this OEM doesn't have), there is no departure and therefore
     * no return, and the kiosk would sit quietly UNPINNED in front of donors until some unrelated
     * event happened to re-lock it. [Activity.hasWindowFocus] tells us the truth cheaply: still
     * focused after the settling window means nothing ever covered us.
     */
    private fun beginExcursion() {
        excursionSinceMs = SystemClock.elapsedRealtime()
        KioskController.exitKiosk(this)
        window.decorView.postDelayed({
            if (!exiting && excursionSinceMs != 0L && hasWindowFocus()) {
                excursionSinceMs = 0L
                KioskController.enterKiosk(this, kioskLocked())
            }
        }, EXCURSION_SETTLING_MS + 250L)
    }

    /**
     * Re-assert kiosk lockdown, unless we're mid-exit or mid-excursion. Called from every place that
     * could mean "the maintainer is back": resume, focus-regain, and a locked-state change.
     */
    private fun relockUnlessAway() {
        if (exiting) return
        if (excursionSettling()) return
        // Past the settling window, so this really is a return — the excursion is over.
        excursionSinceMs = 0L
        KioskController.enterKiosk(this, kioskLocked())
    }

    /**
     * Open a SYSTEM screen (Android Settings, app info, the installer) from maintenance, and survive
     * the round trip.
     *
     * Unpins first — a pinned app may not start another package, and the failure is SILENT, so a
     * button that doesn't unpin simply appears dead. Then marks the excursion so the watchdogs let
     * the other app stay in front (see [excursionSinceMs]).
     *
     * If nothing opens — [fallback] included, because not every OEM build ships every settings screen
     * — we re-lock immediately rather than leaving a donor-facing kiosk sitting unpinned on the giving
     * screen because a maintenance button failed.
     */
    private fun openSystemScreen(intent: Intent, fallback: Intent? = null): Boolean {
        beginExcursion()
        val launch = { i: Intent ->
            runCatching { startActivity(Intent(i).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true }.getOrDefault(false)
        }
        val opened = launch(intent) || (fallback != null && launch(fallback))
        if (!opened) {
            excursionSinceMs = 0L
            KioskController.enterKiosk(this, kioskLocked())
        }
        return opened
    }

    /**
     * An APK that finished downloading but couldn't be installed yet, because "install unknown apps"
     * hadn't been granted. Held so that granting it and coming back FINISHES the update, rather than
     * silently dropping it and making the maintainer download the whole thing again.
     */
    private var pendingApkPath: String? = null

    /** Finish an update that was waiting on the install permission. True if we started one. */
    private fun resumePendingInstall(): Boolean {
        val path = pendingApkPath ?: return false
        if (exiting) return false
        if (!runCatching { packageManager.canRequestPackageInstalls() }.getOrDefault(false)) return false
        pendingApkPath = null
        installApk(path) // manages the excursion itself
        return true
    }

    override fun onResume() {
        super.onResume()
        // Back from granting the install permission → hand the already-downloaded APK straight to the
        // installer. Before the re-lock, because installApk starts its own excursion.
        if (resumePendingInstall()) return
        // Idempotent: enters lock task (device owner) / screen-pins when PAIRED (soft kiosk) / re-
        // applies immersive. Skipped once we've ended kiosk mode for an update (exiting) so the
        // browser/installer isn't yanked away, and while an excursion is still settling so Settings
        // isn't re-pinned out of existence before it appears. `paired` gates soft-kiosk pinning so the
        // pairing screen is never pinned (it has no in-app unpin) — see KioskController.enterKiosk.
        relockUnlessAway()
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
    /**
     * Install a downloaded APK via the SYSTEM package installer (the in-app update path — no browser).
     * On Android O+ the app needs the per-source "install unknown apps" allowance; if it's missing we
     * send the maintainer to grant it once (same as the first sideload) and they can re-tap Update.
     * We drop screen pinning first (the installer is its own system task, which pinning would block) —
     * this is a temporary excursion (NOT `exiting`), so onResume re-locks on return, and a successful
     * install relaunches the new version straight into the kiosk.
     */
    private fun installApk(path: String) {
        val file = File(path)
        if (!file.exists()) return
        // Drop the kiosk lock FIRST — BOTH the "allow install from this source" Settings screen and
        // the system installer are separate system tasks that screen pinning / Lock Task would block
        // (the launch is silently suppressed while pinned). Marked as an excursion (NOT `exiting`) so
        // the focus/leave watchdogs don't re-pin us mid-launch or bounce the installer away; the next
        // resume re-locks, and a successful install relaunches the new version into the kiosk.
        if (!runCatching { packageManager.canRequestPackageInstalls() }.getOrDefault(false)) {
            // First in-app update: our package hasn't been granted "install unknown apps" yet (the
            // browser held it at first sideload). Send the maintainer to grant it — and KEEP the
            // downloaded APK, so coming back finishes the update instead of making them tap Update and
            // wait for the whole download a second time. That re-download was most of the reason this
            // felt like it "needed Chrome": the grant screen was unreachable behind screen pinning, and
            // even once reached the update didn't resume.
            pendingApkPath = path
            openSystemScreen(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")),
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")),
            )
            return
        }
        beginExcursion()
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        val opened = runCatching {
            startActivity(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            true
        }.getOrDefault(false)
        // The installer didn't open: re-lock rather than leaving a donor-facing kiosk unpinned.
        if (!opened) {
            excursionSinceMs = 0L
            KioskController.enterKiosk(this, kioskLocked())
        }
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (exiting) return
        // Stand down for a maintenance excursion. This watchdog exists to defeat a DONOR pressing
        // Home; applying it to the maintainer's own trip to Settings is what made Settings unusable —
        // it opens and is immediately covered by the kiosk bouncing itself back to the front.
        if (excursionSinceMs != 0L) return
        runCatching {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // On focus-regain (e.g. after the notification shade or a dialog stole focus) RE-ASSERT the
        // FULL lockdown, not just immersive: re-enter screen pinning if it dropped (this is what keeps
        // the recents button + cross-app nav closed) and re-hide the bars. Skipped mid-exit, and while
        // an excursion is still settling — `stopLockTask()` restores the system bars, which is itself a
        // window change, so without that guard this handler re-pins us in the gap before Settings has
        // even launched and the launch is then silently refused.
        if (hasFocus) relockUnlessAway()
    }

    companion object {
        /**
         * How long after starting an excursion we ignore resume / focus events.
         *
         * Long enough to cover the gap between `stopLockTask()` and the other app actually being in
         * front — the window in which a stray focus event would re-pin us and silently kill the
         * launch. Short enough that a maintainer who backs straight out of Settings still finds the
         * kiosk re-locking almost at once, and that a kiosk is never left unpinned for a noticeable
         * time in front of a donor. Cold-starting Settings on a slow tablet is the case being covered.
         */
        private const val EXCURSION_SETTLING_MS = 2_500L
    }
}
