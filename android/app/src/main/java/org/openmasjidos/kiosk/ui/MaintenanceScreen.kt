// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.openmasjidos.kiosk.R
import org.openmasjidos.kiosk.local.Diagnostics
import org.openmasjidos.kiosk.ui.theme.DangerDark
import org.openmasjidos.kiosk.ui.theme.InkDark
import org.openmasjidos.kiosk.ui.theme.InkMutedDark
import org.openmasjidos.kiosk.ui.theme.SuccessDark
import org.openmasjidos.kiosk.ui.theme.WarningDark

/**
 * The PIN-protected maintenance screen. Reader setup is a placeholder for slice 5; this slice
 * provides diagnostics, re-pairing, and the kiosk exit/return controls.
 */
@Composable
fun MaintenanceScreen(
    diagnostics: Diagnostics,
    noPinSet: Boolean,
    showPinningHint: Boolean,
    onReturn: () -> Unit,
    onRePair: () -> Unit,
    onExit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SceneSurface(modifier = modifier, contentAlignment = Alignment.TopCenter) {
        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .widthIn(max = 560.dp)
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 40.dp),
        ) {
            Text(
                text = stringResource(R.string.maintenance_title),
                style = MaterialTheme.typography.displayMedium,
                color = InkDark,
            )

            if (noPinSet) {
                Spacer(Modifier.height(12.dp))
                Banner(text = stringResource(R.string.maintenance_no_pin), tone = WarningDark)
            }
            if (showPinningHint) {
                Spacer(Modifier.height(12.dp))
                Banner(text = stringResource(R.string.kiosk_pinning_hint), tone = WarningDark)
            }

            Spacer(Modifier.height(24.dp))

            // --- Diagnostics -----------------------------------------------------------
            SectionCard(title = stringResource(R.string.maintenance_diagnostics_title)) {
                DiagnosticRow(stringResource(R.string.diag_battery), batteryText(diagnostics.battery))
                DiagnosticRow(
                    stringResource(R.string.diag_power),
                    when (diagnostics.charging) {
                        true -> stringResource(R.string.diag_power_plugged)
                        false -> stringResource(R.string.diag_power_battery)
                        null -> stringResource(R.string.diag_unknown)
                    },
                    valueTone = if (diagnostics.charging == false) WarningDark else null,
                )
                DiagnosticRow(
                    stringResource(R.string.diag_connection),
                    if (diagnostics.online) stringResource(R.string.diag_online) else stringResource(R.string.diag_offline),
                    valueTone = if (diagnostics.online) SuccessDark else WarningDark,
                )
                DiagnosticRow(stringResource(R.string.diag_reader), stringResource(R.string.reader_status_not_connected))
                DiagnosticRow(stringResource(R.string.diag_last_checkin), lastCheckInText(diagnostics.lastHeartbeatMs))
                DiagnosticRow(stringResource(R.string.diag_app_version), diagnostics.appVersion.ifBlank { stringResource(R.string.diag_unknown) })
                DiagnosticRow(stringResource(R.string.diag_device_id), diagnostics.deviceId ?: stringResource(R.string.diag_unknown))
                DiagnosticRow(stringResource(R.string.diag_server), diagnostics.serverUrl ?: stringResource(R.string.diag_unknown))
                DiagnosticRow(stringResource(R.string.diag_certificate), shortFingerprint(diagnostics.pinnedCertSha256))
            }

            Spacer(Modifier.height(16.dp))

            // --- Reader (placeholder) --------------------------------------------------
            SectionCard(title = stringResource(R.string.maintenance_reader_title)) {
                Text(
                    text = stringResource(R.string.maintenance_reader_soon),
                    style = MaterialTheme.typography.bodyMedium,
                    color = InkMutedDark,
                )
            }

            Spacer(Modifier.height(16.dp))

            // --- Server & pairing ------------------------------------------------------
            SectionCard(title = stringResource(R.string.maintenance_server_title)) {
                OutlinedButton(
                    onClick = onRePair,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.maintenance_repair), color = InkDark)
                }
            }

            Spacer(Modifier.height(28.dp))

            // --- Return / Exit ---------------------------------------------------------
            Button(
                onClick = onReturn,
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp),
            ) {
                Text(stringResource(R.string.maintenance_return), style = MaterialTheme.typography.titleLarge)
            }
            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = onExit,
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(54.dp),
            ) {
                Text(stringResource(R.string.maintenance_exit), color = DangerDark)
            }
        }
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.6f)),
        shape = RoundedCornerShape(18.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.padding(18.dp)) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleLarge,
                color = InkDark,
            )
            Spacer(Modifier.height(12.dp))
            content()
        }
    }
}

@Composable
private fun DiagnosticRow(
    label: String,
    value: String,
    valueTone: androidx.compose.ui.graphics.Color? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text = label, style = MaterialTheme.typography.bodyMedium, color = InkMutedDark)
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            color = valueTone ?: InkDark,
            textAlign = TextAlign.End,
            modifier = Modifier.widthIn(max = 320.dp),
        )
    }
}

@Composable
private fun Banner(text: String, tone: androidx.compose.ui.graphics.Color) {
    Card(
        colors = CardDefaults.cardColors(containerColor = tone.copy(alpha = 0.16f)),
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = InkDark,
            modifier = Modifier.padding(14.dp),
        )
    }
}

private fun batteryText(pct: Int?): String = if (pct == null) "—" else "$pct%"

@Composable
private fun lastCheckInText(ms: Long?): String {
    if (ms == null) return stringResource(R.string.diag_never)
    val elapsed = System.currentTimeMillis() - ms
    return when {
        elapsed < 10_000 -> stringResource(R.string.diag_just_now)
        elapsed < 60_000 -> stringResource(R.string.diag_seconds_ago, (elapsed / 1000).toInt())
        else -> stringResource(R.string.diag_minutes_ago, (elapsed / 60_000).toInt())
    }
}

@Composable
private fun shortFingerprint(fp: String?): String {
    if (fp.isNullOrBlank()) return stringResource(R.string.diag_unknown)
    // Show the first and last 8 hex chars so a human can compare it, without a wall of hex.
    return if (fp.length > 20) "${fp.take(8)}…${fp.takeLast(8)}" else fp
}
