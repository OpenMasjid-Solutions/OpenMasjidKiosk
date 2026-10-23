# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 OpenMasjid-Solutions
#
# ProGuard/R8 rules. Minification is off (isMinifyEnabled = false in build.gradle.kts), so
# nothing here is applied. Every dependency, Stripe Terminal included, is already in the build:
# turning minify on means adding their keep rules here first.
