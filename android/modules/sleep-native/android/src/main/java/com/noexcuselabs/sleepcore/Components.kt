package com.noexcuselabs.sleepcore

import android.accessibilityservice.AccessibilityService
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.app.admin.DeviceAdminReceiver
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioManager
import android.media.RingtoneManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.widget.RemoteViews
import java.time.Duration
import java.time.Instant

/**
 * Always running: holds the socket, catches screen on/unlock, backstops the alarm, and is the fallback
 * enforcer (usage stats every 500ms + an alarm beep every 60s) when the accessibility service is off mid-lock.
 */
class SleepService : Service() {
  companion object {
    const val CHANNEL = "sleep"
    private var running = false
    fun start(ctx: Context) {
      runCatching { ctx.startForegroundService(Intent(ctx, SleepService::class.java)) }.onFailure { Log.w("Sleep", "service: $it") }
    }
    fun refresh(ctx: Context) {
      if (running) ctx.getSystemService(NotificationManager::class.java).notify(1, SleepCore.notification())
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  private var wasLocked: Boolean? = null
  private var lastBeep = 0L

  private val screen = object : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
      if (i.action == Intent.ACTION_SCREEN_ON) Overlay.onScreenOn()
      SleepCore.connectIfDown()
      SleepCore.enforce(null)
    }
  }

  private val tick = object : Runnable {
    override fun run() {
      val locked = SleepCore.lockedUntil() != null
      if (locked != wasLocked) { wasLocked = locked; SleepCore.apply() } // in case the alarm came late
      val tampered = locked && SleepA11y.instance == null
      val awake = getSystemService(PowerManager::class.java).isInteractive
      if (tampered && awake) SleepCore.enforce(usageForeground())
      // beep only if it was switched off, not if setup just isn't finished
      if (tampered && SleepCore.a11ySeen && System.currentTimeMillis() - lastBeep > 60_000) { lastBeep = System.currentTimeMillis(); beep() }
      handler.postDelayed(this, if (tampered && awake) 500 else 15_000)
    }
  }

  override fun onCreate() {
    super.onCreate()
    SleepCore.init(this)
    getSystemService(NotificationManager::class.java)
      .createNotificationChannel(NotificationChannel(CHANNEL, "Curfew", NotificationManager.IMPORTANCE_LOW))
    if (Build.VERSION.SDK_INT >= 34) startForeground(1, SleepCore.notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    else startForeground(1, SleepCore.notification())
    running = true
    val f = IntentFilter().apply { addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_USER_PRESENT) }
    if (Build.VERSION.SDK_INT >= 33) registerReceiver(screen, f, RECEIVER_NOT_EXPORTED) else registerReceiver(screen, f)
    SleepCore.connectIfDown()
    handler.post(tick)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    SleepCore.apply()
    return START_STICKY
  }

  override fun onDestroy() {
    running = false
    handler.removeCallbacks(tick)
    unregisterReceiver(screen)
    super.onDestroy()
  }

  override fun onBind(intent: Intent?) = null

  private fun usageForeground(): String? {
    val now = System.currentTimeMillis()
    val events = getSystemService(UsageStatsManager::class.java).queryEvents(now - 10_000, now)
    val e = UsageEvents.Event()
    var pkg: String? = null
    while (events.hasNextEvent()) {
      events.getNextEvent(e)
      if (e.eventType == UsageEvents.Event.ACTIVITY_RESUMED) pkg = e.packageName
    }
    return pkg
  }

  private fun beep() {
    val t = runCatching { ToneGenerator(AudioManager.STREAM_ALARM, 100) }.getOrNull() ?: return
    t.startTone(ToneGenerator.TONE_CDMA_EMERGENCY_RINGBACK, 1500)
    handler.postDelayed({ t.release() }, 2000)
  }
}

/** Primary enforcer: hears every app coming to the front, instantly. Reads nothing on screen. */
class SleepA11y : AccessibilityService() {
  companion object {
    var instance: SleepA11y? = null
      private set
  }

  override fun onServiceConnected() {
    instance = this
    SleepCore.init(this)
    SleepCore.a11ySeen = true
    SleepService.start(this)
    Overlay.hide() // re-added below as an accessibility overlay
    SleepCore.apply()
  }

  override fun onAccessibilityEvent(e: AccessibilityEvent) {
    if (e.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED || e.className?.toString() == OVERLAY_CLASS) return
    e.packageName?.toString()?.let(SleepCore::enforce)
  }

  override fun onInterrupt() {}

  override fun onDestroy() {
    Overlay.hide() // our accessibility overlay dies with us; put the app overlay back up right away
    instance = null
    SleepCore.enforce(null)
    super.onDestroy()
  }
}

/** Alarm edges and taps (notification action, widget). Not exported. */
class SleepReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, i: Intent) {
    SleepCore.init(ctx)
    if (i.action == SleepCore.ACTION_TAP) SleepCore.tap()
    SleepService.start(ctx)
    SleepCore.apply()
  }
}

/** Boot, app update, clock or timezone change: re-arm from the cached state. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, i: Intent) {
    SleepCore.init(ctx)
    SleepService.start(ctx)
    SleepCore.apply()
  }
}

class SleepTile : TileService() {
  override fun onStartListening() {
    SleepCore.init(this)
    val until = SleepCore.lockedUntil()
    qsTile?.apply {
      state = if (until != null) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
      label = "Curfew"
      subtitle = until?.let { "until ${SleepCore.hhmm(it)}" } ?: "tap to lock"
      updateTile()
    }
  }

  override fun onClick() {
    SleepCore.init(this)
    SleepCore.tap()
    SleepService.start(this)
    SleepA11y.instance?.performGlobalAction(AccessibilityService.GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
    onStartListening()
  }
}

class SleepWidget : AppWidgetProvider() {
  override fun onUpdate(ctx: Context, m: AppWidgetManager, ids: IntArray) {
    SleepCore.init(ctx)
    m.updateAppWidget(ids, RemoteViews(ctx.packageName, R.layout.sleep_widget).apply {
      setOnClickPendingIntent(R.id.sleep_widget, SleepCore.tapIntent())
    })
  }
}

class SleepAdmin : DeviceAdminReceiver() {
  override fun onDisableRequested(ctx: Context, intent: Intent): CharSequence =
    "Curfew only uses this to turn the screen off during your lock window."
}

/**
 * Quiet nights. While locked, a notification from an app that isn't allowed is snoozed until the lock ends (it comes
 * back then), and notification sounds are off for everything; an allowed app's notification gets a plain sound and a
 * buzz from here instead. Calls still ring and alarms still go off: neither is a notification effect.
 */
class SleepNotifications : NotificationListenerService() {
  companion object {
    var instance: SleepNotifications? = null
    fun sync() = instance?.quiet()
  }
  private var quietUntil: Instant? = null
  private val alerted = mutableSetOf<String>()

  override fun onListenerConnected() { instance = this; quiet() }
  override fun onListenerDisconnected() { if (instance === this) instance = null }

  fun quiet() {
    val until = SleepCore.lockedUntil()
    requestListenerHints(if (until != null) HINT_HOST_DISABLE_NOTIFICATION_EFFECTS else 0)
    if (until != null && until != quietUntil) runCatching { activeNotifications }.getOrNull()?.forEach { mute(it, until) }
    if (until == null) alerted.clear()
    quietUntil = until
  }

  override fun onNotificationPosted(sbn: StatusBarNotification) {
    val until = SleepCore.lockedUntil() ?: return
    if (!mute(sbn, until)) alert(sbn)
  }

  /** Snoozes it until the lock ends unless its app is allowed. True if it did. */
  private fun mute(sbn: StatusBarNotification, until: Instant): Boolean {
    if (sbn.isOngoing || SleepCore.allowed(sbn.packageName)) return false
    runCatching { snoozeNotification(sbn.key, maxOf(60_000L, Duration.between(Instant.now(), until).toMillis())) }
    return true
  }

  private fun alert(sbn: StatusBarNotification) {
    val n = sbn.notification
    if (sbn.isOngoing || sbn.packageName == packageName || n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
    if (n.flags and Notification.FLAG_ONLY_ALERT_ONCE != 0 && sbn.key in alerted) return // an update, not a new message
    val r = Ranking()
    if (!currentRanking.getRanking(sbn.key, r) || r.importance < NotificationManager.IMPORTANCE_DEFAULT) return // silent channel
    alerted += sbn.key
    runCatching { RingtoneManager.getRingtone(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))?.play() }
    getSystemService(Vibrator::class.java)?.vibrate(VibrationEffect.createOneShot(180, VibrationEffect.DEFAULT_AMPLITUDE))
  }
}
