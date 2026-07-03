// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

package org.openmasjidos.kiosk.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.openmasjidos.kiosk.PairingForm
import org.openmasjidos.kiosk.R
import org.openmasjidos.kiosk.net.PairResult
import org.openmasjidos.kiosk.ui.theme.DangerDark
import org.openmasjidos.kiosk.ui.theme.InkDark
import org.openmasjidos.kiosk.ui.theme.InkFaintDark
import org.openmasjidos.kiosk.ui.theme.InkMutedDark
import org.openmasjidos.kiosk.ui.theme.PrimaryDark

/**
 * The setup screen shown while the kiosk is Unpaired. Typed URL + 6-digit code only (no camera,
 * per this slice). Everything is on-scene, so text uses the fixed on-scene inks.
 */
@Composable
fun PairingScreen(
    form: PairingForm,
    onUrlChange: (String) -> Unit,
    onCodeChange: (String) -> Unit,
    onNameChange: (String) -> Unit,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SceneSurface(modifier = modifier) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .imePadding()
                .widthIn(max = 460.dp)
                .padding(horizontal = 28.dp, vertical = 40.dp),
        ) {
            Text(
                text = stringResource(R.string.pairing_title),
                style = MaterialTheme.typography.displayMedium,
                color = InkDark,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(10.dp))
            Text(
                text = stringResource(R.string.pairing_subtitle),
                style = MaterialTheme.typography.bodyLarge,
                color = InkMutedDark,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(28.dp))

            OutlinedTextField(
                value = form.url,
                onValueChange = onUrlChange,
                singleLine = true,
                enabled = !form.busy,
                label = { Text(stringResource(R.string.pairing_server_label)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                colors = onSceneFieldColors(),
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(16.dp))

            OutlinedTextField(
                value = form.code,
                onValueChange = onCodeChange,
                singleLine = true,
                enabled = !form.busy,
                label = { Text(stringResource(R.string.pairing_code_label)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                colors = onSceneFieldColors(),
                modifier = Modifier.fillMaxWidth(),
            )

            Spacer(Modifier.height(16.dp))

            OutlinedTextField(
                value = form.name,
                onValueChange = onNameChange,
                singleLine = true,
                enabled = !form.busy,
                label = { Text(stringResource(R.string.pairing_name_label)) },
                colors = onSceneFieldColors(),
                modifier = Modifier.fillMaxWidth(),
            )

            val errorText = pairErrorText(form.error)
            if (errorText != null) {
                Spacer(Modifier.height(16.dp))
                Text(
                    text = errorText,
                    style = MaterialTheme.typography.bodyMedium,
                    color = DangerDark,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            Spacer(Modifier.height(28.dp))

            Button(
                onClick = onSubmit,
                enabled = !form.busy,
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
            ) {
                if (form.busy) {
                    CircularProgressIndicator(
                        color = MaterialTheme.colorScheme.onPrimary,
                        strokeWidth = 2.dp,
                        modifier = Modifier.size(22.dp),
                    )
                    Spacer(Modifier.width(12.dp))
                    Text(
                        text = stringResource(R.string.pairing_busy),
                        style = MaterialTheme.typography.titleLarge,
                    )
                } else {
                    Text(
                        text = stringResource(R.string.pairing_button),
                        style = MaterialTheme.typography.titleLarge,
                    )
                }
            }
        }
    }
}

/** Maps a [PairResult.Reason] to a friendly, translated message (null when there's no error). */
@Composable
private fun pairErrorText(reason: PairResult.Reason?): String? = when (reason) {
    null -> null
    PairResult.Reason.INVALID_URL -> stringResource(R.string.pairing_error_url)
    PairResult.Reason.INVALID_CODE -> stringResource(R.string.pairing_error_code)
    PairResult.Reason.CODE_REJECTED -> stringResource(R.string.pairing_error_rejected)
    PairResult.Reason.UNREACHABLE -> stringResource(R.string.pairing_error_unreachable)
    PairResult.Reason.CERT -> stringResource(R.string.pairing_error_cert)
    PairResult.Reason.GENERIC -> stringResource(R.string.pairing_error_generic)
}

/** Text-field colours tuned for the dark scene in both themes. */
@Composable
private fun onSceneFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = InkDark,
    unfocusedTextColor = InkDark,
    disabledTextColor = InkMutedDark,
    cursorColor = PrimaryDark,
    focusedBorderColor = PrimaryDark,
    unfocusedBorderColor = InkFaintDark,
    focusedLabelColor = PrimaryDark,
    unfocusedLabelColor = InkMutedDark,
)
