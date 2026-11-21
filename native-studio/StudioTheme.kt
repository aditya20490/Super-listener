package com.mymusic.player

import android.content.Context
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Shapes
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldColors
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject

/**
 * Only the OUTER LOOK of Vocal Splitter and Voice Cloner lives here: the colors of the Music Plus theme you
 * picked in settings, the same rounded corners, the same header and the same button style.
 * The engines of both apps are not touched.
 */
object StudioTheme {
    private const val PREFS = "studio_theme"
    private const val KEY = "json"

    class Look(
        val dark: Boolean,
        val bg: Color,
        val bgTop: Color,
        val card: Color,
        val text: Color,
        val muted: Color,
        val accent: Color,
        val onAccent: Color,
        val track: Color,
    )

    val buttonShape = RoundedCornerShape(12.dp)
    val cardShape = RoundedCornerShape(16.dp)
    val fieldShape = RoundedCornerShape(12.dp)

    fun save(ctx: Context, json: String) {
        try {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).apply()
        } catch (_: Exception) {
        }
    }

    private fun col(o: JSONObject, key: String, fallback: Long): Color {
        return try {
            Color(android.graphics.Color.parseColor(o.getString(key)))
        } catch (_: Exception) {
            Color(fallback)
        }
    }

    /** The theme comes with the intent from Music Plus; when the app is reopened from its notification, the saved copy is used. */
    fun look(ctx: Context, intent: Intent?): Look {
        var json: String? = intent?.getStringExtra("theme")
        if (json.isNullOrEmpty()) {
            json = try {
                ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
            } catch (_: Exception) {
                null
            }
        }
        val o = try {
            JSONObject(json ?: "{}")
        } catch (_: Exception) {
            JSONObject()
        }
        // fallback = the Music Plus "Dark" theme
        return Look(
            dark = o.optBoolean("isDark", true),
            bg = col(o, "bg", 0xFF121212),
            bgTop = col(o, "bgTop", 0xFF1E1E1E),
            card = col(o, "card", 0xFF1F1F1F),
            text = col(o, "text", 0xFFFFFFFF),
            muted = col(o, "muted", 0xFFA0A0A0),
            accent = col(o, "accent", 0xFFFFFFFF),
            onAccent = col(o, "onAccent", 0xFF121212),
            track = col(o, "track", 0xFF3A3A3A),
        )
    }

    fun scheme(l: Look): ColorScheme {
        val base = if (l.dark) darkColorScheme() else lightColorScheme()
        return base.copy(
            primary = l.accent,
            onPrimary = l.onAccent,
            primaryContainer = l.track,
            onPrimaryContainer = l.text,
            secondary = l.accent,
            onSecondary = l.onAccent,
            secondaryContainer = l.track,
            onSecondaryContainer = l.text,
            tertiary = l.accent,
            onTertiary = l.onAccent,
            background = l.bg,
            onBackground = l.text,
            surface = l.bg,
            onSurface = l.text,
            surfaceVariant = l.card,
            onSurfaceVariant = l.muted,
            surfaceTint = l.accent,
            surfaceContainerLowest = l.bg,
            surfaceContainerLow = l.card,
            surfaceContainer = l.card,
            surfaceContainerHigh = l.card,
            surfaceContainerHighest = l.card,
            outline = l.muted,
            outlineVariant = l.track,
            error = Color(0xFFF87171),
        )
    }

    /** Status bar and navigation bar icons follow the theme (light icons on dark themes, dark icons on Light). */
    fun applyBars(a: ComponentActivity, l: Look) {
        val style = if (l.dark) {
            SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
        } else {
            SystemBarStyle.light(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT)
        }
        a.enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
        a.window.decorView.setBackgroundColor(l.bg.toArgb())
    }
}

@Composable
fun StudioApp(look: StudioTheme.Look, content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = StudioTheme.scheme(look),
        shapes = Shapes(
            extraSmall = RoundedCornerShape(8.dp),
            small = RoundedCornerShape(12.dp),
            medium = RoundedCornerShape(12.dp),
            large = RoundedCornerShape(16.dp),
            extraLarge = RoundedCornerShape(20.dp),
        ),
        content = content,
    )
}

/** Same top bar as the other Music Plus screens: a down arrow on the left, a bold title. */
@Composable
fun StudioHeader(title: String, onClose: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .height(52.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onClose, modifier = Modifier.size(44.dp)) {
            Icon(
                imageVector = Icons.Filled.KeyboardArrowDown,
                contentDescription = "Close",
                tint = c.onBackground,
                modifier = Modifier.size(28.dp),
            )
        }
        Text(title, color = c.onBackground, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold)
    }
}

@Composable
fun StudioCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = MaterialTheme.colorScheme
    Card(
        modifier = modifier,
        shape = StudioTheme.cardShape,
        colors = CardDefaults.cardColors(containerColor = c.surfaceVariant, contentColor = c.onSurface),
        content = content,
    )
}

/** The main button: accent color, like the buttons in the rest of Music Plus. */
@Composable
fun StudioButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    Button(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        shape = StudioTheme.buttonShape,
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp),
        content = {
            val rs = this
            ProvideTextStyle(TextStyle(fontWeight = FontWeight.ExtraBold, fontSize = 14.sp)) { rs.content() }
        },
    )
}

/** The calmer button (the "alt" button of Music Plus): filled with the theme's soft grey. */
@Composable
fun StudioAltButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    val c = MaterialTheme.colorScheme
    Button(
        onClick = onClick,
        modifier = modifier,
        enabled = enabled,
        shape = StudioTheme.buttonShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = c.secondaryContainer,
            contentColor = c.onSurface,
            disabledContainerColor = c.secondaryContainer.copy(alpha = 0.4f),
            disabledContentColor = c.onSurface.copy(alpha = 0.4f),
        ),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp),
        content = {
            val rs = this
            ProvideTextStyle(TextStyle(fontWeight = FontWeight.ExtraBold, fontSize = 14.sp)) { rs.content() }
        },
    )
}

@Composable
fun studioFieldColors(): TextFieldColors {
    val c = MaterialTheme.colorScheme
    return OutlinedTextFieldDefaults.colors(
        focusedContainerColor = c.surfaceVariant,
        unfocusedContainerColor = c.surfaceVariant,
        focusedBorderColor = c.primary,
        unfocusedBorderColor = Color.Transparent,
        focusedTextColor = c.onSurface,
        unfocusedTextColor = c.onSurface,
        cursorColor = c.primary,
        focusedLabelColor = c.onSurfaceVariant,
        unfocusedLabelColor = c.onSurfaceVariant,
    )
}
