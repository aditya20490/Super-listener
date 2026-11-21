package com.voicestudio.app

import android.content.ContentValues
import android.content.Context
import android.media.MediaPlayer
import android.os.Build
import android.provider.MediaStore
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import java.io.File
import androidx.compose.ui.text.font.FontWeight
import com.mymusic.player.StudioAltButton
import com.mymusic.player.StudioButton
import com.mymusic.player.StudioTheme
import com.mymusic.player.studioFieldColors

private fun saveToMusic(ctx: Context, f: File): Boolean {
    if (Build.VERSION.SDK_INT < 29) return false
    val v = ContentValues().apply {
        put(MediaStore.Audio.Media.DISPLAY_NAME, f.name)
        put(MediaStore.Audio.Media.MIME_TYPE, "audio/wav")
        put(MediaStore.Audio.Media.RELATIVE_PATH, "Music/VoiceStudio")
    }
    val uri = ctx.contentResolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, v) ?: return false
    ctx.contentResolver.openOutputStream(uri)?.use { o -> f.inputStream().use { it.copyTo(o) } }
    return true
}

@Composable
fun SpeakTab(voices: List<Voice>) {
    val ctx = LocalContext.current
    val engine = remember { ChatterboxEngine.get(ctx) }
    val dl = Models.downloading
    val ready = remember(dl) { Models.isReady(ctx) }

    var selId by remember { mutableStateOf<String?>(null) }
    var text by remember { mutableStateOf("") }
    var exag by remember { mutableFloatStateOf(0.5f) }
    val player = remember { arrayOfNulls<MediaPlayer>(1) }

    DisposableEffect(Unit) {
        onDispose {
            player[0]?.release()
            player[0] = null
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Speak", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold)

        if (!ready) {
            Text(
                "First, the app needs to download its voice models once (about 790 MB). " +
                    "Use Wi-Fi. After that, everything works fully offline."
            )
            StudioButton(onClick = { Models.startDownload(ctx) }, enabled = !dl, modifier = Modifier.fillMaxWidth()) {
                Text(if (dl) "Downloading..." else "Download models")
            }
            if (dl) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (Models.dlStatus.isNotEmpty()) Text(Models.dlStatus)
            return@Column
        }

        if (voices.isEmpty()) {
            Text("Create a voice first in the Create Voice tab.")
            return@Column
        }

        val selected = voices.find { it.id == selId } ?: voices.first()
        Text("Voice")
        voices.forEach { v ->
            if (v.id == selected.id) {
                StudioButton(onClick = { selId = v.id }, modifier = Modifier.fillMaxWidth()) { Text(v.name) }
            } else {
                StudioAltButton(onClick = { selId = v.id }, modifier = Modifier.fillMaxWidth()) { Text(v.name) }
            }
        }

        OutlinedTextField(
            shape = StudioTheme.fieldShape,
            colors = studioFieldColors(),
            value = text,
            onValueChange = { text = it },
            label = { Text("Text to speak (Hindi or English)") },
            minLines = 4,
            modifier = Modifier.fillMaxWidth()
        )

        Text("Expression: ${"%.2f".format(exag)}  (0.5 is normal)")
        Slider(value = exag, onValueChange = { exag = it }, valueRange = 0.25f..1.0f)

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StudioButton(
                onClick = {
                    player[0]?.release()
                    player[0] = null
                    engine.start(text, selected, exag)
                },
                enabled = !engine.busy && text.isNotBlank()
            ) { Text("Speak") }
            if (engine.busy) StudioAltButton(onClick = { engine.cancel() }) { Text("Cancel") }
        }

        if (engine.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        Text(engine.status)

        val out = engine.result
        if (out != null && !engine.busy) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                StudioButton(onClick = {
                    try {
                        player[0]?.release()
                        player[0] = MediaPlayer().apply {
                            setDataSource(out.absolutePath)
                            prepare()
                            start()
                        }
                    } catch (e: Exception) {
                        Toast.makeText(ctx, "Could not play: ${e.message}", Toast.LENGTH_LONG).show()
                    }
                }) { Text("Play") }
                StudioAltButton(onClick = {
                    player[0]?.release()
                    player[0] = null
                }) { Text("Stop") }
                StudioAltButton(onClick = {
                    val ok = try { saveToMusic(ctx, out) } catch (e: Exception) { false }
                    Toast.makeText(
                        ctx,
                        if (ok) "Saved in Music/VoiceStudio" else "Could not save",
                        Toast.LENGTH_SHORT
                    ).show()
                }) { Text("Save") }
            }
        }
    }
}
