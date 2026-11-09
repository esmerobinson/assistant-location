// Lock-screen / Control Center Control that opens Listen straight into
// practice. The intent (PracticeIntent.swift) is compiled into this
// extension AND the Listen app; see that file for the delivery design.

import AppIntents
import Foundation
import SwiftUI
import WidgetKit

struct ListenPracticeControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        listenDebugLog("control body")
        return StaticControlConfiguration(kind: "com.oliverullman.listen.practicecontrol") {
            ControlWidgetButton(action: ListenPracticeIntent()) {
                Label("Practice", systemImage: "rectangle.stack.fill")
            }
        }
        .displayName("Listen Practice")
    }
}

@main
struct ListenControlBundle: WidgetBundle {
    init() { listenDebugLog("bundle init") }

    var body: some Widget {
        ListenPracticeControl()
    }
}

// TEMPORARY: reports when iOS launches this extension and asks it for its
// control, to find out why "Listen Practice" never appeared in the control
// gallery. No log line at all = iOS never launches the extension (registration
// problem); "bundle init" with no "control body" = it launches but the control
// isn't read. Lines show in `journalctl --user -u assistant-location` as
// "[JOURNAL DEBUG] listen-control ...". The host is a placeholder that
// ota-listen.yml seds to DROP_HOST (the repo is public). Delete this, the sed
// and the ATS key in Info.plist once the gallery problem is solved.
private let listenDebugHost = "NO_HOST_BAKED_IN"

func listenDebugLog(_ message: String) {
    // Compares the suffix, not the full sentinel: the CI post-bake grep would
    // otherwise match the sentinel in this line.
    guard !listenDebugHost.hasSuffix("BAKED_IN") else { return }
    var comps = URLComponents()
    comps.scheme = "http"
    comps.host = listenDebugHost
    comps.port = 8302
    comps.path = "/debug-log"
    let info = ProcessInfo.processInfo
    comps.queryItems = [URLQueryItem(name: "msg", value: "listen-control \(message) [proc=\(info.processName) os=\(info.operatingSystemVersionString)]")]
    var req = URLRequest(url: comps.url!)
    req.timeoutInterval = 3
    URLSession.shared.dataTask(with: req).resume()
}
