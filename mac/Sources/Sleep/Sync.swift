import Foundation
import SleepCore

/// Server mirror: the cached state, one pending local action, and a socket that reconnects with backoff.
/// Everything runs on the main queue. The lock never waits on any of this.
final class Sync: NSObject, URLSessionWebSocketDelegate {
  private let d = UserDefaults.standard
  private(set) var state: SleepState?
  private(set) var connected = false
  var onChange: () -> Void = {}

  private var task: URLSessionWebSocketTask?
  private var backoff: TimeInterval = 1
  private var flushing = false
  private lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: .main)
  private var base: String { (d.string(forKey: "apiURL") ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/")) }
  private var token: String { d.string(forKey: "apiToken") ?? "" }
  private var cal: Calendar { .autoupdatingCurrent }

  // one slot: the latest local action wins
  private var pending: [String: String]? {
    get { d.dictionary(forKey: "pending") as? [String: String] }
    set { d.set(newValue, forKey: "pending") }
  }

  override init() {
    super.init()
    if let data = d.data(forKey: "state") { state = try? JSONDecoder().decode(SleepState.self, from: data) }
    Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
      self?.task?.sendPing { err in if err != nil { DispatchQueue.main.async { self?.lostCurrent() } } }
    }
  }

  private func setState(_ s: SleepState) {
    state = s
    d.set(try? JSONEncoder().encode(s), forKey: "state")
    onChange()
  }

  // MARK: actions, local first

  func tap() {
    guard var s = state, s.phraseHash != nil else { return } // unarmed: a tap now would only turn into a surprise lock later
    var until = Schedule.tapUntil(s.schedule, cal, Date())
    if s.mode == "manual", let cur = ISO.parse(s.activeUntil), cur > until { until = cur } // never shortens
    s.mode = "manual"
    s.activeUntil = ISO.string(until)
    s.breakUntil = nil // a tap ends a break
    s.breakApps = nil
    s.updatedAt = ISO.string(Date())
    pending = ["kind": "tap", "value": ISO.string(until)]
    setState(s)
    flush()
  }

  /// A 15 minute break, at most 2 a night, then the lock is back by itself. The overlay checked the typing; this
  /// works offline and the server hears (and counts) it on the next sync. Returns why not, or nil.
  func unlock() -> String? {
    guard var s = state else { return "Not synced yet" }
    let now = Date()
    if Schedule.breaksTonight(s, .autoupdatingCurrent, now) >= Schedule.breaksPerNight { return "That's both breaks for tonight" }
    s.breakUntil = ISO.string(now.addingTimeInterval(Schedule.breakMinutes * 60))
    s.breakApps = nil // a typed break opens everything
    s.breaks = Array(((s.breaks ?? []) + [ISO.string(now)]).suffix(10))
    s.earlyUnlocks += 1
    s.updatedAt = ISO.string(Date())
    pending = ["kind": "unlock", "value": ""]
    setState(s)
    flush()
    return nil
  }

  /// Emergency: the AI judge on the server decides. An approval carries the new state, which both devices adopt.
  func appeal(_ reason: String, _ done: @escaping (String) -> Void) {
    call("POST", "/sleep/appeal", ["reason": reason]) { code, data in
      let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      if code == 200, let s = j?["state"], let raw = try? JSONSerialization.data(withJSONObject: s) { self.adopt(raw) }
      done(j?["reply"] as? String ?? j?["error"] as? String ?? (code == -1 ? "Offline: can't reach the judge." : "HTTP \(code)"))
    }
  }

  // MARK: sync

  private func call(_ method: String, _ path: String, _ body: [String: String]?, _ done: @escaping (Int, Data) -> Void) {
    guard !base.isEmpty, let url = URL(string: base + path) else { return done(-1, Data()) }
    var r = URLRequest(url: url)
    r.httpMethod = method
    r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    if let body {
      r.httpBody = try? JSONSerialization.data(withJSONObject: body)
      r.setValue("application/json", forHTTPHeaderField: "content-type")
    }
    session.dataTask(with: r) { data, res, _ in
      let code = (res as? HTTPURLResponse)?.statusCode ?? -1
      DispatchQueue.main.async { done(code, data ?? Data()) }
    }.resume()
  }

  /// Push the pending local action, then take the server's word for everything else.
  func flush() {
    guard !flushing else { return }
    guard let p = pending, let kind = p["kind"], let value = p["value"] else {
      return call("GET", "/sleep", nil) { code, data in if code == 200 { self.adopt(data) } }
    }
    flushing = true
    let (path, body) = kind == "tap" ? ("/sleep/tap", ["until": value]) : ("/sleep/unlock", [String: String]())
    call("POST", path, body) { code, data in
      self.flushing = false
      if code == -1 || code >= 500 { return } // offline: retried on the next connect
      if self.pending == p { self.pending = nil }
      // 4xx = the server disagrees (phrase changed elsewhere): drop it and resync
      if self.pending != nil || code != 200 { self.flush() } else { self.adopt(data) }
    }
  }

  private func adopt(_ data: Data) {
    guard pending == nil, let s = try? JSONDecoder().decode(SleepState.self, from: data) else { return }
    setState(s)
  }

  func connect() {
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    guard !base.isEmpty, var c = URLComponents(string: base + "/sleep/stream") else { return }
    c.scheme = c.scheme == "https" ? "wss" : "ws"
    c.queryItems = [URLQueryItem(name: "t", value: token)]
    guard let url = c.url else { return }
    let t = session.webSocketTask(with: url)
    task = t
    t.resume()
    receive(t)
  }

  func connectIfDown() { if task == nil { connect() } }

  private func receive(_ t: URLSessionWebSocketTask) {
    t.receive { [weak self] result in
      DispatchQueue.main.async {
        guard let self, t === self.task else { return }
        switch result {
        case .success(.string(let s)): self.adopt(Data(s.utf8)); self.receive(t)
        case .success: self.receive(t)
        case .failure: self.lost(t)
        }
      }
    }
  }

  private func lostCurrent() { if let t = task { lost(t) } }

  private func lost(_ t: URLSessionWebSocketTask) {
    guard t === task else { return }
    task = nil
    connected = false
    onChange()
    DispatchQueue.main.asyncAfter(deadline: .now() + backoff) { [weak self] in self?.connectIfDown() }
    backoff = min(backoff * 2, 60)
  }

  func urlSession(_ s: URLSession, webSocketTask t: URLSessionWebSocketTask, didOpenWithProtocol p: String?) {
    guard t === task else { return }
    connected = true
    backoff = 1
    flush()
    let tz = TimeZone.current.identifier
    if state?.tz != tz { call("PUT", "/sleep", ["tz": tz]) { code, data in if code == 200 { self.adopt(data) } } }
    onChange()
  }

  func urlSession(_ s: URLSession, webSocketTask t: URLSessionWebSocketTask, didCloseWith code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    lost(t)
  }

  func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let t = task as? URLSessionWebSocketTask { lost(t) }
  }
}
