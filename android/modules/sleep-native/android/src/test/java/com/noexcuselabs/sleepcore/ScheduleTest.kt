package com.noexcuselabs.sleepcore

import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ScheduleTest {
  private val ny = ZoneId.of("America/New_York")
  private val utc = ZoneId.of("UTC")
  private val every = Sched(LocalTime.of(0, 0), LocalTime.of(6, 0), (0..6).toSet())
  private fun t(s: String) = Instant.parse(s)
  private fun rules(mode: String = "scheduled", until: String? = null) = Rules(mode, until?.let(::t), every, "hash")

  @Test fun windowEndsAt0600LocalOnBothDstNights() {
    // spring forward 2026-03-08: 00:00 EST -> 06:00 EDT is 5 real hours
    val spring = Schedule.windowAt(every, ny, t("2026-03-08T06:00:00Z"))!!
    assertEquals(t("2026-03-08T05:00:00Z"), spring.start)
    assertEquals(t("2026-03-08T10:00:00Z"), spring.end)
    // fall back 2026-11-01: 00:00 EDT -> 06:00 EST is 7 real hours
    val fall = Schedule.windowAt(every, ny, t("2026-11-01T06:00:00Z"))!!
    assertEquals(t("2026-11-01T04:00:00Z"), fall.start)
    assertEquals(t("2026-11-01T11:00:00Z"), fall.end)
  }

  @Test fun startInsideTheSpringGapMovesForward() {
    val s = Sched(LocalTime.of(2, 30), LocalTime.of(6, 0), (0..6).toSet())
    assertEquals(t("2026-03-08T07:30:00Z"), Schedule.nextStart(s, ny, t("2026-03-08T04:00:00Z"))) // 03:30 EDT
  }

  @Test fun nextEdgeAfterRebootIsTonightsStartThenItsEnd() {
    // the alarm re-armed at boot: 15:00 local -> tonight 00:00 -> 06:00
    assertEquals(t("2026-07-16T04:00:00Z"), Schedule.nextEdge(rules(), ny, t("2026-07-15T19:00:00Z")))
    assertEquals(t("2026-07-16T10:00:00Z"), Schedule.nextEdge(rules(), ny, t("2026-07-16T04:00:00Z")))
  }

  @Test fun manualOffAndNoPhrase() {
    val two = t("2026-07-16T02:00:00Z")
    assertEquals(t("2026-07-16T06:00:00Z"), Schedule.lockedUntil(rules(), utc, two))
    assertNull(Schedule.lockedUntil(rules().copy(phraseHash = null), utc, two))
    // a break: nothing until it ends, then the same window; the alarm fires at the break's end
    val br = rules().copy(breakUntil = t("2026-07-16T02:15:00Z"))
    assertNull(Schedule.lockedUntil(br, utc, two))
    assertEquals(t("2026-07-16T06:00:00Z"), Schedule.lockedUntil(br, utc, t("2026-07-16T02:16:00Z")))
    assertEquals(t("2026-07-16T02:15:00Z"), Schedule.nextEdge(br, utc, two))
    assertEquals(t("2026-07-15T23:00:00Z"), Schedule.lockedUntil(rules("manual", "2026-07-15T23:00:00Z"), utc, t("2026-07-15T15:00:00Z")))
  }

  @Test fun tapBeforeBedRunsToMorningMidDayRunsEightHours() {
    assertEquals(t("2026-07-16T06:00:00Z"), Schedule.tapUntil(every, utc, t("2026-07-15T22:00:00Z")))
    assertEquals(t("2026-07-15T22:00:00Z"), Schedule.tapUntil(every, utc, t("2026-07-15T14:00:00Z")))
  }

  @Test fun nightRunsNoonToNoon() {
    val z = ZoneId.of("Asia/Kolkata")
    fun at(s: String) = java.time.LocalDateTime.parse(s).atZone(z).toInstant()
    assertEquals(at("2026-11-04T12:00"), Schedule.nightStart(z, at("2026-11-05T02:12")))
    assertEquals(at("2026-11-05T12:00"), Schedule.nightStart(z, at("2026-11-05T13:30"))) // last night's breaks are behind this
    assertEquals(at("2026-11-04T12:00"), Schedule.nightStart(z, at("2026-11-04T23:00")))
  }
}
