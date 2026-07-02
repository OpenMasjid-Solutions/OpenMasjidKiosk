// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

// Top-level build file. Plugins are declared here with `apply false` and applied
// in the module build scripts (see app/build.gradle.kts). Versions come from the
// version catalog in gradle/libs.versions.toml.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
