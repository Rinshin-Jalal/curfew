import AppKit
import Carbon.HIToolbox
import SleepCore

// Menu-bar only (LSUIElement). Kept alive by the LaunchAgent, so Cmd-Q / a crash comes back within seconds.

private let kiosk: NSApplication.PresentationOptions = [ // no Dock, no menu bar, no Cmd-Tab, no Force Quit dialog
  .hideDock, .hideMenuBar, .disableProcessSwitching, .disableForceQuit, .disableHideApplication, .disableAppleMenu,
]
private let hostsHelper = "/Library/PrivilegedHelperTools/com.noexcuselabs.sleep-hosts"

private var hotkeyAction: () -> Void = {}

final class App: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private let sync = Sync()
  private let overlay = Overlay()
  private let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let d = UserDefaults.standard
  private var locked: Bool? // nil until the first evaluate, so a stale /etc/hosts block gets cleaned at launch
  private var lockedSince = Date()
  private var lastDisplaySleep = Date.distantPast
  private var edgeTimer: Timer?
  private var poweringOff = false

  func applicationDidFinishLaunching(_ n: Notification) {
    for font in ["Newsreader_300Light", "Newsreader_400Regular", "InstrumentSans_400Regular", "InstrumentSans_500Medium"] {
      if let url = Bundle.main.url(forResource: font, withExtension: "ttf") { CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil) }
    }
    // `Curfew -previewLock YES`: show the lock screen for 6 seconds and quit. No sync, no kiosk, no killing apps.
    if UserDefaults.standard.bool(forKey: "previewLock") {
      overlay.show(until: Date().addingTimeInterval(4 * 3600), shame: 0)
      if UserDefaults.standard.bool(forKey: "previewWords") { overlay.model.phrase = Words.pick(); overlay.model.pane = .phrase } // `-previewWords YES` too
      DispatchQueue.main.asyncAfter(deadline: .now() + 6) { exit(0) }
      return
    }
    sync.onChange = { [weak self] in self?.evaluate() }
    overlay.onUnlock = { [weak self] in self?.sync.unlock() ?? "Not synced yet" }
    overlay.onAppeal = { [weak self] reason, done in self?.sync.appeal(reason, done) }

    status.menu = NSMenu()
    status.menu?.delegate = self
    status.menu?.autoenablesItems = false

    Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.evaluate() }
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.reassert() }

    let ws = NSWorkspace.shared.notificationCenter
    ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
      self?.evaluate()
      self?.sync.connectIfDown()
    }
    ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in self?.reassert() }
    ws.addObserver(forName: NSWorkspace.willPowerOffNotification, object: nil, queue: .main) { [weak self] _ in self?.poweringOff = true }
    for name in [Notification.Name.NSSystemClockDidChange, .NSSystemTimeZoneDidChange] {
      NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.evaluate() }
    }
    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      if self?.overlay.isUp == true { self?.overlay.rebuild() }
    }
    NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .mouseMoved, .leftMouseDown, .rightMouseDown, .scrollWheel]) { [weak self] e in
      self?.activity()
      return e
    }

    hotkeyAction = { [weak self] in self?.sync.tap() }
    registerHotkey() // ⌃⌥⌘S

    sync.connect()
    evaluate()
  }

  /// Cached state + this Mac's clock decide. Runs on every change, every 30s, at each edge, on wake and clock change.
  private func evaluate() {
    let until = sync.state.flatMap { Schedule.lockedUntil($0, .autoupdatingCurrent, Date()) }
    if let until {
      if locked != true { startLock() }
      overlay.show(until: until, shame: sync.state?.earlyUnlocks ?? 0,
                   breaksLeft: max(0, Schedule.breaksPerNight - (sync.state.map { Schedule.breaksTonight($0, .autoupdatingCurrent, Date()) } ?? 0)))
    } else if locked != false {
      endLock()
    }
    status.button?.image = NSImage(systemSymbolName: until != nil ? "moon.zzz.fill" : "moon.zzz", accessibilityDescription: "Curfew")
    armEdge()
  }

  private func startLock() {
    locked = true
    lockedSince = Date()
    NSApp.activate(ignoringOtherApps: true)
    NSApp.presentationOptions = kiosk
    run(sudo: true, hostsHelper, "on")
    // apps stay open, just out of reach behind the lock. The Mac goes quiet, and gets its sound back after.
    if !muted() { setMuted(true); d.set(true, forKey: "unmuteAfterLock") }
    if d.bool(forKey: "sleepMacAtStart") { run("/usr/bin/pmset", "sleepnow") }
  }

  private func endLock() {
    locked = false
    overlay.hide()
    NSApp.presentationOptions = []
    run(sudo: true, hostsHelper, "off")
    if d.bool(forKey: "unmuteAfterLock") { setMuted(false); d.removeObject(forKey: "unmuteAfterLock") }
  }

  // Standard Additions run in-process, so no automation permission is needed
  private func muted() -> Bool { NSAppleScript(source: "output muted of (get volume settings)")?.executeAndReturnError(nil).booleanValue ?? false }
  private func setMuted(_ on: Bool) { NSAppleScript(source: on ? "set volume with output muted" : "set volume without output muted")?.executeAndReturnError(nil) }

  /// Keep the overlay frontmost and key so Cmd-Tab, Spotlight or a notification can't get behind it.
  private func reassert() {
    guard locked == true, overlay.isUp else { return }
    if !NSApp.isActive { NSApp.activate(ignoringOtherApps: true) }
    if NSApp.presentationOptions != kiosk { NSApp.presentationOptions = kiosk }
    overlay.front()
  }

  /// After 10 minutes locked, poking the keyboard or mouse just puts the display back to sleep.
  private func activity() {
    guard locked == true, Date().timeIntervalSince(lockedSince) > 600, overlay.model.pane == .none,
          Date().timeIntervalSince(lastDisplaySleep) > 5 else { return }
    lastDisplaySleep = Date()
    run("/usr/bin/pmset", "displaysleepnow")
  }

  private func armEdge() {
    edgeTimer?.invalidate()
    guard let s = sync.state, let edge = Schedule.nextEdge(s, .autoupdatingCurrent, Date()) else { return }
    let t = Timer(fire: edge.addingTimeInterval(0.25), interval: 0, repeats: false) { [weak self] _ in self?.evaluate() }
    RunLoop.main.add(t, forMode: .common)
    edgeTimer = t
  }

  private func run(sudo: Bool = false, _ path: String, _ args: String...) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: sudo ? "/usr/bin/sudo" : path)
    p.arguments = sudo ? ["-n", path] + args : args // -n: never prompt; without the sudoers rule it just fails
    try? p.run()
  }

  // Cmd-Q, `osascript quit`, etc. are refused mid-lock; logout/restart/shutdown still go through.
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    locked == true && !poweringOff ? .terminateCancel : .terminateNow
  }

  // MARK: menu, rebuilt each time it opens

  func menuNeedsUpdate(_ m: NSMenu) {
    m.removeAllItems()
    let s = sync.state
    let now = Date()
    let until = s.flatMap { Schedule.lockedUntil($0, .autoupdatingCurrent, now) }
    let next = s.flatMap { $0.phraseHash == nil ? nil : Schedule.nextStart($0.schedule, .autoupdatingCurrent, now) }
    // during a break "Next lock" would name tomorrow's start, as if tonight were over
    let breakEnd = s.flatMap { st in ISO.parse(st.breakUntil).flatMap { $0 > now && Schedule.lockUnderway(st, .autoupdatingCurrent, now) != nil ? $0 : nil } }
    let line = s?.phraseHash == nil ? "Not armed: set a phrase in the phone app"
      : until.map { "Locked until \(hhmm($0))" } ?? breakEnd.map { "On a break until \(hhmm($0)), then locked again" }
      ?? next.map { "Next lock \(hhmm($0))" } ?? "No lock scheduled"
    for text in [line, "Early unlocks: \(s?.earlyUnlocks ?? 0)", sync.connected ? "Synced" : "Offline"] {
      let i = NSMenuItem(title: text, action: nil, keyEquivalent: "")
      i.isEnabled = false
      m.addItem(i)
    }
    m.addItem(.separator())
    let tap = NSMenuItem(title: "Sleep now", action: #selector(tapNow), keyEquivalent: "s")
    tap.keyEquivalentModifierMask = [.control, .option, .command]
    tap.target = self
    tap.isEnabled = s?.phraseHash != nil
    m.addItem(tap)
    let sleepMac = NSMenuItem(title: "Sleep the Mac at lock start", action: #selector(toggleSleepMac), keyEquivalent: "")
    sleepMac.target = self
    sleepMac.state = d.bool(forKey: "sleepMacAtStart") ? .on : .off
    m.addItem(sleepMac)
  }

  @objc private func tapNow() { sync.tap() }
  @objc private func toggleSleepMac() { d.set(!d.bool(forKey: "sleepMacAtStart"), forKey: "sleepMacAtStart") }

  // Carbon hot key: global, and needs no Accessibility permission.
  private func registerHotkey() {
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in hotkeyAction(); return noErr }, 1, &spec, nil, nil)
    var ref: EventHotKeyRef?
    RegisterEventHotKey(UInt32(kVK_ANSI_S), UInt32(controlKey | optionKey | cmdKey),
                        EventHotKeyID(signature: OSType(0x534C_5050), id: 1), GetApplicationEventTarget(), 0, &ref)
  }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
