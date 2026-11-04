// fnwatch: tiny macOS helper that reports the fn (globe) key.
//
// uiohook-napi never reports fn on macOS (kVK_Function maps to VC_UNDEFINED), so
// clickity spawns this helper and reads one JSON line per change from stdout:
//   {"ready":true}            event tap is live
//   {"fn":true} / {"fn":false} fn went down / up
//   {"error":"no-permission"} the tap could not be created (exit code 2)
// The tap is listen-only: it never changes or blocks events. The helper exits when
// its stdin closes, so it dies with the parent app.
//
// Build: npm run build:fnwatch (or scripts/build-fnwatch.sh). Swift 5.9+, macOS 12+.
import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ line: String) {
    // C stdio + explicit flush: every line reaches the pipe immediately. (FileHandle.write
    // raises an uncatchable ObjC exception on EPIPE; fputs just returns EOF.)
    if fputs(line + "\n", stdout) == EOF || fflush(stdout) != 0 {
        exit(0) // parent closed the pipe: nobody is listening any more
    }
}

/// kVK_Function, and the globe key some newer keyboards report instead.
let fnKeycodes: Set<Int64> = [63, 179]

var fnDown = false
var eventTap: CFMachPort?

let callback: CGEventTapCallBack = { _, type, event, _ in
    // macOS disables slow or interrupted taps; turn it straight back on.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = eventTap { CGEvent.tapEnable(tap: tap, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    guard type == .flagsChanged else { return Unmanaged.passUnretained(event) }

    let keycode = event.getIntegerValueField(.keyboardEventKeycode)
    let flagSet = event.flags.contains(.maskSecondaryFn)
    if fnKeycodes.contains(keycode) {
        if flagSet != fnDown {
            fnDown = flagSet
            emit(flagSet ? "{\"fn\":true}" : "{\"fn\":false}")
        }
    } else if fnDown && !flagSet {
        // Another modifier changed and fn is no longer in the flags: we missed the release.
        // (Arrow / f-row keys also set the fn flag, so a set flag alone never means "down".)
        fnDown = false
        emit("{\"fn\":false}")
    }
    return Unmanaged.passUnretained(event)
}

// Parent died or closed the pipe → quit.
DispatchQueue.global(qos: .utility).async {
    while readLine(strippingNewline: true) != nil {}
    exit(0)
}
signal(SIGPIPE, SIG_IGN)

let mask = CGEventMask(1) << CGEventMask(CGEventType.flagsChanged.rawValue)
guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: mask,
    callback: callback,
    userInfo: nil
) else {
    // Ask once for Input Monitoring so clickity shows up in the list (no-op after the first time).
    if CommandLine.arguments.contains("--prompt") { _ = CGRequestListenEventAccess() }
    emit("{\"error\":\"no-permission\"}")
    exit(2)
}
eventTap = tap

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
emit("{\"ready\":true}")
CFRunLoopRun()
