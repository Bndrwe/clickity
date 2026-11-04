// clickity-input: macOS helper that performs agent-mode input (mouse, scroll, keyboard).
//
// clickity spawns it once and keeps it running. Protocol: one JSON object per line on stdin,
// exactly one JSON line back on stdout per command:
//   {"cmd":"status","prompt":false}                    → {"ok":true} / {"ok":false,"error":"needs accessibility"}
//   {"cmd":"move","x":100,"y":200}
//   {"cmd":"click","x":100,"y":200,"button":"left","count":1}   button left|right, count 1|2
//   {"cmd":"scroll","x":100,"y":200,"dy":3,"dx":0}     lines; +dy = down, +dx = right
//   {"cmd":"type","text":"hello"}
//   {"cmd":"key","code":1,"mods":["cmd"]}              kVK_* code (-1 = modifiers only); mods ctrl|alt|shift|cmd|fn
// Coordinates are global display points (top-left origin of the main display) = Electron DIP.
// Every event is posted to the HID event tap, which needs the Accessibility permission
// (granted to Clickity.app, the responsible process). Exits when stdin closes.
//
// Build: npm run build:input (or scripts/build-input.sh). Swift 5.9+, macOS 12+.
import ApplicationServices
import CoreGraphics
import Foundation

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ line: String) {
    if fputs(line + "\n", stdout) == EOF || fflush(stdout) != 0 {
        exit(0) // parent closed the pipe
    }
}

func jsonString(_ s: String) -> String {
    if let data = try? JSONSerialization.data(withJSONObject: [s], options: []),
       let arr = String(data: data, encoding: .utf8) {
        return String(arr.dropFirst().dropLast()) // strip [ ]
    }
    return "\"error\""
}

struct InputError: Error { let message: String }

let source = CGEventSource(stateID: .hidSystemState)

func pause(_ ms: Double) { usleep(useconds_t(ms * 1000)) }

func post(_ e: CGEvent?) throws {
    guard let e = e else { throw InputError(message: "could not create input event") }
    e.post(tap: .cghidEventTap)
}

func num(_ v: Any?) -> Double? {
    if let n = v as? NSNumber { return n.doubleValue }
    return nil
}

func point(_ obj: [String: Any]) throws -> CGPoint {
    guard let x = num(obj["x"]), let y = num(obj["y"]), x.isFinite, y.isFinite else {
        throw InputError(message: "missing coordinates")
    }
    return CGPoint(x: x, y: y)
}

func moveTo(_ p: CGPoint) throws {
    try post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
}

func click(_ p: CGPoint, right: Bool, count: Int) throws {
    try moveTo(p)
    pause(30)
    let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
    let button: CGMouseButton = right ? .right : .left
    for n in 1...max(1, min(count, 3)) {
        let d = CGEvent(mouseEventSource: source, mouseType: down, mouseCursorPosition: p, mouseButton: button)
        let u = CGEvent(mouseEventSource: source, mouseType: up, mouseCursorPosition: p, mouseButton: button)
        d?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        u?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
        try post(d)
        pause(15)
        try post(u)
        if n < count { pause(60) }
    }
}

func scroll(_ p: CGPoint, dy: Int32, dx: Int32) throws {
    try moveTo(p)
    pause(30)
    // wheel1 = vertical (+ = up), wheel2 = horizontal (+ = left). Ours: +dy = down, +dx = right.
    // One event per line so apps that ignore large deltas still scroll the right amount.
    let steps = max(abs(dy), abs(dx))
    for i in 0..<steps {
        let vy: Int32 = i < abs(dy) ? (dy > 0 ? -1 : 1) : 0
        let vx: Int32 = i < abs(dx) ? (dx > 0 ? -1 : 1) : 0
        try post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: vy, wheel2: vx, wheel3: 0))
        pause(12)
    }
}

let kReturn: CGKeyCode = 36
let kTab: CGKeyCode = 48

func tapKey(_ code: CGKeyCode, flags: CGEventFlags = []) throws {
    let d = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
    let u = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    d?.flags = flags
    u?.flags = flags
    try post(d)
    pause(8)
    try post(u)
}

/// Unicode text in chunks of ≤ 20 UTF-16 units (the CGEvent limit); newlines/tabs as real keys.
func typeText(_ text: String) throws {
    var chunk: [UniChar] = []
    func flush() throws {
        guard !chunk.isEmpty else { return }
        let d = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
        let u = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        d?.flags = []
        u?.flags = []
        chunk.withUnsafeBufferPointer { buf in
            d?.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress)
            u?.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress)
        }
        try post(d)
        pause(4)
        try post(u)
        pause(12)
        chunk.removeAll()
    }
    for ch in text {
        if ch == "\n" || ch == "\r\n" || ch == "\r" {
            try flush()
            try tapKey(kReturn)
            pause(12)
            continue
        }
        if ch == "\t" {
            try flush()
            try tapKey(kTab)
            pause(12)
            continue
        }
        let units = Array(String(ch).utf16)
        if chunk.count + units.count > 20 { try flush() }
        chunk.append(contentsOf: units)
    }
    try flush()
}

let modKeys: [(name: String, code: CGKeyCode, flag: CGEventFlags)] = [
    ("ctrl", 59, .maskControl),
    ("alt", 58, .maskAlternate),
    ("shift", 56, .maskShift),
    ("cmd", 55, .maskCommand),
    ("fn", 63, .maskSecondaryFn),
]

func keyChord(code: Int, mods: [String]) throws {
    let active = modKeys.filter { mods.contains($0.name) }
    if mods.contains(where: { m in !modKeys.contains(where: { $0.name == m }) }) {
        throw InputError(message: "unknown modifier")
    }
    var flags: CGEventFlags = []
    // press modifiers (real key events, so apps that track modifier state see them)
    for m in active {
        flags.insert(m.flag)
        let e = CGEvent(keyboardEventSource: source, virtualKey: m.code, keyDown: true)
        e?.type = .flagsChanged
        e?.flags = flags
        try post(e)
        pause(8)
    }
    var failure: Error? = nil
    if code >= 0 {
        do { try tapKey(CGKeyCode(code), flags: flags) } catch { failure = error }
        pause(8)
    }
    // always release modifiers, even after a failure, so nothing stays stuck down
    for m in active.reversed() {
        flags.remove(m.flag)
        let e = CGEvent(keyboardEventSource: source, virtualKey: m.code, keyDown: false)
        e?.type = .flagsChanged
        e?.flags = flags
        try? post(e)
        pause(8)
    }
    if let f = failure { throw f }
}

func trusted(prompt: Bool) -> Bool {
    if prompt {
        // "AXTrustedCheckOptionPrompt" = kAXTrustedCheckOptionPrompt (its Swift import type varies by SDK)
        return AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }
    return AXIsProcessTrusted()
}

func handle(_ obj: [String: Any]) throws {
    let cmd = obj["cmd"] as? String ?? ""
    if cmd == "status" {
        if !trusted(prompt: (obj["prompt"] as? Bool) ?? false) { throw InputError(message: "needs accessibility") }
        return
    }
    if !AXIsProcessTrusted() { throw InputError(message: "needs accessibility") }
    switch cmd {
    case "move":
        try moveTo(try point(obj))
    case "click":
        let right = (obj["button"] as? String) == "right"
        let count = Int(num(obj["count"]) ?? 1)
        try click(try point(obj), right: right, count: count)
    case "scroll":
        let dy = Int32(max(-50, min(50, (num(obj["dy"]) ?? 0).rounded())))
        let dx = Int32(max(-50, min(50, (num(obj["dx"]) ?? 0).rounded())))
        try scroll(try point(obj), dy: dy, dx: dx)
    case "type":
        guard let text = obj["text"] as? String else { throw InputError(message: "missing text") }
        try typeText(text)
    case "key":
        let code = Int(num(obj["code"]) ?? -1)
        let mods = obj["mods"] as? [String] ?? []
        if code < 0 && mods.isEmpty { throw InputError(message: "empty key chord") }
        if code > 0x7f { throw InputError(message: "bad key code") }
        try keyChord(code: code, mods: mods)
    default:
        throw InputError(message: "unknown command")
    }
}

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { continue }
    guard let data = trimmed.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] else {
        emit("{\"ok\":false,\"error\":\"bad command\"}")
        continue
    }
    do {
        try handle(obj)
        emit("{\"ok\":true}")
    } catch let e as InputError {
        emit("{\"ok\":false,\"error\":\(jsonString(e.message))}")
    } catch {
        emit("{\"ok\":false,\"error\":\(jsonString(String(describing: error)))}")
    }
}
exit(0)
