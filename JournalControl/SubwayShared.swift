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

/// The widget button: starts the Live Activity without opening the app. Replaces any activity already running so a
/// second tap never stacks two on the lock screen.
@available(iOS 26.0, *)
struct StartSubwayActivityIntent: LiveActivityStartingIntent {
    static let title: LocalizedStringResource = "Track subway times"

    func perform() async throws -> some IntentResult {
        for old in Activity<SubwayAttributes>.activities {
            await old.end(nil, dismissalPolicy: .immediate)
        }
        let loc = try await OneShotLocation.current()
        let state = try await SubwayAPI.nearby(loc)
        let activity = try Activity.request(
            attributes: SubwayAttributes(),
            content: .init(state: state, staleDate: nil),
            pushType: .token
        )
        // The first token arrives within a second or two; the server needs it before it can push anything.
        for await token in activity.pushTokenUpdates {
            try await SubwayAPI.register(pushToken: token, loc)
            break
        }
        return .result()
    }
}
