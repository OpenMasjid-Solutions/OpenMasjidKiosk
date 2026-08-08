// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import java.io.File
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// --- versionName: single source of truth is the repo-root VERSION file ---------------
// The Android project root (rootProject.projectDir) is .../OpenMasjidKiosk/android,
// so the repo-root VERSION lives one level up. Fall back to "0.1.0" if it is absent
// (e.g. a fresh checkout of just the android/ folder).
val appVersionName: String = runCatching {
    File(rootProject.projectDir, "../VERSION").readText().trim()
}.getOrNull()?.takeIf { it.isNotEmpty() } ?: "0.1.0"

// --- Update-channel suffix ------------------------------------------------------------
// CI no longer passes one, on either channel: VERSION itself now carries a real prerelease on the
// dev branch (X.Y.Z-dev.N), and that is what distinguishes a dev APK from a release. The hook stays
// for local builds, but it is fenced.
//
// The fence matters. The SERVER bundled in the same image reports VERSION too, the heartbeat sends
// it to the tablet as `latestAppVersion`, and the tablet decides an update is available by plain
// string inequality against this versionName. If the two halves ever disagree, every kiosk shows
// "update available" for ever and installing never clears it — which is exactly what happened:
// build-image.yml stopped passing a suffix while build-apk.yml kept appending "-dev", so the
// 0.11.0-dev.1 image shipped an APK calling itself "0.11.0-dev.1-dev".
//
// So this mirrors server/src/config.ts applyVersionSuffix, including its rule that a version which
// ALREADY carries a prerelease is left alone: there is nothing left to disambiguate, and appending
// would produce a string no comparison can order.
val appVersionSuffix: String =
    ((project.findProperty("APP_VERSION_SUFFIX") as String?) ?: System.getenv("APP_VERSION_SUFFIX") ?: "")
        .trim()
        .takeIf { Regex("^-[A-Za-z0-9][A-Za-z0-9.-]{0,19}$").matches(it) }
        ?.takeIf { !appVersionName.contains("-") }
        ?: ""

// --- Release signing (CI only) -------------------------------------------------------
// The release signing config is created ONLY when a KEYSTORE_FILE is provided (Gradle
// property or env var), so CI can sign release builds with secrets from GitHub Actions.
// When it is absent the release build is simply left unsigned, and `assembleDebug` always
// works with the default debug keystore. Values are read from a Gradle property first,
// then the environment.
fun secret(name: String): String? =
    (project.findProperty(name) as String?) ?: System.getenv(name)

val keystoreFile: String? = secret("KEYSTORE_FILE")

android {
    namespace = "org.openmasjidos.kiosk"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.openmasjidos.kiosk"
        minSdk = 26          // Stripe Terminal SDK floor
        targetSdk = 35
        versionCode = 1
        versionName = appVersionName
        // "" on the stable channel, "-dev" on a dev-branch CI build (see appVersionSuffix above).
        // Set on defaultConfig so it applies to release AND debug builds alike. versionCode is
        // deliberately NOT touched: it is a hardcoded 1 on every branch and tag, which is what
        // lets a dev and a stable APK install over each other in place (equal versionCode is a
        // reinstall, not a downgrade). Introducing a higher dev versionCode would trap tablets —
        // the stable APK would then be a genuine downgrade and refuse to install.
        if (appVersionSuffix.isNotEmpty()) versionNameSuffix = appVersionSuffix

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables { useSupportLibrary = true }
    }

    signingConfigs {
        if (keystoreFile != null) {
            create("release") {
                storeFile = file(keystoreFile)
                storePassword = secret("KEYSTORE_PASSWORD")
                keyAlias = secret("KEY_ALIAS")
                keyPassword = secret("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // Attach the release signing config only when it was actually created above.
            if (keystoreFile != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            // BouncyCastle (bcprov-jdk18on) and a Stripe Terminal transitive dep both ship this
            // OSGi metadata file, which collides at resource-merge time. It isn't used at runtime
            // on Android, so drop the duplicate. (Also cover the sibling OSGI-INF/version files.)
            excludes += "/META-INF/versions/9/OSGI-INF/MANIFEST.MF"
            excludes += "/META-INF/versions/9/OSGI-INF/**"
        }
    }
}

// Keep Kotlin's JVM target in step with the Java compileOptions above (Kotlin 2.0 uses
// the top-level `kotlin` extension for this, not a block inside `android`).
kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.activity.compose)

    // Compose BOM keeps all Compose artifacts on a mutually compatible set of versions.
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)

    // --- Slice 4: pairing, pinned-HTTPS networking, kiosk lockdown, heartbeats ---
    implementation(libs.androidx.datastore.preferences)  // device token / config / pinned cert at rest
    implementation(libs.androidx.work.runtime.ktx)        // backstop heartbeat when backgrounded
    implementation(libs.okhttp)                           // pinned-HTTPS client (self-signed LAN cert)
    implementation(libs.androidx.webkit)                  // WebViewAssetLoader — keyed-entry Stripe.js form
    implementation(libs.kotlinx.coroutines.android)       // IO dispatcher for blocking OkHttp calls
    implementation(libs.bouncycastle)                     // offline SCrypt PIN verification

    // --- Slice 5: Stripe Terminal SDK (M2 reader over Bluetooth + USB) ---
    implementation(libs.stripe.terminal)

    // --- Manual/keyed card entry: Stripe PaymentSheet (card typed into Stripe's own form; the PAN
    //     is tokenised on-device and never reaches our server, same posture as the reader). ---
    //     It transitively pulls bcprov-jdk15to18, which duplicates our bcprov-jdk18on (used for the
    //     PIN). Drop the older one — jdk18on 1.78.1 provides the same classes for both.
    implementation(libs.stripe.payments) {
        exclude(group = "org.bouncycastle", module = "bcprov-jdk15to18")
    }

    // Compose tooling (previews) — debug only.
    debugImplementation(libs.androidx.ui.tooling)
}
