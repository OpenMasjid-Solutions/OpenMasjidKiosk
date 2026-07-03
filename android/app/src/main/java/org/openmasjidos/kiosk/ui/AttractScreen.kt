// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import org.openmasjidos.kiosk.R
import org.openmasjidos.kiosk.ui.theme.GoldDark
import org.openmasjidos.kiosk.ui.theme.InkDark
import org.openmasjidos.kiosk.ui.theme.InkFaintDark
import org.openmasjidos.kiosk.ui.theme.InkMutedDark
import org.openmasjidos.kiosk.ui.theme.PrimaryDark
import org.openmasjidos.kiosk.ui.theme.PrimaryHoverDark
import org.openmasjidos.kiosk.ui.theme.SakinaTheme
import org.openmasjidos.kiosk.ui.theme.SceneEnd
import org.openmasjidos.kiosk.ui.theme.SceneMid
import org.openmasjidos.kiosk.ui.theme.SceneStart
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * The attract screen — still a placeholder until the giving flow lands (a later slice), but now
 * personalised from the synced config: it shows the masjid's name and attract title once paired.
 *
 * @param masjidName the masjid's name from config, or null before the first config sync.
 * @param attractTitle an admin-set headline, or null to fall back to the default tagline.
 * @param identify when true, briefly brightens the screen so an admin pressing "identify" in
 *   Admin → Devices can spot this exact tablet on the wall.
 *
 * Design notes:
 *  - The scene is dark in BOTH themes (per DESIGN.md §4), so on-scene text uses the fixed
 *    light "on-scene" inks rather than the theme's onBackground (which would flip to dark
 *    in light mode and vanish here).
 *  - The identify highlight is a static opacity overlay (no motion), which also satisfies
 *    prefers-reduced-motion.
 *  - RTL is handled automatically by Compose; nothing here forces a layout direction.
 */
@Composable
fun AttractScreen(
    modifier: Modifier = Modifier,
    masjidName: String? = null,
    attractTitle: String? = null,
    identify: Boolean = false,
) {
    val scene = Brush.linearGradient(
        colors = listOf(SceneStart, SceneMid, SceneEnd),
        start = Offset(0f, 0f),
        end = Offset(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY),
    )

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(scene),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.padding(horizontal = 32.dp),
        ) {
            GeometricAccent(modifier = Modifier.size(148.dp))

            Spacer(Modifier.height(28.dp))

            Text(
                text = masjidName?.takeIf { it.isNotBlank() } ?: stringResource(R.string.app_name),
                style = MaterialTheme.typography.displayMedium,
                color = InkDark,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(10.dp))

            Text(
                text = attractTitle?.takeIf { it.isNotBlank() } ?: stringResource(R.string.attract_tagline),
                style = MaterialTheme.typography.bodyLarge,
                color = InkMutedDark,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(44.dp))

            Button(
                onClick = { /* Non-functional until the giving flow slice. */ },
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ),
                contentPadding = PaddingValues(horizontal = 40.dp, vertical = 20.dp),
                modifier = Modifier.widthIn(min = 260.dp),
            ) {
                Text(
                    text = stringResource(R.string.attract_cta),
                    style = MaterialTheme.typography.titleLarge,
                )
            }
        }

        Text(
            text = stringResource(R.string.attract_scaffold_note),
            style = MaterialTheme.typography.bodyMedium,
            color = InkFaintDark,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(24.dp),
        )

        // Identify: a static, high-opacity gold wash so the admin can pick out this tablet.
        if (identify) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(GoldDark.copy(alpha = 0.28f)),
            )
        }
    }
}

/**
 * A crescent + eight-point star, drawn natively (no image asset, no dependency).
 * The crescent is the difference of two circles; the star sparkle sits to its upper end.
 */
@Composable
private fun GeometricAccent(modifier: Modifier = Modifier) {
    Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height

        // --- Crescent: outer disc minus an offset inner disc ---
        val cx = w * 0.44f
        val cy = h * 0.56f
        val r = w * 0.34f
        val outer = Path().apply { addOval(Rect(Offset(cx, cy), r)) }
        val inner = Path().apply { addOval(Rect(Offset(cx + r * 0.44f, cy - r * 0.06f), r * 0.86f)) }
        val crescent = Path().apply { op(outer, inner, PathOperation.Difference) }
        drawPath(
            path = crescent,
            brush = Brush.linearGradient(
                colors = listOf(PrimaryHoverDark, PrimaryDark),
                start = Offset(cx - r, cy - r),
                end = Offset(cx + r, cy + r),
            ),
        )

        // --- Eight-point star (gold, used sparingly per DESIGN.md) ---
        drawPath(
            path = starPath(
                cx = w * 0.74f,
                cy = h * 0.28f,
                outerRadius = w * 0.12f,
                innerRadius = w * 0.052f,
                points = 8,
            ),
            color = GoldDark,
        )
    }
}

/** Builds a symmetric [points]-pointed star path centred at ([cx], [cy]). */
private fun starPath(
    cx: Float,
    cy: Float,
    outerRadius: Float,
    innerRadius: Float,
    points: Int,
): Path {
    val path = Path()
    val step = PI / points // half-vertex angle
    var angle = -PI / 2.0   // start pointing up
    for (i in 0 until points * 2) {
        val radius = if (i % 2 == 0) outerRadius else innerRadius
        val x = cx + (radius * cos(angle)).toFloat()
        val y = cy + (radius * sin(angle)).toFloat()
        if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
        angle += step
    }
    path.close()
    return path
}

@Preview(showBackground = true, widthDp = 420, heightDp = 760)
@Composable
private fun AttractScreenPreview() {
    SakinaTheme(darkTheme = true) {
        AttractScreen()
    }
}
