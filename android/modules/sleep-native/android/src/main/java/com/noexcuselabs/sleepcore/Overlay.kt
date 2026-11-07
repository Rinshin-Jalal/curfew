package com.noexcuselabs.sleepcore

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.PixelFormat
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.telecom.TelecomManager
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.view.WindowManager.LayoutParams as WLP
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextClock
import android.widget.TextView
import java.time.Instant

// same manner as the app: true black, the time in a light serif, quiet sans, outline pills
private val INK = Color.WHITE
private val SOFT = Color.parseColor("#A0A0A0")
private val RULE = Color.parseColor("#47FFFFFF") // white at 28%

/** Tonight's moon, the same sum as src/moon.ts: days since a known new moon, wrapped to the synodic month. */
private object Moon {
  private const val SYNODIC = 29.530588853
  private const val NEW_MOON = 947182440000L // 2000-01-06 18:14 UTC
  fun age(now: Long = System.currentTimeMillis()) = ((now - NEW_MOON) / 86_400_000.0).mod(SYNODIC)
  fun lit(a: Double) = Math.round((1 - Math.cos(2 * Math.PI * a / SYNODIC)) / 2 * 100)
  fun name(a: Double) = when {
    a < 1.85 || a >= 27.68 -> "New moon"
    a < 5.54 -> "Waxing crescent"
    a < 9.23 -> "First quarter"
    a < 12.92 -> "Waxing gibbous"
    a < 16.61 -> "Full moon"
    a < 20.3 -> "Waning gibbous"
    a < 23.99 -> "Last quarter"
    else -> "Waning crescent"
  }
  fun frame(a: Double) = "moon_" + minOf(29, a.toInt()).toString().padStart(2, '0')
}

// how the accessibility service tells our own overlay apart from a real app coming to the front
const val OVERLAY_CLASS = "com.noexcuselabs.sleepcore.Overlay"

object Overlay {
  private var view: OverlayView? = null
  private var wm: WindowManager? = null
  private val main = Handler(Looper.getMainLooper())
  private val lock = Runnable { if (shown) SleepCore.lockNow() }
  private val shown get() = view?.isAttachedToWindow == true

  /** Once it's up you get 8 seconds to read the time or tap Emergency, then the screen goes off. */
  fun show(ctx: Context, until: Instant, shame: Int) {
    view?.let { if (it.isAttachedToWindow) return it.bind(until, shame) }
    // a view only attaches on its first frame (later still with the screen off), so a second show() before then
    // used to add a twin; once `view` pointed at the twin, hide() could never take the first one down
    hide()
    // an accessibility overlay needs no extra permission and sits above more; the app overlay is the fallback
    val a11y = SleepA11y.instance
    if (a11y == null && !Settings.canDrawOverlays(ctx)) return
    val host: Context = a11y ?: ctx
    val lp = WLP(WLP.MATCH_PARENT, WLP.MATCH_PARENT,
      if (a11y != null) WLP.TYPE_ACCESSIBILITY_OVERLAY else WLP.TYPE_APPLICATION_OVERLAY,
      WLP.FLAG_NOT_FOCUSABLE or WLP.FLAG_LAYOUT_IN_SCREEN or WLP.FLAG_LAYOUT_NO_LIMITS, PixelFormat.OPAQUE)
      .apply { layoutInDisplayCutoutMode = WLP.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS }
    val v = OverlayView(host).also { it.bind(until, shame) }
    val w = host.getSystemService(WindowManager::class.java)
    runCatching { w.addView(v, lp) }.onFailure { Log.w("Sleep", "overlay: $it"); return }
    view = v
    wm = w
    main.removeCallbacks(lock)
    main.postDelayed(lock, 8000)
  }

  fun hide() {
    main.removeCallbacks(lock)
    view?.let { v -> runCatching { wm?.removeView(v) } }
    view = null
    wm = null
  }

  fun onScreenOn() {
    if (!shown) return
    main.removeCallbacks(lock)
    main.postDelayed(lock, 8000)
  }
}

@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
class OverlayView(ctx: Context) : FrameLayout(ctx) {
  private val serif = ctx.resources.getFont(R.font.serif)
  private val sans = ctx.resources.getFont(R.font.sans)
  private val clock = TextClock(ctx).apply {
    format24Hour = "HH:mm"
    format12Hour = "HH:mm"
    typeface = serif
    setTextColor(INK)
    includeFontPadding = false
    fontFeatureSettings = "tnum"
  }
  private val until = label("", INK, 20f)
  private val shame = label("", SOFT, 15f)
  private val phase = label("", SOFT, 13f)
  // tonight's real moon, running off the right edge like on the home screen
  private val early: TextView
  // the allowed apps, one tap away: the lock covers the home screen, so this is the only way to open them
  private val apps = LinearLayout(ctx)
  private var appsShown: List<String>? = null
  private val moon = ImageView(ctx).apply { scaleType = ImageView.ScaleType.FIT_CENTER; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }

  init {
    setBackgroundColor(Color.BLACK)
    addView(moon, LayoutParams(0, 0, Gravity.TOP or Gravity.END))
    addView(LinearLayout(ctx).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.BOTTOM
      setPadding(dp(24), 0, dp(24), dp(196))
      addView(phase, LinearLayout.LayoutParams(WLP.WRAP_CONTENT, WLP.WRAP_CONTENT).apply { bottomMargin = dp(4) })
      addView(clock)
      addView(until, LinearLayout.LayoutParams(WLP.WRAP_CONTENT, WLP.WRAP_CONTENT).apply { topMargin = dp(16) })
      addView(shame, LinearLayout.LayoutParams(WLP.WRAP_CONTENT, WLP.WRAP_CONTENT).apply { topMargin = dp(4) })
    }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

    val emergency = pill("Emergency call") { context.startActivity(Intent(Intent.ACTION_DIAL).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    early = pill("Unlock early") {
      SleepCore.pendingRoute = "unlock"
      context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
    addView(HorizontalScrollView(ctx).apply {
      isHorizontalScrollBarEnabled = false
      clipToPadding = false
      setPadding(dp(24), 0, dp(24), 0)
      addView(apps)
    }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM).apply { bottomMargin = dp(116) })
    addView(LinearLayout(ctx).apply {
      setPadding(dp(24), 0, dp(24), dp(56))
      addView(emergency, LinearLayout.LayoutParams(WLP.WRAP_CONTENT, dp(48)))
      addView(early, LinearLayout.LayoutParams(WLP.WRAP_CONTENT, dp(48)).apply { marginStart = dp(12) })
    }, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
  }

  fun bind(until: Instant, shame: Int) {
    this.until.text = "Locked until ${SleepCore.hhmm(until)}. Go to sleep"
    // tonight's breaks decide what's possible; the all-time count is only there to sting
    val left = Schedule.BREAKS_PER_NIGHT - SleepCore.breaksTonight()
    this.shame.text = (if (left > 0) "$left break${if (left > 1) "s" else ""} left tonight" else "Both breaks used tonight, so only the judge can let you out") +
      if (shame == 0) "" else ". $shame early unlocks in all"
    // two typed breaks a night, then only the judge
    early.text = if (left > 0) "Unlock early" else "Ask the judge"
    bindApps()
    val a = Moon.age()
    phase.text = "${Moon.name(a)}, ${Moon.lit(a)}% lit"
    resources.getIdentifier(Moon.frame(a), "drawable", context.packageName).takeIf { it != 0 }?.let(moon::setImageResource)
  }

  private fun bindApps() {
    val pm = context.packageManager
    val dialer = context.getSystemService(TelecomManager::class.java)?.defaultDialerPackage // that's Emergency call
    val list = SleepCore.allowlist().filter { it != context.packageName && it != dialer && pm.getLaunchIntentForPackage(it) != null }
    if (list == appsShown) return
    appsShown = list
    apps.removeAllViews()
    list.forEachIndexed { i, pkg ->
      val name = runCatching { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() }.getOrDefault(pkg)
      apps.addView(pill(name) { pm.getLaunchIntentForPackage(pkg)?.let { context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } },
        LinearLayout.LayoutParams(WLP.WRAP_CONTENT, dp(48)).apply { if (i > 0) marginStart = dp(12) })
    }
  }

  // the time fills the width, tracked tight like a headline
  override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) {
    post {
      val px = minOf(h * 0.16f, (w - dp(48)) / 2.6f)
      clock.setTextSize(TypedValue.COMPLEX_UNIT_PX, px)
      clock.letterSpacing = -0.04f
      val size = (w * 0.96f).toInt()
      moon.layoutParams = LayoutParams(size, size, Gravity.TOP or Gravity.END).apply { topMargin = (h * 0.05f).toInt() }
      moon.translationX = size * 0.3f
    }
  }

  override fun onTouchEvent(e: MotionEvent) = true // swallow everything that isn't a button
  override fun getAccessibilityClassName(): CharSequence = OVERLAY_CLASS

  private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
  private fun label(text: String, color: Int, sp: Float) = TextView(context).apply {
    this.text = text
    setTextColor(color)
    textSize = sp
    typeface = sans
  }
  private fun pill(text: String, onClick: () -> Unit) = TextView(context).apply {
    this.text = text
    setTextColor(INK)
    textSize = 15f
    typeface = sans
    gravity = Gravity.CENTER
    setPadding(dp(24), 0, dp(24), 0)
    background = GradientDrawable().apply { cornerRadius = dp(24).toFloat(); setStroke(dp(1), RULE) }
    setOnClickListener { onClick() }
  }
}
