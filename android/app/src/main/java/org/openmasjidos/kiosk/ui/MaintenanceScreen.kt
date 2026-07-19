// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import org.openmasjidos.kiosk.R
import org.openmasjidos.kiosk.local.Diagnostics
import org.openmasjidos.kiosk.net.PinnedHttp
import org.openmasjidos.kiosk.readers.ReaderConn
import org.openmasjidos.kiosk.readers.ReaderTransport
import org.openmasjidos.kiosk.readers.ReaderUiState
import org.openmasjidos.kiosk.readers.readerPermissions
import org.openmasjidos.kiosk.ui.theme.DangerDark
import org.openmasjidos.kiosk.ui.theme.InkDark
import org.openmasjidos.kiosk.ui.theme.InkMutedDark
import org.openmasjidos.kiosk.ui.theme.SuccessDark
import org.openmasjidos.kiosk.ui.theme.WarningDark

/**
 * The PIN-protected maintenance screen: diagnostics, the card-reader setup (slice 5), re-pairing,
 * and the kiosk exit/return controls. Everything here is reachable only after the exit PIN, so it's
 * safe to request Bluetooth/USB permissions from within it.
 */
@Composable
fun MaintenanceScreen(
    diagnostics: Diagnostics,
    reader: ReaderUiState,
    locationId: String,
    noPinSet: Boolean,
    exitAllowed: Boolean,
    showPinningHint: Boolean,
    onScanReaders: (ReaderTransport) -> Unit,
    onStopReaderScan: () -> Unit,
    onConnectReader: (String) -> Unit,
    onDisconnectReader: () -> Unit,
    onInstallReaderUpdate: () -> Unit,
    onDismissReaderError: () -> Unit,
    onReaderPermissionDenied: () -> Unit,
    onUpdateApp: () -> Unit,
    onSetHomeApp: () -> Unit,
    onOpenSettings: () -> Unit,
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
                Spacer(Modifier.height(8.dp))
                // Make Home return to the kiosk (become the default launcher) — the biggest non-owner
                // improvement, so pressing Home stops showing a launcher chooser.
                Button(
                    onClick = onSetHomeApp,
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(stringResource(R.string.kiosk_set_home_app)) }
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
                DiagnosticRow(
                    stringResource(R.string.diag_reader),
                    readerStatusText(diagnostics.readerStatus),
                    valueTone = if (diagnostics.readerStatus == "connected") SuccessDark else null,
                )
                DiagnosticRow(stringResource(R.string.diag_last_checkin), lastCheckInText(diagnostics.lastHeartbeatMs))
                DiagnosticRow(stringResource(R.string.diag_uptime), uptimeText(diagnostics.uptimeMs))
                DiagnosticRow(stringResource(R.string.diag_app_version), diagnostics.appVersion.ifBlank { stringResource(R.string.diag_unknown) })
                DiagnosticRow(stringResource(R.string.diag_device_id), diagnostics.deviceId ?: stringResource(R.string.diag_unknown))
                DiagnosticRow(stringResource(R.string.diag_server), diagnostics.serverUrl ?: stringResource(R.string.diag_unknown))
                DiagnosticRow(stringResource(R.string.diag_certificate), shortFingerprint(diagnostics.pinnedCertSha256))
            }

            Spacer(Modifier.height(16.dp))

            // --- Card reader -----------------------------------------------------------
            SectionCard(title = stringResource(R.string.maintenance_reader_title)) {
                ReaderControls(
                    reader = reader,
                    locationId = locationId,
                    onScanReaders = onScanReaders,
                    onStopReaderScan = onStopReaderScan,
                    onConnectReader = onConnectReader,
                    onDisconnectReader = onDisconnectReader,
                    onInstallReaderUpdate = onInstallReaderUpdate,
                    onDismissReaderError = onDismissReaderError,
                    onReaderPermissionDenied = onReaderPermissionDenied,
                )
            }

            // --- App update — Android can't update an ordinary app itself, so "Update app" opens
            //     the newest APK link in the browser to download + install (same as first install) --
            val updateAvailable = diagnostics.latestAppVersion.isNotBlank() &&
                diagnostics.appVersion.isNotBlank() &&
                diagnostics.latestAppVersion != diagnostics.appVersion
            if (updateAvailable) {
                Spacer(Modifier.height(16.dp))
                SectionCard(title = stringResource(R.string.maintenance_update_title)) {
                    Text(
                        text = stringResource(R.string.maintenance_update_body, diagnostics.latestAppVersion, diagnostics.appVersion),
                        style = MaterialTheme.typography.bodyMedium,
                        color = InkDark,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        text = stringResource(R.string.maintenance_update_how),
                        style = MaterialTheme.typography.bodyMedium,
                        color = InkMutedDark,
                    )
                    Spacer(Modifier.height(12.dp))
                    Button(
                        onClick = onUpdateApp,
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.primary,
                            contentColor = MaterialTheme.colorScheme.onPrimary,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(stringResource(R.string.maintenance_update_button)) }
                }
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

            Spacer(Modifier.height(16.dp))

            // --- Tablet settings — jump to Android Settings (Wi-Fi, launcher, etc.). Drops kiosk
            //     lockdown so Settings can open; the kiosk re-locks when the maintainer returns. ----
            SectionCard(title = stringResource(R.string.maintenance_tablet_title)) {
                OutlinedButton(
                    onClick = onOpenSettings,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.maintenance_android_settings), color = InkDark)
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
            // Leaving kiosk mode requires a verified exit PIN this session (see KioskViewModel):
            // when maintenance was opened without one (no PIN set, or config not yet synced), show a
            // note instead of the exit button so the lock can't be bypassed in the pre-sync window.
            if (exitAllowed) {
                OutlinedButton(
                    onClick = onExit,
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(54.dp),
                ) {
                    Text(stringResource(R.string.maintenance_exit), color = DangerDark)
                }
            } else {
                Banner(text = stringResource(R.string.maintenance_exit_needs_pin), tone = InkMutedDark)
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReaderControls(
    reader: ReaderUiState,
    locationId: String,
    onScanReaders: (ReaderTransport) -> Unit,
    onStopReaderScan: () -> Unit,
    onConnectReader: (String) -> Unit,
    onDisconnectReader: () -> Unit,
    onInstallReaderUpdate: () -> Unit,
    onDismissReaderError: () -> Unit,
    onReaderPermissionDenied: () -> Unit,
) {
    val context = LocalContext.current
    // The manual picker is for Bluetooth (or the test reader) only — USB connects itself, so it's
    // never a manual choice here. Default to Bluetooth regardless of the last transport used.
    var selected by remember { mutableStateOf(if (reader.transport == ReaderTransport.Simulated) ReaderTransport.Simulated else ReaderTransport.Bluetooth) }
    var pending by remember { mutableStateOf<ReaderTransport?>(null) }
    val permLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        val t = pending
        pending = null
        when {
            t == null -> Unit
            result.values.all { it } -> onScanReaders(t)
            else -> onReaderPermissionDenied() // don't leave the Scan button a silent no-op
        }
    }
    fun startScan(t: ReaderTransport) {
        val perms = readerPermissions(t)
        val granted = perms.all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
        if (perms.isEmpty() || granted) onScanReaders(t) else { pending = t; permLauncher.launch(perms) }
    }

    // --- Status line ---
    Text(
        text = readerConnText(reader.conn),
        style = MaterialTheme.typography.bodyLarge,
        color = if (reader.conn == ReaderConn.Connected) SuccessDark else InkDark,
    )
    reader.connectedLabel?.let {
        Spacer(Modifier.height(4.dp))
        Text(it, style = MaterialTheme.typography.bodyMedium, color = InkMutedDark)
    }
    if (reader.battery != null) {
        Spacer(Modifier.height(4.dp))
        val charge = if (reader.charging == true) " · " + stringResource(R.string.reader_charging) else ""
        Text(
            text = stringResource(R.string.reader_battery, reader.battery) + charge,
            style = MaterialTheme.typography.bodyMedium,
            color = InkMutedDark,
        )
    }

    // --- Firmware update in progress ---
    if (reader.conn == ReaderConn.Updating) {
        Spacer(Modifier.height(12.dp))
        Text(stringResource(R.string.reader_updating), style = MaterialTheme.typography.bodyMedium, color = WarningDark)
        Spacer(Modifier.height(8.dp))
        val p = reader.updateProgress
        if (p != null) {
            LinearProgressIndicator(progress = { p / 100f }, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(4.dp))
            Text("$p%", style = MaterialTheme.typography.bodySmall, color = InkMutedDark)
        } else {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
    }

    // --- Error ---
    reader.error?.let { err ->
        Spacer(Modifier.height(12.dp))
        Banner(text = err, tone = DangerDark)
        TextButton(onClick = onDismissReaderError) {
            Text(stringResource(R.string.reader_dismiss), color = InkMutedDark)
        }
    }

    Spacer(Modifier.height(16.dp))

    when {
        reader.conn == ReaderConn.Connected -> {
            if (reader.updateAvailable) {
                FilledTonalButton(
                    onClick = onInstallReaderUpdate,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(stringResource(R.string.reader_install_update)) }
                Spacer(Modifier.height(8.dp))
            }
            OutlinedButton(
                onClick = onDisconnectReader,
                shape = RoundedCornerShape(12.dp),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.reader_disconnect), color = InkDark) }
        }

        reader.conn == ReaderConn.Updating -> Unit // controls hidden while updating

        else -> {
            // USB readers connect on their own; this manual picker is Bluetooth (or the test reader).
            Text(
                stringResource(R.string.reader_usb_auto),
                style = MaterialTheme.typography.bodyMedium,
                color = InkMutedDark,
            )
            Spacer(Modifier.height(12.dp))
            // Transport picker (Bluetooth only — USB connects itself; the test reader was removed).
            // A kiosk with NO reader takes cards by manual entry (enabled in Admin → Giving screen).
            SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                val options = listOf(ReaderTransport.Bluetooth)
                options.forEachIndexed { i, t ->
                    SegmentedButton(
                        selected = selected == t,
                        onClick = { selected = t },
                        shape = SegmentedButtonDefaults.itemShape(i, options.size),
                    ) { Text(transportLabel(t)) }
                }
            }

            if (locationId.isBlank()) {
                Spacer(Modifier.height(12.dp))
                Banner(text = stringResource(R.string.reader_needs_location), tone = WarningDark)
            }

            Spacer(Modifier.height(12.dp))
            if (reader.conn == ReaderConn.Discovering) {
                Button(
                    onClick = onStopReaderScan,
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                    modifier = Modifier.fillMaxWidth().height(50.dp),
                ) { Text(stringResource(R.string.reader_stop_scan)) }
                Spacer(Modifier.height(8.dp))
                Text(stringResource(R.string.reader_scanning), style = MaterialTheme.typography.bodyMedium, color = InkMutedDark)
            } else {
                Button(
                    onClick = { startScan(selected) },
                    enabled = reader.conn != ReaderConn.Connecting, // don't race an in-flight connect
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                    modifier = Modifier.fillMaxWidth().height(50.dp),
                ) { Text(stringResource(R.string.reader_scan)) }
            }

            if (reader.discovered.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                reader.discovered.forEach { dr ->
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = dr.label,
                            style = MaterialTheme.typography.bodyMedium,
                            color = InkDark,
                            modifier = Modifier.widthIn(max = 240.dp),
                        )
                        FilledTonalButton(
                            onClick = { onConnectReader(dr.serial) },
                            enabled = reader.conn != ReaderConn.Connecting,
                            shape = RoundedCornerShape(10.dp),
                        ) { Text(stringResource(R.string.reader_connect)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun readerConnText(conn: ReaderConn): String = when (conn) {
    ReaderConn.Connected -> stringResource(R.string.reader_status_connected)
    ReaderConn.Connecting -> stringResource(R.string.reader_status_connecting)
    ReaderConn.Discovering -> stringResource(R.string.reader_status_discovering)
    ReaderConn.Updating -> stringResource(R.string.reader_status_updating)
    ReaderConn.Error -> stringResource(R.string.reader_status_error)
    ReaderConn.NotConnected -> stringResource(R.string.reader_status_not_connected)
}

@Composable
private fun readerStatusText(code: String): String = when (code) {
    "connected" -> stringResource(R.string.reader_status_connected)
    "connecting" -> stringResource(R.string.reader_status_connecting)
    "discovering" -> stringResource(R.string.reader_status_discovering)
    "updating" -> stringResource(R.string.reader_status_updating)
    "error" -> stringResource(R.string.reader_status_error)
    else -> stringResource(R.string.reader_status_not_connected)
}

@Composable
private fun transportLabel(t: ReaderTransport): String = when (t) {
    ReaderTransport.Bluetooth -> stringResource(R.string.reader_transport_bluetooth)
    ReaderTransport.Usb -> stringResource(R.string.reader_transport_usb)
    ReaderTransport.Simulated -> stringResource(R.string.reader_transport_simulated)
}

private fun batteryText(pct: Int?): String = if (pct == null) "—" else "$pct%"

/** Human uptime like "3h 12m" / "12m" / "45s". */
private fun uptimeText(ms: Long): String {
    if (ms <= 0) return "—"
    val totalMin = ms / 60_000
    val h = totalMin / 60
    val m = totalMin % 60
    return when {
        h > 0 -> "${h}h ${m}m"
        totalMin > 0 -> "${m}m"
        else -> "${ms / 1000}s"
    }
}

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
    // A remotely-adopted kiosk stores the SYSTEM_TRUST sentinel instead of a pinned fingerprint.
    if (fp == PinnedHttp.SYSTEM_TRUST) return stringResource(R.string.diag_cert_system)
    // Show the first and last 8 hex chars so a human can compare it, without a wall of hex.
    return if (fp.length > 20) "${fp.take(8)}…${fp.takeLast(8)}" else fp
}
