// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import org.openmasjidos.kiosk.ui.theme.SuccessDark
import kotlin.math.PI
import kotlin.math.sin

/**
 * A calm, wordless hint that points a donor to the physical card reader while they're paying: a
 * pulsing contactless (NFC) symbol pinned to the reader's side of the screen, with arrows marching
 * toward it. When the payment clears the symbol turns green and the arrows fade away.
 *
 * `side` is the reader's position in the app's LOGICAL landscape space ("left" / "right" / "off").
 * The whole kiosk UI is drawn inside [RotatedRoot], so on a portrait mount left/right naturally become
 * top/bottom — the admin sets it once per tablet and it follows the mount.
 *
 * Called from within a full-screen Box (see GivingHome); it aligns itself to the chosen edge.
 */
@Composable
fun BoxScope.NfcReaderHint(
    side: String,
    active: Boolean,
    cleared: Boolean,
    accent: Color,
    modifier: Modifier = Modifier,
) {
    val onLeft = side == "left"
    val show = (onLeft || side == "right") && (active || cleared)
    if (!show) return

    val color = if (cleared) SuccessDark else accent
    Row(
        modifier = modifier
            .align(if (onLeft) Alignment.CenterStart else Alignment.CenterEnd)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        // Symbol hugs the edge; arrows sit inboard of it and point back toward it.
        if (onLeft) {
            NfcSymbol(color = color, faceInboardLeft = true, pulsing = !cleared)
            MarchingArrows(pointLeft = true, color = color, active = active && !cleared)
        } else {
            MarchingArrows(pointLeft = false, color = color, active = active && !cleared)
            NfcSymbol(color = color, faceInboardLeft = false, pulsing = !cleared)
        }
    }
}

/** The universal contactless mark — three nested arcs radiating from a dot near the reader edge, so it
 *  reads as waves coming off the reader toward the donor. Pulses gently while waiting; steady green
 *  once cleared. [faceInboardLeft] = reader on the LEFT, so the waves open to the right (inboard). */
@Composable
private fun NfcSymbol(color: Color, faceInboardLeft: Boolean, pulsing: Boolean) {
    val t = rememberInfiniteTransition(label = "nfc-pulse")
    val pulse by t.animateFloat(
        initialValue = 0.86f,
        targetValue = 1.12f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "nfc-scale",
    )
    val scale = if (pulsing) pulse else 1f
    Canvas(
        modifier = Modifier
            .size(84.dp)
            .graphicsLayer { scaleX = scale; scaleY = scale },
    ) {
        val stroke = size.minDimension * 0.085f
        val cy = size.height / 2f
        // Source dot near the edge; arcs open toward the screen centre.
        val cx = if (faceInboardLeft) size.width * 0.14f else size.width * 0.86f
        val startAngle = if (faceInboardLeft) -55f else 125f // 0° = east; open right vs. open left
        val sweep = 110f
        for (i in 1..3) {
            val r = size.minDimension * (0.16f + i * 0.13f)
            drawArc(
                color = color,
                startAngle = startAngle,
                sweepAngle = sweep,
                useCenter = false,
                topLeft = Offset(cx - r, cy - r),
                size = Size(r * 2, r * 2),
                style = Stroke(width = stroke, cap = StrokeCap.Round),
            )
        }
        drawCircle(color = color, radius = stroke * 0.95f, center = Offset(cx, cy))
    }
}

/** Three chevrons pointing at the symbol, with a brightness that travels toward it (marching-ants) so
 *  the eye is led to the reader. Fades out when [active] is false (payment done). */
@Composable
private fun MarchingArrows(pointLeft: Boolean, color: Color, active: Boolean) {
    val t = rememberInfiniteTransition(label = "nfc-arrows")
    val phase by t.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1100, easing = LinearEasing)),
        label = "nfc-phase",
    )
    val groupAlpha by animateFloatAsState(if (active) 1f else 0f, tween(400), label = "nfc-arrows-fade")
    Canvas(
        modifier = Modifier
            .size(width = 104.dp, height = 60.dp)
            .graphicsLayer { alpha = groupAlpha },
    ) {
        val n = 3
        val slotW = size.width / n
        val halfW = slotW * 0.30f
        val halfH = size.height * 0.30f
        val stroke = size.height * 0.11f
        val cy = size.height / 2f
        for (k in 0 until n) {
            // k ranks chevrons by distance from the symbol (0 = nearest). Place the nearest on the
            // symbol's side, and make the bright spot sweep far → near as `phase` grows, so the motion
            // reads as flowing toward the reader.
            val slot = if (pointLeft) k else (n - 1 - k)
            val cx = slotW * (slot + 0.5f)
            val wave = 0.5f + 0.5f * sin(2f * PI.toFloat() * (phase - (n - 1 - k) / n.toFloat()))
            val a = 0.28f + 0.72f * wave
            drawChevron(cx, cy, halfW, halfH, pointLeft, color.copy(alpha = a), stroke)
        }
    }
}

/** One "<" (pointLeft) or ">" chevron, apex on the side it points to. */
private fun DrawScope.drawChevron(
    cx: Float,
    cy: Float,
    halfW: Float,
    halfH: Float,
    pointLeft: Boolean,
    color: Color,
    stroke: Float,
) {
    val apexX = if (pointLeft) cx - halfW else cx + halfW
    val backX = if (pointLeft) cx + halfW else cx - halfW
    val apex = Offset(apexX, cy)
    drawLine(color, apex, Offset(backX, cy - halfH), strokeWidth = stroke, cap = StrokeCap.Round)
    drawLine(color, apex, Offset(backX, cy + halfH), strokeWidth = stroke, cap = StrokeCap.Round)
}
