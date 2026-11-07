package com.noexcuselabs.sleepcore

import android.app.AlarmManager
import android.app.AppOpsManager
import android.app.NotificationManager
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.os.Process
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject

/** The JS screens' window into SleepCore. Anything that touches state or the overlay runs on the main thread. */
class SleepModule : Module() {
  private val ctx: Context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()
  private val onChange: () -> Unit = { sendEvent("onChange") }

  override fun definition() = ModuleDefinition {
    Name("SleepNative")
    Events("onChange")

    OnCreate {
      SleepCore.init(ctx)
      SleepCore.listeners += onChange
    }
    OnDestroy { SleepCore.listeners -= onChange }

    AsyncFunction("configure") { url: String, token: String ->
      SleepCore.configure(url, token)
      SleepService.start(ctx)
    }.runOnQueue(Queues.MAIN)

    Function("snapshot") { SleepCore.snapshot() }
    AsyncFunction("tap") { SleepCore.tap() }.runOnQueue(Queues.MAIN)
    AsyncFunction("unlock") { -> SleepCore.unlock() }.runOnQueue(Queues.MAIN)
    AsyncFunction("update") { body: String, promise: Promise ->
      SleepCore.put(body) { ok, res -> if (ok) promise.resolve(res) else promise.reject("E_SLEEP", res, null) }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("appeal") { reason: String, promise: Promise ->
      SleepCore.appeal(reason) { ok, res -> if (ok) promise.resolve(res) else promise.reject("E_SLEEP", res, null) }
    }.runOnQueue(Queues.MAIN)
    Function("takeRoute") { SleepCore.pendingRoute.also { SleepCore.pendingRoute = null } }

    Function("apps") {
      val pm = ctx.packageManager
      val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
        .map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
        .distinctBy { it.first }.sortedBy { it.second.lowercase() }
      JSONArray(apps.map { JSONObject().put("pkg", it.first).put("label", it.second) }).toString()
    }

    Function("permissions") {
      val pkg = ctx.packageName
      val a11y = ComponentName(ctx, SleepA11y::class.java).flattenToString()
      mapOf(
        "accessibility" to (Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)?.contains(a11y) == true),
        "overlay" to Settings.canDrawOverlays(ctx),
        "usage" to (ctx.getSystemService(AppOpsManager::class.java)
          .unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), pkg) == AppOpsManager.MODE_ALLOWED),
        "admin" to ctx.getSystemService(DevicePolicyManager::class.java).isAdminActive(ComponentName(ctx, SleepAdmin::class.java)),
        "notifications" to ctx.getSystemService(NotificationManager::class.java).areNotificationsEnabled(),
        "quiet" to ctx.getSystemService(NotificationManager::class.java)
          .isNotificationListenerAccessGranted(ComponentName(ctx, SleepNotifications::class.java)),
        "exactAlarm" to ctx.getSystemService(AlarmManager::class.java).canScheduleExactAlarms(),
        "battery" to ctx.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(pkg),
      )
    }

    AsyncFunction("openPermission") { key: String ->
      val pkgUri = Uri.parse("package:${ctx.packageName}")
      val i = when (key) {
        "accessibility" -> Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
        "overlay" -> Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkgUri)
        "usage" -> Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
        "admin" -> Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN)
          .putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, ComponentName(ctx, SleepAdmin::class.java))
          .putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Turns the screen off 8 seconds after the lock shows.")
        "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
        "quiet" -> Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
          .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, ComponentName(ctx, SleepNotifications::class.java).flattenToString())
        "exactAlarm" -> Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkgUri)
        "battery" -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkgUri)
        else -> return@AsyncFunction
      }
      // from our own activity, without NEW_TASK: the device admin screen closes itself instantly if started as a new task
      appContext.currentActivity?.startActivity(i) ?: ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }.runOnQueue(Queues.MAIN)
  }
}
