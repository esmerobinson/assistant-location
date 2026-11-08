import XCTest

// Subway Live Activity on a simulator: the app (GLSubwayUITestHook, JournalControl/SubwayShared.swift) starts the
// activity from a real saved server response, then the server's real APNs payload is delivered and the activity must
// end up showing the payload's times. scripts/subway_sim_driver.sh runs beside this test on the host: it takes the
// screenshots (xcrun simctl io) when this test writes a stage-<name> file, and delivers the payload.
//
// A pass means: ActivityKit accepted the request, the state shown after the push is the one decoded from the server
// payload, and no DECODE-FAIL was logged. It does NOT cover the widget's "Track" button (the intent needs location and
// a push token, which the simulator never issues) or real APNs delivery.
final class SubwayLiveActivityUITest: XCTestCase {
    private let inDir = "/tmp/subway-in"
    private let outDir = "/tmp/subway-out"

    private func read(_ path: String) -> String { (try? String(contentsOfFile: path, encoding: .utf8)) ?? "" }

    private func wait(for path: String, timeout: TimeInterval) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if FileManager.default.fileExists(atPath: path) { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return false
    }

    /// Tells the host driver to screenshot now, and waits for its acknowledgement.
    private func stage(_ name: String) {
        FileManager.default.createFile(atPath: "\(outDir)/stage-\(name)", contents: Data())
        XCTAssertTrue(wait(for: "\(outDir)/ack-\(name)", timeout: 30), "driver never acknowledged stage \(name)")
        let shot = XCUIScreen.main.screenshot()
        let att = XCTAttachment(screenshot: shot)
        att.name = name
        att.lifetime = .keepAlways
        add(att)
    }

    func testServerPayloadUpdatesLiveActivity() throws {
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: "\(inDir)/apns_update.json"))) as! [String: Any]
        let rows = ((raw["aps"] as! [String: Any])["content-state"] as! [String: Any])["rows"] as! [[String: Any]]
        let expected = "rows=" + rows.map { "\($0["line"] as! String):\($0["mins"] as! Int)" }.joined(separator: ",")

        // The Live Activities / location prompts must not cover the screenshots.
        addUIInterruptionMonitor(withDescription: "System alerts") { alert in
            for label in ["Allow", "Allow While Using App", "OK", "Always Allow"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }

        let app = XCUIApplication()
        app.launchEnvironment["UITEST_SUBWAY_STATE"] = "\(inDir)/nearby_start.json"
        app.launchEnvironment["UITEST_SUBWAY_OUT"] = outDir
        app.launchEnvironment["UITEST_SUBWAY_PAYLOAD"] = "\(inDir)/payload.json"
        app.launch()

        let log = "\(outDir)/activity.log"
        let startEnd = Date().addingTimeInterval(40)
        while Date() < startEnd, !read(log).contains("started") { Thread.sleep(forTimeInterval: 0.5) }
        XCTAssertTrue(read(log).contains("started"), "activity never started; activity.log:\n\(read(log))")

        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 3)
        stage("island")

        _ = XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        Thread.sleep(forTimeInterval: 3)
        stage("lock_before")

        FileManager.default.createFile(atPath: "\(outDir)/stage-push", contents: Data())
        XCTAssertTrue(wait(for: "\(outDir)/push.done", timeout: 90), "driver never finished the push; driver.log:\n\(read("\(outDir)/driver.log"))")
        Thread.sleep(forTimeInterval: 3)
        stage("lock_after")

        XCTAssertFalse(read(log).contains("DECODE-FAIL"), "server payload failed to decode:\n\(read(log))")
        XCTAssertTrue(read(log).contains("update \(expected)"),
                      "activity never showed the pushed state (\(expected)); activity.log:\n\(read(log))\ndriver.log:\n\(read("\(outDir)/driver.log"))")
    }
}
