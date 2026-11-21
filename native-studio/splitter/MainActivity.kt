package com.vocalsplitter.app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt
import com.mymusic.player.StudioAltButton
import com.mymusic.player.StudioApp
import com.mymusic.player.StudioButton
import com.mymusic.player.StudioCard
import com.mymusic.player.StudioHeader
import com.mymusic.player.StudioTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SeparationState.restore(applicationContext)
        val look = StudioTheme.look(this, intent)
        StudioTheme.applyBars(this, look)
        setContent {
            StudioApp(look) { App() }
        }
    }
}

private fun displayName(ctx: Context, uri: Uri): String {
    try {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (i >= 0) return c.getString(i) ?: "song"
            }
        }
    } catch (_: Exception) {
    }
    return "song"
}

private fun fmtTime(frames: Long): String {
    val s = frames / 44100
    return "%d:%02d".format(s / 60, s % 60)
}

private fun fmtEta(sec: Long): String {
    if (sec < 0) return ""
    val m = sec / 60
    return if (m >= 1) "About $m min left" else "Less than a minute left"
}

private fun modeLabel(m: Mode): String = when (m) {
    Mode.BEST -> "Best"
    Mode.FAST -> "Fast"
    Mode.SUPER -> "Super fast"
}

private fun modeDescription(m: Mode): String = when (m) {
    Mode.BEST -> "Best: slowest, cleanest separation (two passes)."
    Mode.FAST -> "Fast: about half the time, slightly more leftover noise (one pass)."
    Mode.SUPER -> "Super fast: one pass using every CPU core. Quickest, but the phone may get warm."
}

@Composable
private fun SectionCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    StudioCard(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp)
            content()
        }
    }
}

@Composable
private fun PercentSlider(label: String, value: Float, onChange: (Float) -> Unit) {
    Column {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label)
            Text("${value.roundToInt()}%", fontWeight = FontWeight.SemiBold)
        }
        Slider(value = value, onValueChange = onChange, valueRange = 0f..100f)
    }
}

@Composable
private fun App() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val ui by SeparationState.ui.collectAsState()

    var pickedUri by remember { mutableStateOf<Uri?>(null) }
    var pickedName by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf(Mode.BEST) }
    var vocalPct by remember { mutableFloatStateOf(100f) }
    var instPct by remember { mutableFloatStateOf(100f) }
    var exporting by remember { mutableStateOf(false) }
    var exportMsg by remember { mutableStateOf<String?>(null) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            try {
                ctx.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: Exception) {
            }
            pickedUri = uri
            pickedName = displayName(ctx, uri)
        }
    }

    val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { _ ->
        pickedUri?.let { SeparationService.start(ctx, it, pickedName, mode) }
    }

    fun startJob() {
        val uri = pickedUri ?: return
        exportMsg = null
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            SeparationService.start(ctx, uri, pickedName, mode)
        }
    }

    val working = ui.phase == Phase.Working
    val result = ui.result

    val player = remember(result) {
        if (result != null) {
            MixPlayer(SeparationState.vocalsFile(ctx), SeparationState.instFile(ctx), result.frames)
        } else null
    }
    DisposableEffect(player) { onDispose { player?.release() } }

    // Give a newly created player the current slider values.
    LaunchedEffect(player) {
        player?.vocalGain = vocalPct / 100f
        player?.instGain = instPct / 100f
    }

    var posFrames by remember { mutableLongStateOf(0L) }
    var playing by remember { mutableStateOf(false) }
    var seeking by remember { mutableStateOf(false) }
    LaunchedEffect(player) {
        while (true) {
            if (player != null) {
                playing = player.isPlaying
                if (!seeking) posFrames = player.positionFrames
            }
            delay(120)
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
      Column(Modifier.fillMaxSize().safeDrawingPadding()) {
        StudioHeader("Vocal Splitter") { (ctx as? Activity)?.finish() }
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(
                "100% offline • AI vocal & instrument separation",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            SectionCard("1. Choose a song") {
                StudioAltButton(
                    onClick = { picker.launch(arrayOf("audio/*")) },
                    enabled = !working,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(if (pickedUri == null) "Select audio file" else "Change file") }
                if (pickedUri != null) Text(pickedName)

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (m in Mode.values()) {
                        if (m == mode) {
                            StudioButton(
                                onClick = {},
                                enabled = !working,
                                modifier = Modifier.weight(1f),
                            ) { Text(modeLabel(m), maxLines = 1) }
                        } else {
                            StudioAltButton(
                                onClick = { mode = m },
                                enabled = !working,
                                modifier = Modifier.weight(1f),
                            ) { Text(modeLabel(m), maxLines = 1) }
                        }
                    }
                }
                Text(
                    modeDescription(mode),
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                StudioButton(
                    onClick = { startJob() },
                    enabled = pickedUri != null && !working,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Separate (${modeLabel(mode).lowercase()})") }
                Text(
                    "Processing continues if you leave the app. " +
                        "For best results set this app's battery usage to Unrestricted.",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (working) {
                SectionCard("Processing") {
                    LinearProgressIndicator(progress = { ui.progress }, modifier = Modifier.fillMaxWidth())
                    Text("${(ui.progress * 100).toInt()}%  •  ${ui.message}")
                    if (ui.etaSec >= 0) Text(fmtEta(ui.etaSec), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    StudioAltButton(
                        onClick = { SeparationService.cancel(ctx) },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Cancel") }
                }
            }

            if (ui.phase == Phase.Error && ui.error != null) {
                SectionCard("Something went wrong") {
                    Text(ui.error ?: "", color = MaterialTheme.colorScheme.error)
                }
            }

            if (!working && result != null && player != null) {
                SectionCard("2. Mix & download") {
                    Text(result.name, color = MaterialTheme.colorScheme.onSurfaceVariant)

                    PercentSlider("Vocals", vocalPct) {
                        vocalPct = it
                        player.vocalGain = it / 100f
                    }
                    PercentSlider("Instrument", instPct) {
                        instPct = it
                        player.instGain = it / 100f
                    }

                    Row(verticalAlignment = Alignment.CenterVertically) {
                        StudioButton(onClick = {
                            if (playing) {
                                player.pause()
                                playing = false
                            } else {
                                player.vocalGain = vocalPct / 100f
                                player.instGain = instPct / 100f
                                player.play()
                                playing = true
                            }
                        }) { Text(if (playing) "Pause" else "Play preview") }
                        Text(
                            "   ${fmtTime(posFrames)} / ${fmtTime(result.frames)}",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Slider(
                        value = posFrames.toFloat(),
                        onValueChange = {
                            seeking = true
                            posFrames = it.toLong()
                        },
                        onValueChangeFinished = {
                            player.seekTo(posFrames)
                            seeking = false
                        },
                        valueRange = 0f..result.frames.toFloat(),
                    )

                    val bothZero = vocalPct.roundToInt() == 0 && instPct.roundToInt() == 0
                    StudioButton(
                        onClick = {
                            val v = vocalPct.roundToInt()
                            val i = instPct.roundToInt()
                            scope.launch {
                                exporting = true
                                exportMsg = null
                                try {
                                    val base = result.name.substringBeforeLast('.', result.name)
                                    val path = withContext(Dispatchers.IO) {
                                        MixExporter.export(
                                            ctx,
                                            SeparationState.vocalsFile(ctx),
                                            SeparationState.instFile(ctx),
                                            result.frames,
                                            v / 100f,
                                            i / 100f,
                                            base,
                                            "vocals${v}_inst${i}",
                                        )
                                    }
                                    exportMsg = "Saved to $path"
                                } catch (t: Throwable) {
                                    exportMsg = "Download failed: ${t.message ?: t.javaClass.simpleName}"
                                } finally {
                                    exporting = false
                                }
                            }
                        },
                        enabled = !exporting && !bothZero,
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(if (exporting) "Saving…" else "Download this mix (WAV)") }
                    if (exporting) LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    if (bothZero) Text("Raise at least one slider above 0.", fontSize = 12.sp)
                    exportMsg?.let { Text(it) }
                    Text(
                        "Tip: Vocals 100% + Instrument 0% = vocals only. Vocals 0% + Instrument 100% = instrumental only.",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
      }
    }
}
