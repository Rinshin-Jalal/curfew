package com.noexcuselabs.sleepcore

import java.time.Duration
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime

// Pure java.time, no Android, so it runs as a plain JVM unit test.
// Same rules as server/src/logic.ts and mac Schedule.swift; keep them in step.

data class Sched(val start: LocalTime, val end: LocalTime, val days: Set<Int>) // days a window starts on, 0 = Sunday

data class Rules(
  val mode: String, // scheduled | manual ("off" is from before breaks and means scheduled)
  val activeUntil: Instant?,
  val sched: Sched,
  val phraseHash: String?,
  val breakUntil: Instant? = null, // nothing enforced until then; the running lock is simply still there after
)

data class Window(val start: Instant, val end: Instant)

object Schedule {
  /** Every window from the one that started yesterday to a week out, in order. */
  fun windows(s: Sched, zone: ZoneId, now: Instant): List<Window> {
    val today = now.atZone(zone).toLocalDate()
    return (-1L..7L).mapNotNull { i ->
      val d = today.plusDays(i)
      if (d.dayOfWeek.value % 7 !in s.days) return@mapNotNull null
      // ZonedDateTime.of: a time in the spring gap moves forward by the gap, an overlap takes the earlier offset
      val start = ZonedDateTime.of(d, s.start, zone).toInstant()
      val end = ZonedDateTime.of(if (s.end <= s.start) d.plusDays(1) else d, s.end, zone).toInstant()
      Window(start, end)
    }
  }

  fun windowAt(s: Sched, zone: ZoneId, now: Instant) = windows(s, zone, now).firstOrNull { it.start <= now && now < it.end }

  fun nextStart(s: Sched, zone: ZoneId, now: Instant) = windows(s, zone, now).firstOrNull { it.start > now }?.start

  const val BREAK_MIN = 15L // a phrase unlock is a break this long
  const val BREAKS_PER_NIGHT = 2

  /** When tonight started: the latest local noon, so one night's breaks never spill into the next lock. */
  fun nightStart(zone: ZoneId, now: Instant): Instant {
    val z = now.atZone(zone)
    val noon = z.toLocalDate().atTime(12, 0).atZone(zone)
    return (if (z.isBefore(noon)) noon.minusDays(1) else noon).toInstant()
  }

  /** The lock that's running, break or not. No phrase = nothing enforced: there must always be a way out. */
  fun lockUnderway(r: Rules, zone: ZoneId, now: Instant): Instant? {
    if (r.phraseHash == null) return null
    val until = r.activeUntil
    val manual = if (r.mode == "manual" && until != null && until > now) until else null
    return listOfNotNull(manual, windowAt(r.sched, zone, now)?.end).maxOrNull()
  }

  /** Locked until when, or null: the lock underway, unless you're on a break from it. */
  fun lockedUntil(r: Rules, zone: ZoneId, now: Instant): Instant? =
    if (r.breakUntil != null && r.breakUntil > now) null else lockUnderway(r, zone, now)

  /** SLEEP tapped: the coming window end if it's within 12h, else 8h from now. */
  fun tapUntil(s: Sched, zone: ZoneId, now: Instant): Instant {
    val end = windowAt(s, zone, now)?.end ?: windows(s, zone, now).firstOrNull { it.start > now }?.end
    return if (end != null && Duration.between(now, end) <= Duration.ofHours(12)) end else now.plus(Duration.ofHours(8))
  }

  /** The next moment anything can change. The exact alarm is set here. */
  fun nextEdge(r: Rules, zone: ZoneId, now: Instant): Instant? =
    (listOfNotNull(r.activeUntil, r.breakUntil) + windows(r.sched, zone, now).flatMap { listOf(it.start, it.end) })
      .filter { it > now }.minOrNull()
}
