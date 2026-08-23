// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

import org.jetbrains.kotlin.gradle.dsl.JvmTarget

/**
 * `:core` — everything both Android apps share.
 *
 * There are two apps now: `:app`, the locked-down wall **kiosk**, and `:mobile`, the handheld
 * **OpenMasjid Mobile Donations** app a volunteer carries at a fundraising event. They share
 * essentially all of their plumbing — talking to the server, pairing, the device token, the Stripe
 * Terminal reader, the design tokens — and differ only in the shell around it: one is a HOME
 * launcher under Lock Task with a PIN, the other is an ordinary app on somebody's own phone.
 *
 * WHY THE PACKAGE NAMES DID NOT CHANGE. Every file moved here kept its original
 * `org.openmasjidos.kiosk.*` package declaration, so not one `import` in `:app` had to be edited.
 * A Gradle module's `namespace` (below) governs its generated `R` and `BuildConfig` classes and is
 * independent of Kotlin package declarations, so a library may hold packages that do not match it.
 * That mattered more than tidiness here: there is no Android SDK on the maintainer's machine, so
 * CI is the only compiler this code ever meets, and a 10,000-line rename that can only be checked
 * seven minutes at a time is a bad trade against a slightly odd-looking package prefix. Renaming
 * later is a mechanical change that can be done on its own, once there is something to compile
 * against locally.
 *
 * WHY EVERYTHING IS `api` RATHER THAN `implementation`. This module was carved out of `:app`
 * without changing a line of its source, so `:app` still references Stripe Terminal types, OkHttp,
 * coroutine `Flow`s and Compose types that arrive through here. `implementation` would keep those
 * off `:app`'s compile classpath and break the build for no gain. `api` reproduces exactly what a
 * single module gave. Tightening it is a later, separate change.
 */
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    // Deliberately NOT `org.openmasjidos.kiosk` — that is `:app`'s namespace, and two modules
    // sharing one would collide on the generated R/BuildConfig classes.
    namespace = "org.openmasjidos.core"
    compileSdk = 35

    defaultConfig {
        // Matches `:app`. The floor is the Stripe Terminal SDK's, and the shared reader code is
        // exactly what imposes it, so it belongs here rather than being restated by each app.
        minSdk = 26
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        // The shared design tokens (ui/theme) are Compose.
        compose = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    api(libs.androidx.core.ktx)
    api(libs.androidx.lifecycle.runtime.ktx)
    api(libs.androidx.lifecycle.runtime.compose)

    api(platform(libs.androidx.compose.bom))
    api(libs.androidx.ui)
    api(libs.androidx.ui.graphics)
    api(libs.androidx.material3)

    api(libs.androidx.datastore.preferences)  // device token / config / pinned cert at rest
    api(libs.androidx.work.runtime.ktx)       // backstop heartbeat when backgrounded
    api(libs.okhttp)                          // HTTPS client: pinned on a LAN cert, system-CA over the tunnel
    api(libs.kotlinx.coroutines.android)      // IO dispatcher for blocking OkHttp calls
    api(libs.bouncycastle)                    // offline SCrypt PIN verification

    // Stripe Terminal — the M2 over Bluetooth and USB. Shared: the kiosk has one bolted to a wall,
    // a volunteer has one in a pocket, and the code driving it is the same either way.
    api(libs.stripe.terminal)
}
