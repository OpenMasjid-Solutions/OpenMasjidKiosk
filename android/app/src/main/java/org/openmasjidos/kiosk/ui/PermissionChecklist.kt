// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import org.openmasjidos.kiosk.R
import org.openmasjidos.kiosk.kiosk.PermFix
import org.openmasjidos.kiosk.kiosk.PermRow
import org.openmasjidos.kiosk.kiosk.PermState
import org.openmasjidos.kiosk.kiosk.kioskPermissionRows
import org.openmasjidos.kiosk.kiosk.requiredSet
import org.openmasjidos.kiosk.kiosk.requiredTotal
import org.openmasjidos.kiosk.ui.theme.InkDark
import org.openmasjidos.kiosk.ui.theme.InkMutedDark
import org.openmasjidos.kiosk.ui.theme.SuccessDark
import org.openmasjidos.kiosk.ui.theme.WarningDark

/**
 * The "Permissions & lockdown" section of the maintenance screen: every allowance the kiosk wants,
 * whether it is currently set, and one button per unset item that opens exactly the right dialog or
 * settings page (see kiosk/KioskPermissions.kt for the model).
 *
 * Two behaviors matter as much as the list itself:
 *  1. **Every fix button drops kiosk lockdown first.** A permission dialog or a settings screen is
 *     a separate system task, and screen pinning / Lock Task silently suppresses it — the tap would
 *     appear to do nothing at all. [onLeaveLockdown] unpins; this is a temporary excursion, so the
 *     Activity re-locks on its next resume/focus with no further action.
 *  2. **The list is re-read on every RESUME**, so walking to a settings screen and back shows the
 *     new state immediately rather than a stale tick.
 */
@Composable
fun PermissionChecklist(
    isDeviceOwner: Boolean,
    onLeaveLockdown: () -> Unit,
    onOpenIntent: (Intent) -> Unit,
    onSetHomeApp: () -> Unit,
) {
    val context = LocalContext.current

    // Bumped on every resume (back from a settings screen) and after a permission dialog closes.
    var refresh by remember { mutableIntStateOf(0) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) refresh++
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val rows = remember(refresh) { kioskPermissionRows(context) }

    // Permissions Android will no longer show a dialog for, because they were denied twice (or the
    // tablet's policy blocks them). Without this the button would be a dead end: launch() returns
    // "denied" instantly, nothing appears on screen, and the row never turns green no matter how
    // many times it is pressed. Once a permission lands here the row switches to "Open app
    // settings", which is the only remaining way to grant it.
    var blocked by remember { mutableStateOf(emptySet<String>()) }

    val permLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val activity = context.findActivity()
        blocked = blocked + result.filterValues { !it }.keys.filter { perm ->
            // false both BEFORE the first ask and AFTER a permanent denial — but we only reach here
            // having just asked, so at this point it means "Android will not ask again".
            activity == null || !ActivityCompat.shouldShowRequestPermissionRationale(activity, perm)
        }
        refresh++ // re-read the truth rather than assume the grant
    }

    fun fix(row: PermRow) {
        // ALWAYS unpin first — see the note on this composable. Harmless when we aren't pinned.
        onLeaveLockdown()
        if (row.fix == PermFix.Runtime && row.runtime.any { it in blocked }) {
            onOpenIntent(appDetailsIntent(context))
            return
        }
        when (row.fix) {
            PermFix.Runtime -> if (row.runtime.isNotEmpty()) permLauncher.launch(row.runtime.toTypedArray())
            PermFix.OpenSettings -> row.settings?.let(onOpenIntent)
            PermFix.HomeRole -> onSetHomeApp()
            PermFix.None -> Unit
        }
    }

    Text(
        text = stringResource(R.string.perm_summary, requiredSet(rows), requiredTotal(rows)),
        style = MaterialTheme.typography.bodyMedium,
        color = InkMutedDark,
    )
    Spacer(Modifier.height(4.dp))
    Text(
        text = stringResource(R.string.perm_intro),
        style = MaterialTheme.typography.bodySmall,
        color = InkMutedDark,
    )

    rows.forEachIndexed { i, row ->
        if (i > 0) HorizontalDivider(color = InkMutedDark.copy(alpha = 0.15f))
        PermissionRow(
            row = row,
            blocked = row.fix == PermFix.Runtime && row.runtime.any { it in blocked },
            onFix = { fix(row) },
        )
    }

    // How to finish the job in the tablet's own Settings — the two bars Android won't let an
    // ordinary app remove. Honest about which one is actually achievable without device owner.
    Spacer(Modifier.height(16.dp))
    Banner(
        text = stringResource(
            if (isDeviceOwner) R.string.kiosk_bars_note_owner else R.string.kiosk_bars_note,
        ),
        tone = InkMutedDark,
    )

    if (!isDeviceOwner) {
        Spacer(Modifier.height(12.dp))
        Banner(text = stringResource(R.string.kiosk_pinning_hint), tone = WarningDark)
    }
}

@Composable
private fun PermissionRow(row: PermRow, blocked: Boolean, onFix: () -> Unit) {
    val tone = when {
        row.state == PermState.Granted -> SuccessDark
        row.state == PermState.Missing && row.required -> WarningDark
        else -> InkMutedDark
    }
    Column(modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(modifier = Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                Spacer(
                    Modifier
                        .size(10.dp)
                        .background(tone, CircleShape),
                )
                Spacer(Modifier.width(10.dp))
                Text(
                    text = stringResource(row.title),
                    style = MaterialTheme.typography.bodyLarge,
                    color = InkDark,
                )
            }
            Spacer(Modifier.width(12.dp))
            Text(text = stateWord(row.state), style = MaterialTheme.typography.bodyMedium, color = tone)
        }
        Spacer(Modifier.height(6.dp))
        Text(
            text = stringResource(row.detail),
            style = MaterialTheme.typography.bodySmall,
            color = InkMutedDark,
        )
        // Offer the button when it isn't set AND when we couldn't tell — "can't tell" must never
        // leave a maintainer with no way to go and look.
        val action = row.action
        if (action != null && row.fix != PermFix.None && row.state != PermState.Granted) {
            if (blocked) {
                Spacer(Modifier.height(6.dp))
                Text(
                    text = stringResource(R.string.perm_blocked_note),
                    style = MaterialTheme.typography.bodySmall,
                    color = WarningDark,
                )
            }
            Spacer(Modifier.height(10.dp))
            FilledTonalButton(
                onClick = onFix,
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(if (blocked) R.string.perm_action_app_settings else action)) }
        }
    }
}

/** The app's own "App info" page — the only route left once Android stops asking. */
private fun appDetailsIntent(context: Context): Intent =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))

/** Compose hands us a themed ContextWrapper, not necessarily the Activity itself. */
private fun Context.findActivity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}

@Composable
private fun stateWord(state: PermState): String = when (state) {
    PermState.Granted -> stringResource(R.string.perm_state_set)
    PermState.Missing -> stringResource(R.string.perm_state_missing)
    PermState.Unknown -> stringResource(R.string.perm_state_unknown)
}
