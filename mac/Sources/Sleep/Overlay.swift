import AppKit
import SleepCore
import SwiftUI

// same manner as the phone: true black, the time in a light serif, quiet sans, outline pills, one orange
private let ink = Color.white
private let soft = Color(white: 0xA0 / 255)
private let rule = Color.white.opacity(0.28)
private let accent = Color(red: 1, green: 0x62 / 255, blue: 0x1E / 255)
private let bad = Color(red: 0xE5 / 255, green: 0x48 / 255, blue: 0x4D / 255)
private func sans(_ size: CGFloat) -> Font { .custom("InstrumentSans-Regular", size: size) }
private func serif(_ size: CGFloat) -> Font { .custom("Newsreader-Light", size: size) }

func hhmm(_ d: Date) -> String {
  let f = DateFormatter()
  f.dateFormat = "HH:mm"
  return f.string(from: d)
}

/// Where typing has gone wrong so far (1-based), or 0.
private func typo(_ typed: String, _ phrase: String) -> Int {
  for (i, (a, b)) in zip(typed, phrase).enumerated() where a != b { return i + 1 }
  return typed.count > phrase.count ? phrase.count + 1 : 0
}

/// Tonight's moon, the same sum as the phone: days since a known new moon, wrapped to the synodic month.
/// The frames (shared/moon) are rendered from NASA's LRO maps, CGI Moon Kit, public domain.
private enum Moon {
  static let synodic = 29.530588853
  static let newMoon = Date(timeIntervalSince1970: 947_182_440) // 2000-01-06 18:14 UTC
  static func age(_ d: Date = Date()) -> Double {
    let x = d.timeIntervalSince(newMoon) / 86_400
    return (x.truncatingRemainder(dividingBy: synodic) + synodic).truncatingRemainder(dividingBy: synodic)
  }
  static func lit(_ a: Double) -> Int { Int(((1 - cos(2 * .pi * a / synodic)) / 2 * 100).rounded()) }
  static func name(_ a: Double) -> String {
    switch a {
    case ..<1.85, 27.68...: return "New moon"
    case ..<5.54: return "Waxing crescent"
    case ..<9.23: return "First quarter"
    case ..<12.92: return "Waxing gibbous"
    case ..<16.61: return "Full moon"
    case ..<20.3: return "Waning gibbous"
    case ..<23.99: return "Last quarter"
    default: return "Waning crescent"
    }
  }
  static func image(_ a: Double) -> NSImage? { Bundle.main.image(forResource: "moon_" + String(format: "%02d", min(29, Int(a)))) }
}

enum Pane { case none, phrase, appeal }

final class LockModel: ObservableObject {
  @Published var until = Date()
  @Published var shame = 0
  @Published var phrase = "" // fresh words to copy by hand, drawn each time the pane opens
  @Published var pane = Pane.none
  @Published var typed = ""
  @Published var wrong: String? // why the phrase didn't unlock
  @Published var breaksLeft = 2
  @Published var reason = ""
  @Published var reply = ""
  @Published var asking = false
}

private final class LockWindow: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

/// One black window per screen, above the screen saver level, on every Space.
final class Overlay {
  let model = LockModel()
  private(set) var windows: [NSWindow] = []
  var onUnlock: () -> String? = { nil } // why not, or nil: a break started
  var onAppeal: (String, @escaping (String) -> Void) -> Void = { _, _ in }
  var isUp: Bool { !windows.isEmpty }

  func show(until: Date, shame: Int, breaksLeft: Int = 2) {
    model.breaksLeft = breaksLeft
    model.until = until
    model.shame = shame
    if windows.count != NSScreen.screens.count { rebuild() }
  }

  func rebuild() {
    windows.forEach { $0.orderOut(nil) }
    windows = NSScreen.screens.enumerated().map { i, screen in
      let w = LockWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
      w.level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1)
      w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
      w.backgroundColor = .black
      w.isOpaque = true
      w.ignoresMouseEvents = false
      w.acceptsMouseMovedEvents = true
      w.isReleasedWhenClosed = false
      w.contentView = NSHostingView(rootView: LockView(model: model, primary: i == 0, submit: { [weak self] in self?.submit() },
                                                       ask: { [weak self] in self?.ask() }))
      w.setFrame(screen.frame, display: true)
      return w
    }
    front()
  }

  func front() {
    windows.forEach { $0.orderFrontRegardless() }
    if windows.first?.isKeyWindow == false { windows.first?.makeKey() }
  }

  func hide() {
    windows.forEach { $0.orderOut(nil) }
    windows = []
    model.pane = .none
    model.typed = ""
    model.reason = ""
  }

  private func submit() {
    if model.typed != model.phrase { model.wrong = "That's not it. Here are new words"; model.phrase = Words.pick() }
    else if let why = onUnlock() { model.wrong = why } else { model.pane = .none }
    model.typed = ""
  }

  private func ask() {
    let reason = model.reason.trimmingCharacters(in: .whitespacesAndNewlines)
    guard reason.count >= 10, !model.asking else { return }
    model.asking = true
    model.reply = ""
    onAppeal(reason) { [weak self] reply in
      self?.model.asking = false
      self?.model.reply = reply
    }
  }
}

private struct LockView: View {
  @ObservedObject var model: LockModel
  let primary: Bool
  let submit: () -> Void
  let ask: () -> Void

  var body: some View {
    // a split for a wide screen: tonight's real moon on the right, running off the edge, everything to read on the left
    GeometryReader { g in
      let age = Moon.age(), edge = max(64, g.size.width * 0.07)
      ZStack(alignment: .leading) {
        Color.black
        if let moon = Moon.image(age) {
          Image(nsImage: moon).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
            .frame(height: g.size.height * 0.9).frame(maxWidth: .infinity, alignment: .trailing)
            .offset(x: g.size.height * 0.2).accessibilityHidden(true)
        }
        VStack(alignment: .leading, spacing: 12) {
          Text("\(Moon.name(age)), \(Moon.lit(age))% lit").font(sans(15)).foregroundColor(soft)
          TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let size = g.size.height * (model.pane == .none ? 0.24 : 0.14)
            Text(hhmm(ctx.date)).font(serif(size)).tracking(-size * 0.04).monospacedDigit().foregroundColor(ink)
          }
          Text("Locked until \(hhmm(model.until)). Go to sleep").font(sans(22)).foregroundColor(ink)
          Text((model.breaksLeft > 0 ? "\(model.breaksLeft) break\(model.breaksLeft > 1 ? "s" : "") left tonight" : "Both breaks used tonight, so only the judge can let you out")
               + (model.shame == 0 ? "" : ". \(model.shame) early unlocks in all")).font(sans(16)).foregroundColor(soft)
          if primary { pane(width: min(640, g.size.width * 0.42)) }
        }
        .padding(.leading, edge)
        if primary && model.pane == .none {
          VStack(alignment: .leading) {
            Spacer()
            HStack(spacing: 12) {
              // two typed breaks a night, then only the judge
              if model.breaksLeft > 0 { pill("Unlock early") { model.wrong = nil; model.phrase = Words.pick(); model.pane = .phrase } }
              else { pill("Ask the judge") { model.reply = ""; model.pane = .appeal } }
            }
            .padding(.leading, edge).padding(.bottom, 48)
          }
        }
      }
    }
    .ignoresSafeArea()
  }

  @ViewBuilder private func pane(width: CGFloat) -> some View {
    switch model.pane {
    case .none:
      EmptyView()
    case .phrase:
      VStack(alignment: .leading, spacing: 14) {
        // the part typed right so far lights up, same as on the phone
        let at = typo(model.typed, model.phrase)
        let k = at > 0 ? at - 1 : min(model.typed.count, model.phrase.count)
        (Text(model.phrase.prefix(k)).foregroundColor(accent) + Text(model.phrase.dropFirst(k)).foregroundColor(ink))
          .font(serif(28)).frame(width: width, alignment: .leading).fixedSize(horizontal: false, vertical: true)
        TypedField(text: $model.typed, noPaste: true, submit: submit, cancel: { model.pane = .none; model.typed = "" })
          .frame(width: width, height: 40).overlay(Rectangle().fill(rule).frame(height: 1), alignment: .bottom)
        Text(phraseStatus).font(sans(15)).foregroundColor(model.wrong != nil || isTypo ? bad : soft)
      }
      .padding(.top, 20)
    case .appeal:
      VStack(alignment: .leading, spacing: 14) {
        Text("Say what's happening and why it can't wait").font(sans(18)).foregroundColor(ink)
        TypedField(text: $model.reason, noPaste: false, submit: ask, cancel: { model.pane = .none; model.reason = "" })
          .frame(width: width, height: 40).overlay(Rectangle().fill(rule).frame(height: 1), alignment: .bottom)
        Text(model.asking ? "Asking the judge…" : model.reply.isEmpty ? "Both breaks are used, so the judge decides. Return to ask, Esc to cancel. 3 asks a night, 10 minutes apart." : model.reply)
          .font(sans(16)).foregroundColor(model.reply.isEmpty ? soft : ink).frame(width: width, alignment: .leading)
      }
      .padding(.top, 20)
    }
  }

  private var isTypo: Bool { typo(model.typed, model.phrase) > 0 }
  private var phraseStatus: String {
    if let why = model.wrong { return why }
    if case let at = typo(model.typed, model.phrase), at > 0 { return "Typo at character \(at)" }
    let left = model.breaksLeft == 1 ? "Your last break tonight" : "1 of 2 breaks tonight"
    return "\(model.typed.count) of \(model.phrase.count) typed. \(left). Return for 15 minutes, Esc to cancel."
  }

  private func pill(_ title: String, _ action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title).font(sans(15)).foregroundColor(ink).padding(.horizontal, 24).frame(height: 48)
        .overlay(Capsule().stroke(rule, lineWidth: 1)).contentShape(Capsule())
    }
    .buttonStyle(.plain)
  }
}

/// Typed, never pasted (when noPaste): any edit that inserts more than one character at once (paste, drop,
/// services) is refused, and there's no context menu. (No Edit menu either, so Cmd-V has nothing to fire.)
private final class TypedTextField: NSTextField {
  var noPaste = true
  @objc func textView(_ tv: NSTextView, shouldChangeTextIn range: NSRange, replacementString s: String?) -> Bool {
    !noPaste || (s?.count ?? 0) <= 1
  }
  @objc func textView(_ tv: NSTextView, menu: NSMenu, for event: NSEvent, at charIndex: Int) -> NSMenu? { noPaste ? nil : menu }
}

private struct TypedField: NSViewRepresentable {
  @Binding var text: String
  let noPaste: Bool
  let submit: () -> Void
  let cancel: () -> Void

  func makeNSView(context: Context) -> NSTextField {
    let f = TypedTextField()
    f.noPaste = noPaste
    f.delegate = context.coordinator
    f.font = NSFont(name: "InstrumentSans-Regular", size: 19) ?? .systemFont(ofSize: 19)
    f.textColor = .white
    f.drawsBackground = false
    f.isBordered = false // the underline is drawn by the view around it
    f.focusRingType = .none
    f.isAutomaticTextCompletionEnabled = false
    if noPaste { f.unregisterDraggedTypes() }
    DispatchQueue.main.async { f.window?.makeFirstResponder(f) }
    return f
  }

  func updateNSView(_ f: NSTextField, context: Context) {
    if f.stringValue != text { f.stringValue = text }
  }

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  final class Coordinator: NSObject, NSTextFieldDelegate {
    let parent: TypedField
    init(_ p: TypedField) { parent = p }

    func controlTextDidChange(_ n: Notification) {
      if let f = n.object as? NSTextField { parent.text = f.stringValue }
    }

    func control(_ c: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
      if sel == #selector(NSResponder.insertNewline(_:)) { parent.submit(); return true }
      if sel == #selector(NSResponder.cancelOperation(_:)) { parent.cancel(); return true }
      return false
    }
  }
}
