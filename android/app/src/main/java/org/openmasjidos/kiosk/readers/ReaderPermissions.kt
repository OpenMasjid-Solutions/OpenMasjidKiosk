// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.readers

import android.Manifest
import android.os.Build

/**
 * The runtime permissions the Stripe Terminal SDK needs to DISCOVER a reader over [transport].
 * (Stripe moved permission checks from init to discovery, and location is required for every
 * discovery config, even USB.) These are requested-and-explained inside the PIN-protected
 * maintenance screen only — never in the donor flow.
 *
 * Legacy Bluetooth permissions (pre-31) are install-time, so they aren't returned here.
 */
fun readerPermissions(transport: ReaderTransport): Array<String> = when (transport) {
    ReaderTransport.Simulated -> emptyArray()
    ReaderTransport.Usb -> arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    ReaderTransport.Bluetooth ->
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.ACCESS_FINE_LOCATION,
            )
        } else {
            arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }
}
