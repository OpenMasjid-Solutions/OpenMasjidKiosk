// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

private data class Spark(val angle: Float, val speed: Float, val color: Color)
private data class Burst(val x: Float, val y: Float, val startFrac: Float, val sparks: List<Spark>)

private const val DURATION_MS = 3500
private const val BURST_COUNT = 7
private const val SPARKS_PER_BURST = 22
private const val BURST_LIFE = 0.42f // fraction of the total run a single burst is visible

/**
 * A short, joyful fireworks celebration for the thank-you screen: several staggered bursts of sparks
 * fly outward with a little gravity and fade over ~3.5s, then stop (this composable is only in the
 * tree while the thank-you screen shows). Purely decorative — never blocks the flow.
 *
 * Honors reduced-motion: if the system animation scale is 0 (animations turned off in accessibility
 * settings), it draws nothing at all.
 */
@Composable
fun Fireworks(colors: List<Color>, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val animScale = remember {
        runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        }.getOrDefault(1f)
    }
    if (animScale == 0f) return

    val palette = colors.ifEmpty { listOf(Color.White) }
    // Generated once per celebration (a fresh random layout each time the thank-you screen appears).
    val bursts = remember {
        val rnd = Random(System.nanoTime())
        List(BURST_COUNT) { i ->
            val sparks = List(SPARKS_PER_BURST) { s ->
                Spark(
                    angle = (s.toFloat() / SPARKS_PER_BURST) * (2f * PI.toFloat()) + rnd.nextFloat() * 0.3f,
                    speed = 0.10f + rnd.nextFloat() * 0.12f,
                    color = palette[(i + s) % palette.size],
                )
            }
            Burst(
                x = 0.12f + rnd.nextFloat() * 0.76f,
                y = 0.16f + rnd.nextFloat() * 0.42f,
                startFrac = (i.toFloat() / BURST_COUNT) * (1f - BURST_LIFE),
                sparks = sparks,
            )
        }
    }

    val progress = remember { Animatable(0f) }
    LaunchedEffect(Unit) { progress.animateTo(1f, tween(DURATION_MS, easing = LinearEasing)) }
    val p = progress.value

    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val reach = size.minDimension * 0.9f
        bursts.forEach { b ->
            val t = (p - b.startFrac) / BURST_LIFE
            if (t <= 0f || t >= 1f) return@forEach
            val cx = b.x * w
            val cy = b.y * h
            val alpha = (1f - t).coerceIn(0f, 1f)
            val gravity = 0.35f * reach * t * t
            b.sparks.forEach { s ->
                val dist = s.speed * reach * t * 4f
                val x = cx + cos(s.angle) * dist
                val y = cy + sin(s.angle) * dist + gravity
                val r = (7f * (1f - t)).coerceAtLeast(1.5f)
                drawCircle(color = s.color.copy(alpha = alpha), radius = r, center = Offset(x, y))
            }
        }
    }
}
