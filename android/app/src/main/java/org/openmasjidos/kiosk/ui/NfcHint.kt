// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
// InfiniteTransition.animateFloat is an EXTENSION (androidx.compose.animation.core.InfiniteTransitionKt),
// so it needs its own import — unlike the top-level animateFloatAsState below. Missing it is what broke
// the build: `t.animateFloat(...)` didn't resolve, `pulse`/`phase` got an error type, and that cascaded
// into the sin() overload ambiguity and the Double-vs-Float mismatch further down this file.
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
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
 * `side` is where the reader physically sits, as the donor sees the giving screen: "left", "right",
 * "top", "bottom", or "off". Set once per tablet in Admin → Devices.
 *
 * TOP/BOTTOM exist for portrait mounts. The claim that rotation made left/right "naturally become"
 * top/bottom was wrong: [RotatedRoot] rotates the whole UI by the angle the admin chose, so on a
 * tablet that is simply portrait (no rotation applied) "left" stays the left of a tall narrow screen —
 * a bezel no donor's hand goes near, while the reader is above or below. So the axis is chosen
 * explicitly instead of inferred, and the hint lays itself out along it.
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
    if (!(active || cleared)) return
    val color = if (cleared) SuccessDark else accent
    val pulsing = !cleared
    val arrowsOn = active && !cleared

    // A portrait-mounted tablet almost always has its reader ABOVE or BELOW the screen, not beside it:
    // on a tall narrow screen "left" points at a bezel no donor's hand is near. So top/bottom lay the
    // whole hint out on the VERTICAL axis — symbol hugging the top or bottom edge, chevrons marching
    // up or down toward it — rather than rotating a sideways arrangement into a space too narrow for it.
    when (side) {
        "left", "right" -> {
            val onLeft = side == "left"
            Row(
                modifier = modifier
                    .align(if (onLeft) Alignment.CenterStart else Alignment.CenterEnd)
                    .padding(horizontal = 18.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                // Symbol hugs the edge; arrows sit inboard of it and point back toward it.
                if (onLeft) {
                    NfcSymbol(color = color, faceInboard = Edge.Left, pulsing = pulsing)
                    MarchingArrows(towards = Edge.Left, color = color, active = arrowsOn)
                } else {
                    MarchingArrows(towards = Edge.Right, color = color, active = arrowsOn)
                    NfcSymbol(color = color, faceInboard = Edge.Right, pulsing = pulsing)
                }
            }
        }
        "top", "bottom" -> {
            val onTop = side == "top"
            Column(
                modifier = modifier
                    .align(if (onTop) Alignment.TopCenter else Alignment.BottomCenter)
                    .padding(vertical = 18.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                if (onTop) {
                    NfcSymbol(color = color, faceInboard = Edge.Top, pulsing = pulsing)
                    MarchingArrows(towards = Edge.Top, color = color, active = arrowsOn)
                } else {
                    MarchingArrows(towards = Edge.Bottom, color = color, active = arrowsOn)
                    NfcSymbol(color = color, faceInboard = Edge.Bottom, pulsing = pulsing)
                }
            }
        }
        else -> return // "off", or anything a newer admin build sends that this app doesn't know
    }
}

/** Which edge of the screen the reader is on — and therefore which way everything points. */
private enum class Edge { Left, Right, Top, Bottom }

private val Edge.isVertical: Boolean get() = this == Edge.Top || this == Edge.Bottom

/** The universal contactless mark — three nested arcs radiating from a dot near the reader edge, so it
 *  reads as waves coming off the reader toward the donor. Pulses gently while waiting; steady green
 *  once cleared. [faceInboard] names the reader's edge, so the waves always open toward the screen. */
@Composable
private fun NfcSymbol(color: Color, faceInboard: Edge, pulsing: Boolean) {
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
        // The source dot sits near the reader's edge and the arcs open toward the screen center, so
        // the waves always read as coming OFF the reader toward the donor. 0° is east and angles run
        // clockwise, so each edge gets its own start angle; the 110° sweep is the same for all four.
        val cx = when (faceInboard) {
            Edge.Left -> size.width * 0.14f
            Edge.Right -> size.width * 0.86f
            else -> size.width / 2f
        }
        val cy = when (faceInboard) {
            Edge.Top -> size.height * 0.14f
            Edge.Bottom -> size.height * 0.86f
            else -> size.height / 2f
        }
        val startAngle = when (faceInboard) {
            Edge.Left -> -55f // opens right (inboard)
            Edge.Right -> 125f // opens left
            Edge.Top -> 35f // opens down
            Edge.Bottom -> 215f // opens up
        }
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
private fun MarchingArrows(towards: Edge, color: Color, active: Boolean) {
    val t = rememberInfiniteTransition(label = "nfc-arrows")
    val phase by t.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(1100, easing = LinearEasing)),
        label = "nfc-phase",
    )
    val groupAlpha by animateFloatAsState(if (active) 1f else 0f, tween(400), label = "nfc-arrows-fade")
    // The strip runs ALONG the axis it points down, so a vertical hint is tall and narrow rather than
    // a wide strip squeezed under a portrait screen's symbol.
    val vertical = towards.isVertical
    Canvas(
        modifier = Modifier
            .size(width = if (vertical) 96.dp else 168.dp, height = if (vertical) 168.dp else 96.dp)
            .graphicsLayer { alpha = groupAlpha },
    ) {
        val n = 3
        // `along` is the axis the chevrons march down; `across` is the one they span.
        val along = if (vertical) size.height else size.width
        val across = if (vertical) size.width else size.height
        val slot = along / n
        val halfAlong = slot * 0.34f // half-depth, apex to back
        val halfAcross = across * 0.38f // half-width of the V
        val stroke = across * 0.13f
        val mid = across / 2f
        // Nearest chevron goes on the symbol's side. For Left and Top the symbol precedes the strip,
        // so slot 0 is nearest; for Right and Bottom it follows it, so the order reverses.
        val nearestFirst = towards == Edge.Left || towards == Edge.Top
        for (k in 0 until n) {
            val index = if (nearestFirst) k else (n - 1 - k)
            val center = slot * (index + 0.5f)
            // The bright spot sweeps far → near as `phase` grows, so the motion reads as flowing
            // toward the reader rather than away from it.
            val wave = 0.5f + 0.5f * sin(2f * PI.toFloat() * (phase - (n - 1 - k) / n.toFloat()))
            val a = 0.28f + 0.72f * wave
            drawChevron(center, mid, halfAlong, halfAcross, towards, color.copy(alpha = a), stroke)
        }
    }
}

/** One chevron — "<" ">" "^" or "v" — with its apex on the side it points to. [alongPos] is the
 *  position down the marching axis and [acrossPos] the center of the other one. */
private fun DrawScope.drawChevron(
    alongPos: Float,
    acrossPos: Float,
    halfAlong: Float,
    halfAcross: Float,
    towards: Edge,
    color: Color,
    stroke: Float,
) {
    // Apex sits toward the reader; the two tails fan back and out across the other axis.
    val forward = if (towards == Edge.Left || towards == Edge.Top) -1f else 1f
    val apexAlong = alongPos + forward * halfAlong
    val backAlong = alongPos - forward * halfAlong
    val (apex, tail1, tail2) = if (towards.isVertical) {
        Triple(
            Offset(acrossPos, apexAlong),
            Offset(acrossPos - halfAcross, backAlong),
            Offset(acrossPos + halfAcross, backAlong),
        )
    } else {
        Triple(
            Offset(apexAlong, acrossPos),
            Offset(backAlong, acrossPos - halfAcross),
            Offset(backAlong, acrossPos + halfAcross),
        )
    }
    drawLine(color, apex, tail1, strokeWidth = stroke, cap = StrokeCap.Round)
    drawLine(color, apex, tail2, strokeWidth = stroke, cap = StrokeCap.Round)
}
