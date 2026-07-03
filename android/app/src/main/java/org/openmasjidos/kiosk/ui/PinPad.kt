// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import org.openmasjidos.kiosk.PinState
import org.openmasjidos.kiosk.R
import org.openmasjidos.kiosk.ui.theme.DangerDark
import org.openmasjidos.kiosk.ui.theme.InkDark
import org.openmasjidos.kiosk.ui.theme.InkMutedDark

private const val MAX_PIN_LENGTH = 12

/**
 * The unlock PIN pad, shown as a full-screen overlay after the hidden corner gesture.
 * The entered digits live in local state and are handed to the ViewModel for OFFLINE scrypt
 * verification. Backoff/lockout is enforced by [state.lockedUntilMs] (computed in the VM).
 */
@Composable
fun PinPad(
    state: PinState,
    onSubmit: (String) -> Unit,
    onCancel: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var entry by remember { mutableStateOf("") }

    // Clear the entry whenever a wrong attempt comes back, so the pad resets for the next try.
    LaunchedEffect(state.wrong, state.attempts) {
        if (state.wrong) entry = ""
    }

    // Live countdown for the lockout message.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(state.lockedUntilMs) {
        while (System.currentTimeMillis() < state.lockedUntilMs) {
            now = System.currentTimeMillis()
            delay(500L)
        }
        now = System.currentTimeMillis()
    }
    val lockedSeconds = ((state.lockedUntilMs - now + 999) / 1000).toInt().coerceAtLeast(0)
    val locked = lockedSeconds > 0

    SceneSurface(modifier = modifier) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier
                .widthIn(max = 360.dp)
                .padding(24.dp),
        ) {
            Text(
                text = stringResource(R.string.pin_title),
                style = MaterialTheme.typography.headlineLarge,
                color = InkDark,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = stringResource(R.string.pin_subtitle),
                style = MaterialTheme.typography.bodyMedium,
                color = InkMutedDark,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(20.dp))
            PinDots(count = entry.length)

            val message = when {
                locked -> stringResource(R.string.pin_error_locked, lockedSeconds)
                state.wrong -> stringResource(R.string.pin_error_wrong)
                else -> null
            }
            Spacer(Modifier.height(12.dp))
            Text(
                text = message ?: " ",
                style = MaterialTheme.typography.bodyMedium,
                color = DangerDark,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(12.dp))

            val enabled = !locked && !state.verifying
            for (row in listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"))) {
                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    row.forEach { d ->
                        Key(label = d, enabled = enabled) {
                            if (entry.length < MAX_PIN_LENGTH) entry += d
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SmallKey(label = stringResource(R.string.pin_delete), enabled = enabled && entry.isNotEmpty()) {
                    entry = entry.dropLast(1)
                }
                Key(label = "0", enabled = enabled) {
                    if (entry.length < MAX_PIN_LENGTH) entry += "0"
                }
                SmallKey(
                    label = stringResource(R.string.pin_unlock),
                    enabled = enabled && entry.isNotEmpty(),
                    emphasised = true,
                ) {
                    onSubmit(entry)
                }
            }

            Spacer(Modifier.height(20.dp))
            TextButton(onClick = onCancel) {
                Text(stringResource(R.string.pin_cancel), color = InkMutedDark)
            }
        }
    }
}

@Composable
private fun PinDots(count: Int) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        val shown = count.coerceAtMost(MAX_PIN_LENGTH)
        // Render a small run of filled dots for entered digits (privacy: never show the digits).
        for (i in 0 until shown) {
            Box(
                modifier = Modifier
                    .size(14.dp)
                    .background(InkDark, CircleShape),
            )
        }
        if (shown == 0) {
            Box(
                modifier = Modifier
                    .size(14.dp)
                    .background(InkMutedDark.copy(alpha = 0.35f), CircleShape),
            )
        }
    }
}

@Composable
private fun Key(label: String, enabled: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.65f),
        modifier = Modifier.size(72.dp),
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxSize()) {
            Text(
                text = label,
                color = InkDark,
                fontSize = 28.sp,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun SmallKey(
    label: String,
    enabled: Boolean,
    emphasised: Boolean = false,
    onClick: () -> Unit,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(14.dp),
        modifier = Modifier
            .widthIn(min = 72.dp)
            .height(72.dp),
    ) {
        Text(
            text = label,
            color = if (emphasised) MaterialTheme.colorScheme.primary else InkMutedDark,
            fontWeight = if (emphasised) FontWeight.SemiBold else FontWeight.Normal,
        )
    }
}
