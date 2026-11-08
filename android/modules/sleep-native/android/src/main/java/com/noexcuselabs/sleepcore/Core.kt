package com.noexcuselabs.sleepcore

import android.accessibilityservice.AccessibilityService
import android.app.AlarmManager
import android.app.Notification
import android.app.PendingIntent
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.AlarmClock
import android.provider.Settings
import android.provider.Telephony
import android.service.quicksettings.TileService
import android.telecom.TelecomManager
import android.util.Log
import java.io.IOException
import java.time.Instant
import java.time.Duration
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject

/**
 * State, sync and enforcement, all on the main thread (HTTP callbacks hop back to it).
 * The cached state + this phone's clock decide the lock; the server only syncs intent.
 */
object SleepCore {
  const val ACTION_TAP = "com.noexcuselabs.sleep.TAP"
  const val ACTION_ALARM = "com.noexcuselabs.sleep.ALARM"
  private const val TAG = "Sleep"

  lateinit var app: Context
    private set
  private lateinit var prefs: SharedPreferences
  private val main = Handler(Looper.getMainLooper())
  // the judge can take several seconds to think; OkHttp gives up after 10 by default
  private val http = OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS).build()
  private var ws: WebSocket? = null
  private var backoffSec = 1L
  private var flushing = false
  private var rules: Rules? = null

  var state = JSONObject() // the SleepState exactly as the server sends it
    private set
  var connected = false
    private set
  var lastPkg: String? = null // last real app in front (not system chrome)
    private set
  var pendingRoute: String? = null // the overlay asks the app to open on a screen
  val listeners = CopyOnWriteArraySet<() -> Unit>()

  fun init(ctx: Context) {
    if (::app.isInitialized) return
    app = ctx.applicationContext
    prefs = app.getSharedPreferences("sleep", Context.MODE_PRIVATE)
    prefs.getString("state", null)?.let { setState(JSONObject(it), save = false) }
  }

  private val zone: ZoneId get() = ZoneId.systemDefault()
  private val url get() = prefs.getString("url", "")!!.trimEnd('/')
  private val token get() = prefs.getString("token", "")!!
  val pending get() = prefs.getString("pending", null) != null

  /** The accessibility service has run here before, so it being off now means someone switched it off. */
  var a11ySeen: Boolean
    get() = prefs.getBoolean("a11ySeen", false)
    set(v) = prefs.edit().putBoolean("a11ySeen", v).apply()

  fun lockedUntil(now: Instant = Instant.now()) = rules?.let { Schedule.lockedUntil(it, zone, now) }
  /** On a break from a lock that comes back after it: the break's end. Null once that lock has run out anyway. */
  fun breakEnd(now: Instant = Instant.now()) = rules?.takeIf { lockedUntil(now) == null && Schedule.lockUnderway(it, zone, now) != null }?.breakUntil
  fun nextStart(now: Instant = Instant.now()) = rules?.let { r -> Schedule.nextStart(r.sched, zone, now).takeIf { r.phraseHash != null } }
  fun hhmm(i: Instant): String = i.atZone(zone).toLocalTime().format(DateTimeFormatter.ofPattern("HH:mm"))

  private fun JSONObject.str(k: String): String? = if (isNull(k)) null else getString(k)

  private fun setState(s: JSONObject, save: Boolean = true) {
    state = s
    rules = runCatching {
      val sch = s.getJSONObject("schedule")
      val days = sch.getJSONArray("days").let { a -> (0 until a.length()).map { a.getInt(it) }.toSet() }
      Rules(s.optString("mode", "scheduled"), s.str("activeUntil")?.let(Instant::parse),
        Sched(LocalTime.parse(sch.getString("start")), LocalTime.parse(sch.getString("end")), days), s.str("phraseHash"),
        s.str("breakUntil")?.let(Instant::parse), s.optJSONArray("breakApps")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() })
    }.getOrNull()
    if (save) prefs.edit().putString("state", s.toString()).apply()
  }

  private fun edit(vararg kv: Pair<String, Any?>) {
    val s = JSONObject(state.toString())
    kv.forEach { (k, v) -> s.put(k, v ?: JSONObject.NULL) }
    setState(s.put("updatedAt", Instant.now().toString()))
  }

  // ---- actions: local first, server when it can

  fun tap() {
    val r = rules?.takeIf { it.phraseHash != null } ?: return // unarmed: a tap now would only turn into a surprise lock later
    var until = Schedule.tapUntil(r.sched, zone, Instant.now())
    if (r.mode == "manual" && r.activeUntil != null && r.activeUntil > until) until = r.activeUntil // never shortens
    edit("mode" to "manual", "activeUntil" to until.toString(), "breakUntil" to null, "breakApps" to null) // and it ends a break
    setPending("tap", until.toString())
    apply()
    flush()
  }

  /** Breaks started since tonight began (the latest local noon), from the cached state so it works offline. */
  fun breaksTonight(now: Instant = Instant.now()): Int {
    val a = state.optJSONArray("breaks") ?: return 0
    val since = Schedule.nightStart(zone, now)
    return (0 until a.length()).count { runCatching { Instant.parse(a.getString(it)) >= since }.getOrDefault(false) }
  }

  /**
   * A 15 minute break, at most 2 a night, then the lock is back by itself. The app checked the typing (fresh words
   * every time), so this works offline; the server hears about it (and counts it) on the next sync. Returns why not, or null.
   */
  fun unlock(): String? {
    state.str("phraseHash") ?: return "Turn Curfew on first"
    if (lockedUntil() == null) return "Nothing is locked right now"
    if (breaksTonight() >= Schedule.BREAKS_PER_NIGHT) return "That's both breaks for tonight"
    val now = Instant.now()
    val breaks = JSONArray().also { b -> state.optJSONArray("breaks")?.let { a -> for (i in maxOf(0, a.length() - 9) until a.length()) b.put(a.getString(i)) } }.put(now.toString())
    edit("breakUntil" to now.plus(Duration.ofMinutes(Schedule.BREAK_MIN)).toString(), "breakApps" to null, "breaks" to breaks,
      "earlyUnlocks" to state.optInt("earlyUnlocks") + 1)
    setPending("unlock", "")
    apply()
    flush()
    return null
  }

  // one slot: the latest local action wins, like it did on this phone
  private fun setPending(kind: String, value: String) =
    prefs.edit().putString("pending", JSONObject().put("kind", kind).put("value", value).toString()).apply()

  fun configure(url: String, token: String) {
    if (url == prefs.getString("url", null) && token == prefs.getString("token", null)) return
    prefs.edit().putString("url", url).putString("token", token).apply()
    connect()
  }

  fun put(body: String, done: (Boolean, String) -> Unit) = call("PUT", "/sleep", JSONObject(body)) { code, text ->
    if (code == 200) { adopt(text); done(true, state.toString()) }
    else done(false, runCatching { JSONObject(text).getString("error") }.getOrDefault(trouble(code, "the server")))
  }

  /** Emergency: the AI judge on the server decides. Approval comes back with the new state, which both devices adopt. */
  // the judge picks which of these a yes opens; the open ones already work, so it leaves them out
  fun appeal(reason: String, done: (Boolean, String) -> Unit) = call("POST", "/sleep/appeal", JSONObject().put("reason", reason)
    .put("apps", JSONArray(launcherApps().map { JSONObject().put("pkg", it.first).put("label", it.second) }))
    .put("open", JSONArray((essentials + allowlist()).distinct()))) { code, text ->
    val j = runCatching { JSONObject(text) }.getOrNull()
    if (code == 200 && j != null) {
      j.optJSONObject("state")?.let { adopt(it.toString()) }
      done(true, j.toString())
    } else {
      done(false, j?.optString("error")?.takeIf { it.isNotEmpty() } ?: trouble(code, "the judge"))
    }
  }

  private fun trouble(code: Int, who: String) =
    if (code == -1) "Can't reach $who. Check your connection and try again."
    else "Something broke on $who's side (HTTP $code). Try again in a minute."

  // ---- sync

  private fun call(method: String, path: String, body: JSONObject?, done: (Int, String) -> Unit) {
    if (url.isEmpty()) { main.post { done(-1, "no server configured") }; return }
    val req = Request.Builder().url(url + path).header("authorization", "Bearer $token")
      .method(method, body?.toString()?.toRequestBody("application/json".toMediaType())).build()
    http.newCall(req).enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) { main.post { done(-1, e.message ?: "offline") } }
      override fun onResponse(call: Call, res: Response) {
        val text = res.use { it.body?.string() ?: "" }
        main.post { done(res.code, text) }
      }
    })
  }

  /** Push the pending local action, then take the server's word for everything else. */
  fun flush() {
    if (flushing) return
    val raw = prefs.getString("pending", null)
      ?: return call("GET", "/sleep", null) { code, text -> if (code == 200) adopt(text) }
    val p = JSONObject(raw)
    val (path, body) = if (p.getString("kind") == "tap") "/sleep/tap" to JSONObject().put("until", p.getString("value"))
      else "/sleep/unlock" to JSONObject()
    flushing = true
    call("POST", path, body) { code, text ->
      flushing = false
      if (code == -1 || code >= 500) return@call // offline: retried on the next connect
      if (prefs.getString("pending", null) == raw) prefs.edit().remove("pending").apply()
      // 4xx = the server disagrees (phrase changed elsewhere): drop it and resync
      if (pending || code != 200) flush() else adopt(text)
    }
  }

  private fun adopt(text: String) {
    if (pending) return // our own action goes first; flush() adopts after it
    runCatching { setState(JSONObject(text)) }.onSuccess { apply() }.onFailure { Log.w(TAG, "bad state: $it") }
  }

  fun connect() {
    ws?.cancel()
    ws = null
    if (url.isEmpty()) return
    val req = Request.Builder().url(url.replaceFirst("http", "ws") + "/sleep/stream?t=" + Uri.encode(token)).build()
    ws = http.newWebSocket(req, object : WebSocketListener() {
      override fun onOpen(w: WebSocket, res: Response) {
        main.post {
          if (w != ws) return@post
          connected = true
          backoffSec = 1
          flush()
          if (state.optString("tz") != zone.id) call("PUT", "/sleep", JSONObject().put("tz", zone.id)) { c, t -> if (c == 200) adopt(t) }
          notifyChanged()
        }
      }
      override fun onMessage(w: WebSocket, text: String) { main.post { if (w == ws) adopt(text) } }
      override fun onClosing(w: WebSocket, code: Int, reason: String) { w.close(1000, null) }
      override fun onClosed(w: WebSocket, code: Int, reason: String) = lost(w)
      override fun onFailure(w: WebSocket, t: Throwable, res: Response?) = lost(w)
    })
  }

  private fun lost(w: WebSocket) {
    main.post {
      if (w != ws) return@post
      ws = null
      connected = false
      notifyChanged()
      main.postDelayed(::connectIfDown, backoffSec * 1000)
      backoffSec = (backoffSec * 2).coerceAtMost(60)
    }
  }

  fun connectIfDown() { if (ws == null) connect() }

  // ---- enforcement

  /** Everything changed: re-decide the overlay, re-arm the alarm, refresh the notification, tile and UI. */
  fun apply() {
    enforce(null)
    arm()
    SleepNotifications.sync()
    SleepService.refresh(app)
    runCatching { TileService.requestListeningState(app, ComponentName(app, SleepTile::class.java)) }
    notifyChanged()
  }

  private fun notifyChanged() = listeners.forEach { it() }

  /** One rule for every trigger: locked and the app in front isn't allowed -> home + overlay. */
  fun enforce(fgPkg: String?) {
    if (fgPkg != null && !isChrome(fgPkg)) lastPkg = fgPkg
    val until = lockedUntil()
    val pkg = lastPkg
    if (until == null || (pkg != null && allowed(pkg))) return Overlay.hide()
    if (pkg != null && pkg != launcher) SleepA11y.instance?.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
    Overlay.show(app, until, state.optInt("earlyUnlocks"))
  }

  // keyboard, status bar, shade, power menu: always usable, and never "the app in front"
  private fun isChrome(pkg: String) = pkg == "com.android.systemui" || pkg == "android" || pkg == ime()
  private fun ime() = Settings.Secure.getString(app.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)?.substringBefore('/')
  // the clock too: an alarm is how you get up, so it never needs a break or the judge
  private val essentials by lazy { setOfNotNull(app.packageName, "com.android.phone", "com.android.server.telecom", dialer(), resolve(Intent(AlarmClock.ACTION_SHOW_ALARMS))) }
  private val launcher by lazy { resolve(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)) }
  val defaults by lazy {
    listOfNotNull(dialer(), Telephony.Sms.getDefaultSmsPackage(app), resolve(Intent(AlarmClock.ACTION_SHOW_ALARMS)),
      resolve(Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=home")))).distinct()
  }
  private fun dialer() = app.getSystemService(TelecomManager::class.java)?.defaultDialerPackage
  private fun resolve(i: Intent) =
    app.packageManager.resolveActivity(i, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName?.takeIf { it != "android" }

  /** The apps picked in the app (or this phone's defaults), usable during the lock. */
  fun allowlist(): List<String> {
    val a = state.optJSONArray("allowlist") ?: JSONArray()
    return (0 until a.length()).map { a.getString(it) }.ifEmpty { defaults }
  }

  fun allowed(pkg: String) = isChrome(pkg) || pkg in essentials || pkg in allowlist() || pkg in breakApps()

  /** What a judge break opens right now ("computer" is the Mac's). Empty when none is running. */
  fun breakApps(now: Instant = Instant.now()) = rules?.let { Schedule.appBreak(it, now) } ?: emptySet()

  fun launcherApps(): List<Pair<String, String>> {
    val pm = app.packageManager
    return pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
      .map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
      .distinctBy { it.first }.sortedBy { it.second.lowercase() }
  }

  private fun label(pkg: String) = if (pkg == "computer") "your Mac"
    else runCatching { app.packageManager.let { pm -> pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() } }.getOrDefault(pkg)

  private fun arm() {
    val am = app.getSystemService(AlarmManager::class.java)
    val pi = PendingIntent.getBroadcast(app, 1, Intent(app, SleepReceiver::class.java).setAction(ACTION_ALARM),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val edge = rules?.let { Schedule.nextEdge(it, zone, Instant.now()) } ?: return am.cancel(pi)
    val at = edge.toEpochMilli() + 250
    if (am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
    else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
  }

  fun lockNow() {
    val dpm = app.getSystemService(DevicePolicyManager::class.java)
    if (dpm.isAdminActive(ComponentName(app, SleepAdmin::class.java))) dpm.lockNow()
  }

  fun tapIntent(): PendingIntent =
    PendingIntent.getBroadcast(app, 0, Intent(app, SleepReceiver::class.java).setAction(ACTION_TAP), PendingIntent.FLAG_IMMUTABLE)

  fun notification(): Notification {
    val until = lockedUntil()
    val next = nextStart()
    val text = when {
      state.str("phraseHash") == null -> "Not armed: set an unlock phrase"
      until != null -> "Locked until ${hhmm(until)}"
      breakEnd() != null -> "On a break until ${hhmm(breakEnd()!!)}, then locked again"
      next != null -> "Armed · next lock ${hhmm(next)}"
      else -> "No lock scheduled"
    }
    val open = PendingIntent.getActivity(app, 0, app.packageManager.getLaunchIntentForPackage(app.packageName), PendingIntent.FLAG_IMMUTABLE)
    return Notification.Builder(app, SleepService.CHANNEL)
      .setSmallIcon(R.drawable.ic_sleep).setContentTitle("Curfew").setContentText(text)
      .setOngoing(true).setContentIntent(open).setCategory(Notification.CATEGORY_SERVICE)
      .apply { if (until == null) addAction(Notification.Action.Builder(null as Icon?, "Sleep now", tapIntent()).build()) }
      .build()
  }

  fun snapshot(): String = JSONObject()
    .put("state", state)
    .put("lockedUntil", lockedUntil()?.toString() ?: JSONObject.NULL)
    .put("nextStart", nextStart()?.toString() ?: JSONObject.NULL)
    .put("breakEnd", breakEnd()?.toString() ?: JSONObject.NULL)
    .put("appBreak", breakApps().takeIf { it.isNotEmpty() }?.let { a ->
      JSONObject().put("until", rules?.breakUntil.toString()).put("labels", JSONArray(a.map(::label)))
    } ?: JSONObject.NULL)
    .put("tapUntil", rules?.let { Schedule.tapUntil(it.sched, zone, Instant.now()).toString() } ?: JSONObject.NULL)
    .put("breaksLeft", maxOf(0, Schedule.BREAKS_PER_NIGHT - breaksTonight()))
    .put("connected", connected)
    .put("pending", pending)
    .put("configured", url.isNotEmpty())
    .put("defaults", JSONArray(defaults))
    .toString()
}
