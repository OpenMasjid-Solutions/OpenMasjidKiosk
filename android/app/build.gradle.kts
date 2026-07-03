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
    implementation(libs.kotlinx.coroutines.android)       // IO dispatcher for blocking OkHttp calls
    implementation(libs.bouncycastle)                     // offline SCrypt PIN verification

    // Compose tooling (previews) — debug only.
    debugImplementation(libs.androidx.ui.tooling)
}
