// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.local

import org.json.JSONArray
import org.json.JSONObject

/**
 * One place that turns campaigns between JSON and [Campaign] — used by the network parser (server
 * → config) AND by [DeviceStore] (persisting the config locally), so the two never drift.
 */
object CampaignJson {

    fun parseList(arr: JSONArray?): List<Campaign> {
        if (arr == null) return emptyList()
        return buildList {
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                add(parse(o))
            }
        }
    }

    fun parse(o: JSONObject): Campaign {
        val presetsArr = o.optJSONArray("presetsMinor")
        val presets = buildList {
            if (presetsArr != null) for (i in 0 until presetsArr.length()) add(presetsArr.optLong(i))
        }
        return Campaign(
            id = o.optString("id", ""),
            title = o.optString("title", ""),
            description = o.optString("description", ""),
            primaryColor = o.optString("primaryColor", ""),
            accentColor = o.optString("accentColor", ""),
            backgroundImage = o.optString("backgroundImage", ""),
            coverImage = o.optString("coverImage", ""),
            logo = o.optString("logo", ""),
            presetsMinor = presets,
            allowCustom = o.optBoolean("allowCustom", true),
            customMinMinor = o.optLong("customMinMinor", 100),
            customMaxMinor = o.optLong("customMaxMinor", 1_000_000),
            monthlyEnabled = o.optBoolean("monthlyEnabled", false),
            coverFees = o.optBoolean("coverFees", false),
            forceCoverFees = o.optBoolean("forceCoverFees", false),
            thankYouMessage = o.optString("thankYouMessage", ""),
            theme = o.optString("theme", "auto"),
            isMain = o.optBoolean("isMain", false),
            readerCapable = o.optBoolean("readerCapable", true),
        )
    }

    fun toJsonString(list: List<Campaign>): String {
        val arr = JSONArray()
        list.forEach { c ->
            val presets = JSONArray()
            c.presetsMinor.forEach { presets.put(it) }
            arr.put(
                JSONObject()
                    .put("id", c.id)
                    .put("title", c.title)
                    .put("description", c.description)
                    .put("primaryColor", c.primaryColor)
                    .put("accentColor", c.accentColor)
                    .put("backgroundImage", c.backgroundImage)
                    .put("coverImage", c.coverImage)
                    .put("logo", c.logo)
                    .put("presetsMinor", presets)
                    .put("allowCustom", c.allowCustom)
                    .put("customMinMinor", c.customMinMinor)
                    .put("customMaxMinor", c.customMaxMinor)
                    .put("monthlyEnabled", c.monthlyEnabled)
                    .put("coverFees", c.coverFees)
                    .put("forceCoverFees", c.forceCoverFees)
                    .put("thankYouMessage", c.thankYouMessage)
                    .put("theme", c.theme)
                    .put("isMain", c.isMain)
                    .put("readerCapable", c.readerCapable),
            )
        }
        return arr.toString()
    }

    fun parseString(json: String?): List<Campaign> {
        if (json.isNullOrBlank()) return emptyList()
        return runCatching { parseList(JSONArray(json)) }.getOrDefault(emptyList())
    }
}
