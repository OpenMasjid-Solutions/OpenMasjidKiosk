// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk

import android.app.admin.DeviceAdminReceiver

/**
 * Device admin receiver required for true kiosk (Lock Task Mode) once the tablet is
 * provisioned as device owner via a one-time ADB step (docs/TABLET_SETUP.md, later slice):
 *
 *   adb shell dpm set-device-owner org.openmasjidos.kiosk/.KioskAdminReceiver
 *
 * No admin policies are enforced yet — its presence (plus the res/xml/device_admin metadata)
 * is what device-owner provisioning needs.
 */
class KioskAdminReceiver : DeviceAdminReceiver()
