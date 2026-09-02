// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

// Top-level build file. Plugins are declared here with `apply false` and applied
// in the module build scripts (see app/build.gradle.kts). Versions come from the
// version catalog in gradle/libs.versions.toml.
// EVERY plugin any module applies must be declared HERE, even one only a single module uses.
// `apply false` puts it on the build classpath without applying it to the root project, and a
// module then applies it by alias with no version. Omitting one does not fall back to resolving it
// per-module: the module's versioned request collides with the AGP already on the classpath and
// the build dies with "the plugin is already on the classpath with an unknown version, so
// compatibility cannot be checked" — which is what adding :core did the first time.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
}
