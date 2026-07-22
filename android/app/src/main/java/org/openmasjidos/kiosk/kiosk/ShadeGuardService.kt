// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.kiosk

import android.accessibilityservice.AccessibilityService
import android.os.Build
import android.view.accessibility.AccessibilityEvent

/**
 * A tiny OPT-IN accessibility service that closes the notification shade the instant it opens, so a
 * soft kiosk (no device owner) can't have its shade / quick-settings pulled down. This is the one
 * thing a plain app CANNOT do from its own window — only an accessibility service may dismiss the
 * shade — which is why it's a separate, user-enabled component (Settings → Accessibility).
 *
 * It does NOTHING unless (1) the volunteer has enabled it in Accessibility settings AND (2) the
 * kiosk is actively locked ([ShadeGuard.active] — set true only while a PAIRED kiosk is running, and
 * false during a maintenance excursion / update / exit), so it never fights the shade on the pairing
 * screen or after the maintainer has left the kiosk. Screen pinning already blocks the shade when
 * it's active; this is belt-and-braces for the windows where it isn't (and where pinning is off).
 *
 * We request NO window content and keep the service scope minimal (window-state events only) so it
 * has no more capability than it needs.
 */
class ShadeGuardService : AccessibilityService() {

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || !ShadeGuard.active) return
        // Only react to the system UI (the shade lives there). Different OEMs may name it slightly
        // differently, so match on the "systemui" substring rather than an exact package.
        val pkg = event.packageName?.toString() ?: return
        if (!pkg.contains("systemui", ignoreCase = true)) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOWS_CHANGED
        ) {
            return
        }
        dismissShade()
    }

    private fun dismissShade() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // API 31+: the dedicated, supported action.
            runCatching { performGlobalAction(GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE) }
        } else {
            // Pre-31 has no accessibility action for this. Best-effort legacy collapse via reflection
            // (restricted on many builds — wrapped so it can never throw); the shade otherwise relies
            // on screen pinning being active.
            runCatching {
                val sb = getSystemService("statusbar")
                val cls = Class.forName("android.app.StatusBarManager")
                cls.getMethod("collapsePanels").invoke(sb)
            }
        }
    }

    override fun onInterrupt() { /* nothing to do */ }
}

/** Cross-component flag telling [ShadeGuardService] when to guard the shade. Set by KioskController:
 *  true only while a PAIRED kiosk is actively locked; false on the pairing screen and during any
 *  maintenance excursion / update / exit, so the maintainer (and a revoked tablet) can use the shade
 *  normally. In-memory only. */
object ShadeGuard {
    @Volatile
    var active: Boolean = false
}
