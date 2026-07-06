// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.kiosk

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File

/**
 * Installs a downloaded kiosk APK. Launches the system package installer via a FileProvider
 * content:// URI (file:// is blocked on modern Android).
 *
 * On a DEVICE-OWNER tablet the OS can apply this without a prompt; otherwise the installer shows a
 * one-tap confirmation (Android does not let an ordinary app update itself silently — same limit as
 * remote reboot). The bytes are downloaded over the pinned HTTPS connection by
 * [org.openmasjidos.kiosk.net.KioskRepository.downloadApk].
 */
object AppUpdater {

    /** Where the downloaded APK is staged (must match res/xml/file_paths.xml). */
    fun apkFile(context: Context): File = File(context.filesDir, "updates/kiosk.apk")

    /** Launch the installer for [apk]. Returns false if the file is missing/too small or the
     *  installer couldn't be started. */
    fun install(context: Context, apk: File): Boolean {
        if (!apk.exists() || apk.length() < 1000L) return false
        return try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", apk)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }
}
