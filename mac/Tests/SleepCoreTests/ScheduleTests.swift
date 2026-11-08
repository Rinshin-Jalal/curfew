import Foundation
@testable import SleepCore
import XCTest

final class ScheduleTests: XCTestCase {
  private func cal(_ tz: String) -> Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: tz)!; return c }
  private let ny = "America/New_York"
  private let every = Sched(start: "00:00", end: "06:00", days: Array(0...6))
  private func t(_ s: String) -> Date { ISO.parse(s)! }
  private func state(_ mode: String = "scheduled", _ until: String? = nil) -> SleepState {
    SleepState(userId: 1, mode: mode, activeUntil: until, schedule: every, tz: "UTC", allowlist: [], earlyUnlocks: 0,
               phraseSalt: "ab", phraseHash: "x", updatedAt: "2026-07-15T00:00:00Z")
  }

  func testWindowEndsAt0600LocalOnBothDstNights() {
    let spring = Schedule.windowAt(every, cal(ny), t("2026-03-08T06:00:00Z"))!
    XCTAssertEqual(spring.start, t("2026-03-08T05:00:00Z"))
    XCTAssertEqual(spring.end, t("2026-03-08T10:00:00Z")) // 5 real hours
    let fall = Schedule.windowAt(every, cal(ny), t("2026-11-01T06:00:00Z"))!
    XCTAssertEqual(fall.start, t("2026-11-01T04:00:00Z"))
    XCTAssertEqual(fall.end, t("2026-11-01T11:00:00Z")) // 7 real hours
  }

  func testGapMovesForwardOverlapTakesFirst() {
    let gap = Sched(start: "02:30", end: "06:00", days: Array(0...6))
    XCTAssertEqual(Schedule.nextStart(gap, cal(ny), t("2026-03-08T04:00:00Z")), t("2026-03-08T07:30:00Z")) // 03:30 EDT
    let overlap = Sched(start: "01:30", end: "06:00", days: Array(0...6))
    XCTAssertEqual(Schedule.nextStart(overlap, cal(ny), t("2026-11-01T03:00:00Z")), t("2026-11-01T05:30:00Z")) // 01:30 EDT
  }

  func testNextEdgeAfterWakeOrReboot() {
    XCTAssertEqual(Schedule.nextEdge(state(), cal(ny), t("2026-07-15T19:00:00Z")), t("2026-07-16T04:00:00Z"))
    XCTAssertEqual(Schedule.nextEdge(state(), cal(ny), t("2026-07-16T04:00:00Z")), t("2026-07-16T10:00:00Z"))
  }

  func testManualOffAndNoPhrase() {
    let utc = cal("UTC"), two = t("2026-07-16T02:00:00Z")
    XCTAssertEqual(Schedule.lockedUntil(state(), utc, two), t("2026-07-16T06:00:00Z"))
    var noPhrase = state(); noPhrase.phraseHash = nil
    XCTAssertNil(Schedule.lockedUntil(noPhrase, utc, two))
    // a break: nothing until it ends, then the same window; the next edge is the break's end
    var br = state()
    br.breakUntil = "2026-07-16T02:15:00.000Z"
    XCTAssertNil(Schedule.lockedUntil(br, utc, two))
    XCTAssertEqual(Schedule.lockedUntil(br, utc, ISO.parse("2026-07-16T02:16:00.000Z")!), ISO.parse("2026-07-16T06:00:00.000Z"))
    XCTAssertEqual(Schedule.nextEdge(br, utc, two), ISO.parse("2026-07-16T02:15:00.000Z"))
    // a judge break for phone apps keeps the Mac locked; one that names the computer opens it
    br.breakApps = ["com.amazon.kindle"]
    XCTAssertEqual(Schedule.lockedUntil(br, utc, two), t("2026-07-16T06:00:00Z"))
    br.breakApps = ["com.amazon.kindle", "computer"]
    XCTAssertNil(Schedule.lockedUntil(br, utc, two))
    XCTAssertEqual(Schedule.lockedUntil(state("manual", "2026-07-15T23:00:00.000Z"), utc, t("2026-07-15T15:00:00Z")), t("2026-07-15T23:00:00Z"))
  }

  func testTap() {
    XCTAssertEqual(Schedule.tapUntil(every, cal("UTC"), t("2026-07-15T22:00:00Z")), t("2026-07-16T06:00:00Z"))
    XCTAssertEqual(Schedule.tapUntil(every, cal("UTC"), t("2026-07-15T14:00:00Z")), t("2026-07-15T22:00:00Z"))
  }

  func testWordsAreFreshAndDifferent() {
    let a = Words.pick().split(separator: " ")
    XCTAssertEqual(a.count, 8)
    XCTAssertEqual(Set(a).count, 8)
    XCTAssertNotEqual(Words.pick(), Words.pick()) // 1 in ~10^20 to clash
  }

  func testNightRunsNoonToNoon() {
    var s = state()
    s.breaks = ["2026-11-04T20:29:00Z", "2026-11-04T20:42:00Z"] // 01:59 and 02:12 in India
    let ist = cal("Asia/Kolkata")
    XCTAssertEqual(Schedule.breaksTonight(s, ist, t("2026-11-04T22:30:00Z")), 2) // 04:00
    XCTAssertEqual(Schedule.breaksTonight(s, ist, t("2026-11-05T08:00:00Z")), 0) // 13:30: last night's are behind noon
  }
}
