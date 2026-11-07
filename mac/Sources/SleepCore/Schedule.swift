import Foundation

// Same rules as server/src/logic.ts and Android Schedule.kt; keep them in step.

public struct Sched: Codable, Equatable {
  public var start: String // "HH:MM" local
  public var end: String // end <= start crosses midnight
  public var days: [Int] // days a window starts on, 0 = Sunday
  public init(start: String, end: String, days: [Int]) { self.start = start; self.end = end; self.days = days }
}

public struct SleepState: Codable, Equatable {
  public var userId: Int
  public var mode: String // scheduled | manual ("off" is from before breaks and means scheduled)
  public var activeUntil: String?
  public var schedule: Sched
  public var tz: String
  public var allowlist: [String]
  public var earlyUnlocks: Int
  public var emergencyUnlocks: Int?
  public var breakUntil: String? // nothing enforced until then; the running lock is simply still there after
  public var breaks: [String]? // starts of recent phrase breaks, to cap them per night
  public var phrase: String? // shown on the lock screen: you don't have to remember it, you have to type it
  public var phraseSalt: String?
  public var phraseHash: String?
  public var updatedAt: String
}

public enum ISO {
  private static let frac: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
  private static let plain = ISO8601DateFormatter()
  public static func parse(_ s: String?) -> Date? { s.flatMap { frac.date(from: $0) ?? plain.date(from: $0) } }
  public static func string(_ d: Date) -> String { frac.string(from: d) }
}

public struct Window: Equatable {
  public let start: Date
  public let end: Date
}

public enum Schedule {
  private static func minutes(_ hhmm: String) -> (Int, Int) {
    let p = hhmm.split(separator: ":").compactMap { Int($0) }
    return (p.first ?? 0, p.count > 1 ? p[1] : 0)
  }

  /// HH:MM on a calendar day. A time in the spring gap moves forward by the gap; an overlap takes the first one.
  /// (date(from:) does exactly that; date(bySettingHour:) snaps a gap time to the hour instead, which disagrees with the server.)
  private static func at(_ day: Date, _ hhmm: String, _ cal: Calendar) -> Date {
    let (h, m) = minutes(hhmm)
    var c = cal.dateComponents([.year, .month, .day], from: day)
    c.hour = h
    c.minute = m
    return cal.date(from: c)!
  }

  /// Every window from the one that started yesterday to a week out, in order.
  public static func windows(_ s: Sched, _ cal: Calendar, _ now: Date) -> [Window] {
    let today = cal.startOfDay(for: now)
    let crosses = minutes(s.end) <= minutes(s.start)
    return (-1...7).compactMap { i in
      let d = cal.date(byAdding: .day, value: i, to: today)!
      guard s.days.contains(cal.component(.weekday, from: d) - 1) else { return nil }
      return Window(start: at(d, s.start, cal), end: at(crosses ? cal.date(byAdding: .day, value: 1, to: d)! : d, s.end, cal))
    }
  }

  public static func windowAt(_ s: Sched, _ cal: Calendar, _ now: Date) -> Window? {
    windows(s, cal, now).first { $0.start <= now && now < $0.end }
  }

  public static func nextStart(_ s: Sched, _ cal: Calendar, _ now: Date) -> Date? {
    windows(s, cal, now).first { $0.start > now }?.start
  }

  /// Locked until when, or nil. No phrase = nothing enforced: there must always be a way out.
  public static let breakMinutes = 15.0 // a phrase unlock is a break this long
  public static let breaksPerNight = 2

  /// The lock that's running, break or not. No phrase = nothing enforced.
  public static func lockUnderway(_ st: SleepState, _ cal: Calendar, _ now: Date) -> Date? {
    guard st.phraseHash != nil else { return nil }
    let manual = st.mode == "manual" ? ISO.parse(st.activeUntil).flatMap { $0 > now ? $0 : nil } : nil
    return [manual, windowAt(st.schedule, cal, now)?.end].compactMap { $0 }.max()
  }

  /// Locked until when, or nil: the lock underway, unless you're on a break from it.
  public static func lockedUntil(_ st: SleepState, _ cal: Calendar, _ now: Date) -> Date? {
    if let b = ISO.parse(st.breakUntil), b > now { return nil }
    return lockUnderway(st, cal, now)
  }

  /// Phrase breaks started in the last 12 hours.
  public static func breaksTonight(_ st: SleepState, _ cal: Calendar, _ now: Date) -> Int {
    let since = nightStart(cal, now)
    return (st.breaks ?? []).compactMap(ISO.parse).filter { $0 >= since }.count
  }

  /// When tonight started: the latest local noon, so one night's breaks never spill into the next lock.
  public static func nightStart(_ cal: Calendar, _ now: Date) -> Date {
    let noon = cal.date(bySettingHour: 12, minute: 0, second: 0, of: now)!
    return noon > now ? cal.date(byAdding: .day, value: -1, to: noon)! : noon
  }

  /// SLEEP tapped: the coming window end if it's within 12h, else 8h from now.
  public static func tapUntil(_ s: Sched, _ cal: Calendar, _ now: Date) -> Date {
    let end = windowAt(s, cal, now)?.end ?? windows(s, cal, now).first { $0.start > now }?.end
    if let end, end.timeIntervalSince(now) <= 12 * 3600 { return end }
    return now.addingTimeInterval(8 * 3600)
  }

  /// The next moment anything can change.
  public static func nextEdge(_ st: SleepState, _ cal: Calendar, _ now: Date) -> Date? {
    let edges = [ISO.parse(st.activeUntil), ISO.parse(st.breakUntil)].compactMap { $0 } + windows(st.schedule, cal, now).flatMap { [$0.start, $0.end] }
    return edges.filter { $0 > now }.min()
  }

}
