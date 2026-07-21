// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * A simple in-app on-screen keyboard for donor name / email entry.
 *
 * Why we ship our own instead of the system IME: the kiosk rotates its UI in-app (RotatedRoot) because
 * many tablets ignore orientation requests. The system keyboard is a SEPARATE OS window that renders in
 * the tablet's real (landscape) orientation, so it appears sideways over the rotated portrait UI. This
 * keyboard is ordinary Compose content, so it rotates WITH the giving screen and always reads upright.
 *
 * It emits characters via [onKey], with [onBackspace] and [onDone]. Letters + a numbers/symbols layer
 * (with the pieces an email needs: @ . _ - digits) cover name and email.
 */
@Composable
fun KioskKeyboard(
    style: SceneStyle,
    onKey: (String) -> Unit,
    onBackspace: () -> Unit,
    onDone: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var shift by remember { mutableStateOf(false) } // one-shot: capitalises the NEXT letter only
    var caps by remember { mutableStateOf(false) } // caps-lock: every letter, until shift is tapped again
    var lastShiftTap by remember { mutableStateOf(0L) }
    var symbols by remember { mutableStateOf(false) }

    // Tapping shift: single tap = one-shot capital; a quick DOUBLE tap = CAPS LOCK; tapping it while
    // caps-locked turns caps back off — standard phone-keyboard behaviour.
    val onShift: () -> Unit = {
        val now = System.currentTimeMillis()
        when {
            caps -> { caps = false; shift = false }
            now - lastShiftTap < 350L -> { caps = true; shift = false }
            else -> shift = !shift
        }
        lastShiftTap = now
    }
    val upper = shift || caps
    val consumeShift: () -> Unit = { if (shift) shift = false } // caps-lock stays on across letters

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!symbols) {
            // A persistent number row — COMPACT (about half height) so it reads as a number strip, not
            // another row of letter keys. Digits are always one tap away (no layer switch).
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                "1234567890".forEach { c -> PlainKey(c.toString(), style, onKey, compact = true) }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                "qwertyuiop".forEach { c -> LetterKey(c, upper, style, onKey, consumeShift) }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Spacer(0.5f)
                "asdfghjkl".forEach { c -> LetterKey(c, upper, style, onKey, consumeShift) }
                Spacer(0.5f)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Key(if (caps) "⇪" else "⇧", style, weight = 1.5f, active = upper, onClick = onShift)
                "zxcvbnm".forEach { c -> LetterKey(c, upper, style, onKey, consumeShift) }
                Key("⌫", style, weight = 1.5f, onClick = onBackspace)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Key("123", style, weight = 1.5f, onClick = { symbols = true })
                Key("@", style, onClick = { onKey("@") })
                Key("space", style, weight = 4f, onClick = { onKey(" ") })
                Key(".", style, onClick = { onKey(".") })
                Key("Done", style, weight = 2f, accent = true, onClick = onDone)
            }
        } else {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                "1234567890".forEach { c -> PlainKey(c.toString(), style, onKey, compact = true) }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                "@.-_+/#%&".forEach { c -> PlainKey(c.toString(), style, onKey) }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Key("ABC", style, weight = 1.5f, onClick = { symbols = false })
                ",?!':;".forEach { c -> PlainKey(c.toString(), style, onKey) }
                Key("⌫", style, weight = 1.5f, onClick = onBackspace)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Key("ABC", style, weight = 1.5f, onClick = { symbols = false })
                Key("space", style, weight = 5f, onClick = { onKey(" ") })
                Key("Done", style, weight = 2f, accent = true, onClick = onDone)
            }
        }
    }
}

/** A letter key: shows upper/lower per [upper] and emits the matching case. [onTyped] runs after a
 *  letter is emitted so a ONE-SHOT shift can clear itself (caps-lock stays on across letters). */
@Composable
private fun RowScope.LetterKey(c: Char, upper: Boolean, style: SceneStyle, onKey: (String) -> Unit, onTyped: () -> Unit) {
    val ch = if (upper) c.uppercaseChar() else c
    Key(ch.toString(), style, onClick = { onKey(ch.toString()); onTyped() })
}

/** A key that emits its own label verbatim (digits / symbols). [compact] = the shorter number-row key. */
@Composable
private fun RowScope.PlainKey(label: String, style: SceneStyle, onKey: (String) -> Unit, compact: Boolean = false) {
    Key(label, style, compact = compact, onClick = { onKey(label) })
}

@Composable
private fun RowScope.Key(
    label: String,
    style: SceneStyle,
    weight: Float = 1f,
    accent: Boolean = false,
    active: Boolean = false,
    compact: Boolean = false,
    onClick: () -> Unit,
) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(8.dp),
        color = if (accent) style.accent else style.tile,
        contentColor = if (accent) style.onAccent else style.tileInk,
        // Letters/actions are tall + thumb-friendly; the number strip is compact (~half height) so it
        // looks like a standard phone number row rather than a second bank of letter keys.
        modifier = Modifier.weight(weight).height(if (compact) 46.dp else 72.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                label,
                style = if (compact) MaterialTheme.typography.titleMedium else MaterialTheme.typography.titleLarge,
                fontWeight = if (accent || active) FontWeight.Bold else FontWeight.Medium,
            )
        }
    }
}

/** A flexible gap the same as a key slot, used to indent a row. */
@Composable
private fun RowScope.Spacer(weight: Float) {
    androidx.compose.foundation.layout.Spacer(Modifier.weight(weight))
}
