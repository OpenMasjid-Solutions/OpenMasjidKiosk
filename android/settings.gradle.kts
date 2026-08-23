// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    // Fail the build if a subproject declares its own repositories; keep them central here.
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "OpenMasjidKiosk"

// Two apps on one shared core:
//   :core   everything they share — server client, pairing, device store, Stripe Terminal, theme
//   :app    the locked-down wall KIOSK (HOME launcher, Lock Task, exit PIN)
//   :mobile OpenMasjid Mobile Donations — a volunteer's own phone at a fundraising event
include(":core")
include(":app")
include(":mobile")
