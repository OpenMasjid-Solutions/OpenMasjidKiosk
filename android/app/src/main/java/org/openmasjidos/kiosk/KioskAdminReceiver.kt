// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk

import android.app.admin.DeviceAdminReceiver

/**
 * Device admin receiver required for true kiosk (Lock Task Mode) once the tablet is
 * provisioned as device owner via a one-time ADB step (docs/TABLET_SETUP.md):
 *
 *   adb shell dpm set-device-owner org.openmasjidos.kiosk/.KioskAdminReceiver
 *
 * Deliberately empty — its presence (plus the res/xml/device_admin metadata) is what device-owner
 * provisioning needs. The lockdown itself is applied by KioskController, through DevicePolicyManager
 * with this receiver as the admin component.
 */
class KioskAdminReceiver : DeviceAdminReceiver()
