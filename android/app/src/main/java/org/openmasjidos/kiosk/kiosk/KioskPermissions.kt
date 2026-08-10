// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.kiosk

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.annotation.StringRes
import androidx.core.content.ContextCompat
import org.openmasjidos.kiosk.R

/**
 * Everything the kiosk needs the tablet to allow, as one honest checklist (§10).
 *
 * A volunteer setting up a wall tablet has no way to know that a card reader needs *location*, or
 * that self-update needs "install unknown apps" — and Android hides each of those behind a different
 * settings screen. So the PIN-protected maintenance screen lists them all with live state and a
 * button that goes straight to the right place. This file is the model; ui/PermissionChecklist.kt
 * draws it.
 *
 * Two rules the callers must keep:
 *  - Read this fresh on every RESUME. Everything here can be changed outside the app, so a cached
 *    list goes stale the moment the maintainer walks through a settings screen.
 *  - DROP KIOSK LOCKDOWN BEFORE ACTING ON A ROW. Both runtime-permission dialogs and settings
 *    screens are separate system tasks/windows, and a device-owner Lock Task suppresses them — the
 *    tap would look like it did nothing. See PermissionChecklist's fix(). (Screen pinning used to do
 *    this on ordinary tablets too, which is why it was removed.)
 *
 * Every OS read is wrapped: an unreadable value becomes [PermState.Unknown] (we still offer the
 * button) rather than a crash or a confident lie.
 */

/** Whether a checklist item is satisfied. [Unknown] = the OS wouldn't tell us; never guess. */
enum class PermState { Granted, Missing, Unknown }

/** How a row is put right. */
enum class PermFix {
    /** Ask for [PermRow.runtime] with the normal Android permission dialog. */
    Runtime,

    /** Open [PermRow.settings] and let the maintainer flip the switch. */
    OpenSettings,

    /** Ask to become the default Home app (RoleManager on Q+, the picker below that). */
    HomeRole,

    /** Nothing to press — informational only (device owner, which needs ADB from a computer). */
    None,
}

/** One line of the checklist. [required] items are counted in the "x of y set" summary. */
data class PermRow(
    val id: String,
    @StringRes val title: Int,
    @StringRes val detail: Int,
    @StringRes val action: Int?,
    val state: PermState,
    val required: Boolean,
    val fix: PermFix,
    val runtime: List<String> = emptyList(),
    val settings: Intent? = null,
)

/**
 * Build the live checklist for this tablet. Rows that can't apply are omitted rather than shown as
 * permanently unsatisfiable: the Bluetooth rows are dropped on a tablet with no Bluetooth radio, the
 * runtime-Bluetooth row is dropped below API 31 (there those permissions are granted at install),
 * and the shade helper is dropped on a device-owner tablet, where Lock Task Mode
 * already does both jobs properly.
 */
fun kioskPermissionRows(context: Context): List<PermRow> {
    val owner = KioskController.isDeviceOwner(context)
    val rows = mutableListOf<PermRow>()

    // --- Self-update -----------------------------------------------------------------------
    // Without this the in-app updater can only bounce the maintainer out to a browser.
    rows += PermRow(
        id = "install",
        title = R.string.perm_install_title,
        detail = R.string.perm_install_detail,
        action = R.string.perm_action_open_settings,
        state = boolState(runCatching { context.packageManager.canRequestPackageInstalls() }.getOrNull()),
        required = true,
        fix = PermFix.OpenSettings,
        settings = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}"),
        ),
    )

    // --- Card reader -----------------------------------------------------------------------
    val hasBluetooth = bluetoothAdapterEnabled(context) != null
    if (hasBluetooth && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        // Pre-31 these are install-time permissions, so there is nothing for anyone to grant.
        val perms = listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        rows += PermRow(
            id = "bluetooth",
            title = R.string.perm_bluetooth_title,
            detail = R.string.perm_bluetooth_detail,
            action = R.string.perm_action_grant,
            state = boolState(perms.all { granted(context, it) }),
            required = true,
            fix = PermFix.Runtime,
            runtime = perms,
        )
    }

    // Stripe's Terminal SDK requires location for EVERY discovery config — USB included. That
    // surprises everyone, which is exactly why it is spelled out here.
    rows += PermRow(
        id = "location",
        title = R.string.perm_location_title,
        detail = R.string.perm_location_detail,
        action = R.string.perm_action_grant,
        state = boolState(granted(context, Manifest.permission.ACCESS_FINE_LOCATION)),
        required = true,
        fix = PermFix.Runtime,
        runtime = listOf(Manifest.permission.ACCESS_FINE_LOCATION),
    )

    rows += PermRow(
        id = "location_on",
        title = R.string.perm_location_on_title,
        detail = R.string.perm_location_on_detail,
        action = R.string.perm_action_open_settings,
        state = boolState(locationServicesOn(context)),
        required = true,
        fix = PermFix.OpenSettings,
        settings = Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS),
    )

    if (hasBluetooth) {
        rows += PermRow(
            id = "bluetooth_on",
            title = R.string.perm_bluetooth_on_title,
            detail = R.string.perm_bluetooth_on_detail,
            action = R.string.perm_action_open_settings,
            state = boolState(bluetoothAdapterEnabled(context)),
            // A USB-cabled reader (or a keyed-entry kiosk) needs no Bluetooth at all, so this is
            // never counted as missing setup — it's a convenience switch.
            required = false,
            fix = PermFix.OpenSettings,
            settings = Intent(Settings.ACTION_BLUETOOTH_SETTINGS),
        )
    }

    // --- Lockdown --------------------------------------------------------------------------
    rows += PermRow(
        id = "home",
        title = R.string.perm_home_title,
        detail = R.string.perm_home_detail,
        action = R.string.kiosk_set_home_app,
        state = boolState(isDefaultHome(context)),
        required = true,
        fix = PermFix.HomeRole,
    )

    // No "Screen pinning" row any more — the app no longer pins itself (see KioskController). Asking a
    // volunteer to switch on a setting nothing uses would be a checklist item they can never satisfy
    // usefully, and pinning is what made every other row's button appear dead.
    if (!owner) {
        rows += PermRow(
            id = "shade",
            title = R.string.perm_shade_title,
            detail = R.string.perm_shade_detail,
            action = R.string.perm_action_open_settings,
            state = boolState(shadeGuardEnabled(context)),
            required = false, // a helpful extra, not a prerequisite
            fix = PermFix.OpenSettings,
            settings = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS),
        )
    }

    // Informational last line: no button, because device owner can only be granted over ADB from a
    // computer against a factory-reset tablet. Never counted as missing — the kiosk works without it.
    rows += PermRow(
        id = "owner",
        title = R.string.perm_owner_title,
        detail = if (owner) R.string.perm_owner_detail_on else R.string.perm_owner_detail_off,
        action = null,
        state = if (owner) PermState.Granted else PermState.Missing,
        required = false,
        fix = PermFix.None,
    )

    return rows
}

/** "3 of 7 set" — required rows only, so an optional switch never reads as a broken kiosk. */
fun requiredSet(rows: List<PermRow>): Int = rows.count { it.required && it.state == PermState.Granted }

fun requiredTotal(rows: List<PermRow>): Int = rows.count { it.required }

// --- readers ---------------------------------------------------------------------------------

private fun boolState(v: Boolean?): PermState = when (v) {
    true -> PermState.Granted
    false -> PermState.Missing
    null -> PermState.Unknown
}

private fun granted(context: Context, perm: String): Boolean =
    ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED

/** null = this tablet has no Bluetooth radio at all (so we hide the Bluetooth rows entirely). */
private fun bluetoothAdapterEnabled(context: Context): Boolean? = runCatching {
    val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
    // isEnabled() needs no permission on API 31+ and only the install-time BLUETOOTH below that.
    adapter?.isEnabled
}.getOrNull()

private fun locationServicesOn(context: Context): Boolean? = runCatching {
    val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return@runCatching null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        lm.isLocationEnabled
    } else {
        lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }
}.getOrNull()

/** True when WE are the resolved Home app — covers both the RoleManager grant (non-owner) and the
 *  persistent preferred activity a device owner sets, without needing API-level branches. With no
 *  default chosen this resolves to the system chooser, i.e. not us, which is the right answer. */
private fun isDefaultHome(context: Context): Boolean? = runCatching {
    val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
    context.packageManager
        .resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY)
        ?.activityInfo?.packageName == context.packageName
}.getOrNull()

/** Whether the volunteer has switched our (opt-in) shade-closing accessibility service on. */
private fun shadeGuardEnabled(context: Context): Boolean? = runCatching {
    val me = ComponentName(context, ShadeGuardService::class.java)
    val enabled = Settings.Secure
        .getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
        .orEmpty()
    enabled.split(':').any {
        it.equals(me.flattenToString(), ignoreCase = true) ||
            it.equals(me.flattenToShortString(), ignoreCase = true)
    }
}.getOrNull()
