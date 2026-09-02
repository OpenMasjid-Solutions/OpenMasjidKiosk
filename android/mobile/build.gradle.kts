// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import java.io.File
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

/**
 * `:mobile` — **OpenMasjid Mobile Donations**.
 *
 * A volunteer's own phone at a fundraising event: they open the masjid's address, download this,
 * pair with a 6-digit code, and start taking cards on a Stripe Reader M2 over Bluetooth or USB.
 *
 * It is NOT a kiosk, and the difference is the whole point of it being a separate app rather than
 * a mode of the other one. It is somebody's personal phone: it does not become the HOME launcher,
 * does not enter Lock Task, has no exit PIN, no boot receiver and no device-admin receiver. All of
 * that lives in `:app` and none of it would be acceptable here. What the two DO share — the server
 * client, pairing, the device store, the Terminal reader, the design tokens — is `:core`.
 *
 * Distributed by sideload from the masjid's own server, exactly like the kiosk APK. No app store.
 */
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// versionName comes from the repo-root VERSION file, same as the kiosk and the server, so the
// three halves of one release never disagree. Duplicated from app/build.gradle.kts rather than
// hoisted: four lines, and hoisting would mean editing the kiosk's build file for no behaviour
// change, on a repo where the only Kotlin compiler is CI.
val appVersionName: String = runCatching {
    File(rootProject.projectDir, "../VERSION").readText().trim()
}.getOrNull()?.takeIf { it.isNotEmpty() } ?: "0.1.0"

fun secret(name: String): String? =
    (project.findProperty(name) as String?) ?: System.getenv(name)

val keystoreFile: String? = secret("KEYSTORE_FILE")

android {
    namespace = "org.openmasjidos.mobile"
    compileSdk = 35

    defaultConfig {
        // PERMANENT once anyone installs it: Android identifies an app by this, so changing it
        // later is a fresh install rather than an update, and would strand the device token and
        // pairing on every phone already carrying it.
        applicationId = "org.openmasjidos.mobile"
        minSdk = 26          // Stripe Terminal SDK floor, same as :core and the kiosk
        targetSdk = 35
        // Hardcoded 1, exactly as the kiosk does and for the same reason: this is sideloaded, and
        // an equal versionCode is a permitted REINSTALL. Bumping it per build would make an older
        // APK a genuine downgrade that Android refuses to install, which is a trap on a volunteer's
        // phone at an event. (This is also why Google Play was the wrong home for this app: Play
        // demands the opposite, a strictly increasing versionCode on every upload.)
        versionCode = 1
        versionName = appVersionName

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
            // BouncyCastle and a Stripe Terminal transitive dep both ship this OSGi metadata, which
            // collides at resource-merge time and is unused on Android. Same exclusion the kiosk
            // needs, for the same two dependencies, both of which arrive through :core.
            excludes += "/META-INF/versions/9/OSGI-INF/MANIFEST.MF"
            excludes += "/META-INF/versions/9/OSGI-INF/**"
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    // Everything real lives here: the server client, pairing, the device store, the Stripe Terminal
    // M2 driver and the design tokens. :core exposes its dependencies as `api`, so Compose, OkHttp,
    // coroutines and the Terminal SDK all arrive with it.
    implementation(project(":core"))

    implementation(libs.androidx.activity.compose)

    debugImplementation(libs.androidx.ui.tooling)
}
