// Subway times, the half compiled into BOTH the Superapp and the JournalControl widget extension: the state shape the
// server (location-server/lib/subway.mjs) sends, the HTTP client, one-shot location, and the intent behind the
// widget's button.
//
// Why both targets: a LiveActivityStartingIntent's perform() runs in the APP process (that is what lets it start a
// Live Activity without opening the app), but Button(intent:) in the widget needs the type visible to the extension.
//
// The two `private let` lines below are rewritten by ota.yml's bake step (sed on the exact text; the placeholders must
// not appear anywhere else in this file, or the post-bake guard fails). Host and token never live in git.

import ActivityKit
import AppIntents
import CoreLocation
import Foundation

private let subwayHost = "NO_HOST_BAKED_IN"
private let subwayToken = "NO_TOKEN_BAKED_IN"

/// Mirrors buildState() in lib/subway.mjs; also the Live Activity's ContentState, so the server's APNs
/// `content-state` JSON must keep these exact keys.
struct SubwayState: Codable, Hashable {
    struct Row: Codable, Hashable {
        var line: String      // bullet letter/number, e.g. "A", "6"
        var dest: String      // terminal station
        var mins: Int         // whole minutes to arrival
        var verdict: String   // "N min spare" | "run" | "miss", vs the walk to the station
        var sched: Bool       // no vehicle position yet: schedule guess, shown as "~N"
    }
    var station: String
    var walkMin: Int
    var rows: [Row]
    var ts: Double
}

struct SubwayAttributes: ActivityAttributes {
    typealias ContentState = SubwayState
}

struct SubwayError: Error, CustomStringConvertible {
    let description: String
}

enum SubwayAPI {
    private static func request(_ path: String, query: [URLQueryItem] = [], method: String = "GET", body: Data? = nil) -> URLRequest {
        var comps = URLComponents()
        comps.scheme = "http"
        comps.host = subwayHost
        comps.port = 8302
        comps.path = path
        comps.queryItems = query.isEmpty ? nil : query
        var req = URLRequest(url: comps.url!)
        req.httpMethod = method
        req.httpBody = body
        req.timeoutInterval = 10
        req.setValue("Bearer \(subwayToken)", forHTTPHeaderField: "Authorization")
        return req
    }

    private static func send(_ req: URLRequest) async throws -> Data {
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as! HTTPURLResponse).statusCode
        guard status == 200 else {
            throw SubwayError(description: "\(req.url!.path) HTTP \(status): \(String(decoding: data.prefix(200), as: UTF8.self))")
        }
        return data
    }

    static func nearby(_ loc: CLLocation) async throws -> SubwayState {
        let data = try await send(request("/subway/nearby", query: [
            URLQueryItem(name: "lat", value: String(loc.coordinate.latitude)),
            URLQueryItem(name: "lon", value: String(loc.coordinate.longitude)),
        ]))
        return try JSONDecoder().decode(SubwayState.self, from: data)
    }

    /// Tells the server this Live Activity's push token and where he is, which starts the 20s push loop.
    static func register(pushToken: Data, _ loc: CLLocation) async throws {
        let body = try JSONSerialization.data(withJSONObject: [
            "token": pushToken.map { String(format: "%02x", $0) }.joined(),
            "lat": loc.coordinate.latitude,
            "lon": loc.coordinate.longitude,
        ])
        _ = try await send(request("/subway/activity", method: "POST", body: body))
    }
}

/// One location fix via requestLocation(). Works in the app and, with NSWidgetWantsLocation in its Info.plist, in the
/// widget extension (which borrows the app's authorization). Must be created on the main actor: CLLocationManager
/// delivers delegate callbacks on the run loop of the thread that created it.
@MainActor
final class OneShotLocation: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation, Error>?

    static func current() async throws -> CLLocation {
        try await OneShotLocation().fetch()
    }

    private func fetch() async throws -> CLLocation {
        try await withCheckedThrowingContinuation { cont in
            continuation = cont
            manager.delegate = self
            manager.requestLocation()
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        Task { @MainActor in
            self.continuation?.resume(returning: locations.last!)
            self.continuation = nil
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            self.continuation?.resume(throwing: error)
            self.continuation = nil
        }
    }
}

/// Ends any running subway activity and requests a fresh one, so a second tap never stacks two on the lock screen.
/// Shared by the widget button's intent and the UI-test hook below.
@available(iOS 17.0, *)
enum SubwayActivity {
    static func start(state: SubwayState, pushType: PushType? = .token) async throws -> Activity<SubwayAttributes> {
        for old in Activity<SubwayAttributes>.activities {
            await old.end(nil, dismissalPolicy: .immediate)
        }
        return try Activity.request(
            attributes: SubwayAttributes(),
            content: .init(state: state, staleDate: nil),
            pushType: pushType
        )
    }
}

/// The widget button: starts the Live Activity without opening the app.
@available(iOS 26.0, *)
struct StartSubwayActivityIntent: LiveActivityStartingIntent {
    static let title: LocalizedStringResource = "Track subway times"

    func perform() async throws -> some IntentResult {
        let loc = try await OneShotLocation.current()
        let state = try await SubwayAPI.nearby(loc)
        let activity = try await SubwayActivity.start(state: state)
        // The first token arrives within a second or two; the server needs it before it can push anything.
        for await token in activity.pushTokenUpdates {
            try await SubwayAPI.register(pushToken: token, loc)
            break
        }
        return .result()
    }
}

/// CI hook (UITests/SubwayLiveActivityUITest.swift): starts the Live Activity from a saved server response instead of
/// location + HTTP, logs every state the activity ends up in to UITEST_SUBWAY_OUT/activity.log, and also applies a
/// saved APNs payload dropped at UITEST_SUBWAY_PAYLOAD, decoding `aps.content-state` strictly into SubwayState (the
/// same decode ActivityKit does), so a server/Swift key mismatch shows up as DECODE-FAIL.
@objc public final class GLSubwayUITestHook: NSObject {
    private static var started = false

    private struct Envelope: Decodable {
        struct APS: Decodable {
            let state: SubwayState
            enum CodingKeys: String, CodingKey { case state = "content-state" }
        }
        let aps: APS
    }

    @objc public static func startIfRequested() {
        let env = ProcessInfo.processInfo.environment
        guard !started, let statePath = env["UITEST_SUBWAY_STATE"], let out = env["UITEST_SUBWAY_OUT"],
              let payloadPath = env["UITEST_SUBWAY_PAYLOAD"] else { return }
        started = true
        guard #available(iOS 17.0, *) else { return }
        Task { @MainActor in
            do {
                try await run(statePath: statePath, out: out, payloadPath: payloadPath)
            } catch {
                log(out, "ERROR \(error)")
            }
        }
    }

    private static func log(_ out: String, _ line: String) {
        let url = URL(fileURLWithPath: out).appendingPathComponent("activity.log")
        let data = Data((line + "\n").utf8)
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile()
            h.write(data)
            h.closeFile()
        } else {
            try? data.write(to: url)
        }
    }

    private static func summary(_ s: SubwayState) -> String {
        "rows=" + s.rows.map { "\($0.line):\($0.mins)" }.joined(separator: ",")
    }

    @available(iOS 17.0, *)
    @MainActor
    private static func run(statePath: String, out: String, payloadPath: String) async throws {
        let state = try JSONDecoder().decode(SubwayState.self, from: Data(contentsOf: URL(fileURLWithPath: statePath)))
        log(out, "enabled=\(ActivityAuthorizationInfo().areActivitiesEnabled)")
        // No push type: `.token` needs the aps-environment entitlement, which the unsigned simulator build lacks.
        let activity = try await SubwayActivity.start(state: state, pushType: nil)
        log(out, "started \(summary(state))")
        Task {
            for await content in activity.contentUpdates { log(out, "update \(summary(content.state))") }
        }
        var applied: Date?
        while true {
            try await Task.sleep(nanoseconds: 1_000_000_000)
            guard let mtime = (try? FileManager.default.attributesOfItem(atPath: payloadPath))?[.modificationDate] as? Date,
                  mtime != applied else { continue }
            applied = mtime
            do {
                let env = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: URL(fileURLWithPath: payloadPath)))
                log(out, "payload-decoded \(summary(env.aps.state))")
                await activity.update(.init(state: env.aps.state, staleDate: nil))
            } catch {
                log(out, "DECODE-FAIL \(error)")
            }
        }
    }
}

extension SubwayState.Row {
    /// Minutes as shown: a schedule guess (no vehicle position yet) gets a "~".
    var minsLabel: String { sched ? "~\(mins)" : "\(mins)" }
}

extension SubwayState {
    /// Soonest train per line+destination (the server sends the next two of each), so one busy line cannot crowd
    /// the others out of a small UI.
    var topPerLine: [Row] {
        var seen = Set<String>()
        return rows.filter { seen.insert($0.line + $0.dest).inserted }
    }
}
