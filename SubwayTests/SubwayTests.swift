// Subway widget + Live Activity, checked against REAL saved server output (fixtures/): nearby_start.json and
// nearby_update.json are two GET /subway/nearby responses ~95s apart at Times Sq, apns_update.json is what the server's
// liveActivityPayload() (location-server/lib/apns.mjs) builds around the second one. SubwayShared.swift and
// SubwayWidget.swift are compiled straight into this bundle (scripts/add_subway_tests_target.rb).
import ActivityKit
import SwiftUI
import UIKit
import WidgetKit
import XCTest

private let fixtureDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures")
private let outDir = URL(fileURLWithPath: "/tmp/subway-out")

private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: fixtureDir.appendingPathComponent(name))
}

final class SubwayDecodeTests: XCTestCase {
    func testNearbyResponseDecodes() throws {
        let s = try JSONDecoder().decode(SubwayState.self, from: fixture("nearby_start.json"))
        XCTAssertEqual(s.station, "Times Sq-42 St/Port Authority Bus Terminal")
        XCTAssertEqual(s.walkMin, 2)
        XCTAssertEqual(s.rows.count, 21)
        XCTAssertEqual(s.rows[0].verdict, "miss")
        XCTAssertEqual(s.rows[1].verdict, "run")
        XCTAssertTrue(s.rows[2].sched, "row 2 (S) is a schedule guess")
        XCTAssertEqual(s.rows[2].minsLabel, "~1")
        XCTAssertEqual(s.rows[1].minsLabel, "1")
    }

    /// The point of the whole file: the server's APNs `content-state` must decode into the Live Activity's ContentState.
    func testServerApnsPayloadDecodesIntoContentState() throws {
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("apns_update.json")) as? [String: Any])
        let aps = try XCTUnwrap(raw["aps"] as? [String: Any])
        XCTAssertEqual(aps["event"] as? String, "update")
        XCTAssertNotNil(aps["timestamp"] as? Int)
        let contentState = try JSONSerialization.data(withJSONObject: try XCTUnwrap(aps["content-state"]))
        let state = try JSONDecoder().decode(SubwayAttributes.ContentState.self, from: contentState)
        let fromNearby = try JSONDecoder().decode(SubwayState.self, from: fixture("nearby_update.json"))
        XCTAssertEqual(state, fromNearby)
        let start = try JSONDecoder().decode(SubwayState.self, from: fixture("nearby_start.json"))
        XCTAssertNotEqual(state.rows, start.rows, "update fixture must carry different times than the start fixture")
    }

    /// Falsifiers: a renamed or dropped key on either level must break the decode, so the test above can fail.
    func testRenamedOrMissingKeysFailDecode() throws {
        let base = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture("nearby_update.json")) as? [String: Any])
        for key in ["station", "walkMin", "rows", "ts"] {
            var d = base
            d[key + "_renamed"] = d.removeValue(forKey: key)
            XCTAssertThrowsError(try JSONDecoder().decode(SubwayState.self, from: JSONSerialization.data(withJSONObject: d)), "top-level \(key)")
        }
        for key in ["line", "dest", "mins", "verdict", "sched"] {
            var d = base
            var rows = try XCTUnwrap(d["rows"] as? [[String: Any]])
            rows[0][key + "_renamed"] = rows[0].removeValue(forKey: key)
            d["rows"] = rows
            XCTAssertThrowsError(try JSONDecoder().decode(SubwayState.self, from: JSONSerialization.data(withJSONObject: d)), "row \(key)")
        }
    }
}

@MainActor
final class SubwayWidgetRenderTests: XCTestCase {
    private func render(_ family: WidgetFamily, size: CGSize, name: String) throws {
        let state = try JSONDecoder().decode(SubwayState.self, from: fixture("nearby_start.json"))
        let view = SubwayWidgetContent(entry: SubwayEntry(date: .now, state: state, error: nil), family: family)
            .frame(width: size.width, height: size.height)
            .background(Color(UIColor.secondarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 22))
            .padding(8)
            .background(Color(UIColor.systemBackground))
        let renderer = ImageRenderer(content: view)
        renderer.scale = 3
        let image = try XCTUnwrap(renderer.uiImage, "ImageRenderer returned no image for \(name)")
        XCTAssertGreaterThan(image.size.width, size.width)
        let png = try XCTUnwrap(image.pngData())
        try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        try png.write(to: outDir.appendingPathComponent("\(name).png"))
        let att = XCTAttachment(image: image)
        att.name = name
        att.lifetime = .keepAlways
        add(att)
        XCTAssertGreaterThan(distinctColors(image), 40, "\(name) looks blank")
    }

    private func distinctColors(_ image: UIImage) -> Int {
        guard let cg = image.cgImage else { return 0 }
        let w = cg.width, h = cg.height
        var buf = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        var seen = Set<UInt32>()
        for i in stride(from: 0, to: buf.count, by: 4) {
            seen.insert(UInt32(buf[i]) << 16 | UInt32(buf[i + 1]) << 8 | UInt32(buf[i + 2]))
        }
        return seen.count
    }

    func testSmallWidgetRenders() throws {
        try render(.systemSmall, size: CGSize(width: 170, height: 170), name: "widget_small")
    }

    func testMediumWidgetRenders() throws {
        try render(.systemMedium, size: CGSize(width: 364, height: 170), name: "widget_medium")
    }
}
