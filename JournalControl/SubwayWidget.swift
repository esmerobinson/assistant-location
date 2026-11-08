// Home-screen subway widget (nearest station, next trains, button that starts the Live Activity) and the Live
// Activity UI itself (lock screen + Dynamic Island). Extension-only; shared types are in SubwayShared.swift.

import ActivityKit
import AppIntents
import CoreLocation
import SwiftUI
import WidgetKit

// MTA line colours (official palette).
private func bulletColor(_ line: String) -> Color {
    switch line.first {
    case "1", "2", "3": return Color(red: 0.93, green: 0.21, blue: 0.18)
    case "4", "5", "6": return Color(red: 0.0, green: 0.58, blue: 0.24)
    case "7": return Color(red: 0.73, green: 0.2, blue: 0.68)
    case "A", "C", "E": return Color(red: 0.0, green: 0.22, blue: 0.65)
    case "B", "D", "F", "M": return Color(red: 1.0, green: 0.39, blue: 0.1)
    case "G": return Color(red: 0.42, green: 0.75, blue: 0.27)
    case "J", "Z": return Color(red: 0.6, green: 0.4, blue: 0.2)
    case "L": return Color(red: 0.65, green: 0.66, blue: 0.68)
    case "N", "Q", "R", "W": return Color(red: 0.99, green: 0.8, blue: 0.04)
    default: return Color(red: 0.5, green: 0.51, blue: 0.52)
    }
}

private func verdictColor(_ verdict: String) -> Color {
    verdict == "miss" ? .red : verdict == "run" ? .orange : .green
}

private struct Bullet: View {
    let line: String
    var body: some View {
        Text(line)
            .font(.system(size: 13, weight: .bold))
            .foregroundStyle(["N", "Q", "R", "W"].contains(line) ? Color.black : Color.white)
            .frame(width: 22, height: 22)
            .background(bulletColor(line), in: Circle())
    }
}

private struct RowView: View {
    let row: SubwayState.Row
    var showDest = true
    var body: some View {
        HStack(spacing: 6) {
            Bullet(line: row.line)
            if showDest {
                Text(row.dest).font(.caption).lineLimit(1)
            }
            Spacer(minLength: 4)
            Text(row.minsLabel).font(.subheadline.bold()).monospacedDigit()
            Text(row.verdict).font(.caption2).foregroundStyle(verdictColor(row.verdict)).lineLimit(1)
        }
    }
}

// MARK: Live Activity

struct SubwayLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SubwayAttributes.self) { context in
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(context.state.station).font(.headline).lineLimit(1)
                    Spacer()
                    Text("\(context.state.walkMin) min walk").font(.caption).foregroundStyle(.secondary)
                }
                ForEach(Array(context.state.topPerLine.prefix(5).enumerated()), id: \.offset) { _, row in
                    RowView(row: row)
                }
            }
            .padding()
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(context.state.station) · \(context.state.walkMin) min walk").font(.caption).lineLimit(1)
                        ForEach(Array(context.state.topPerLine.prefix(3).enumerated()), id: \.offset) { _, row in
                            RowView(row: row)
                        }
                    }
                }
            } compactLeading: {
                if let row = context.state.topPerLine.first { Bullet(line: row.line) }
            } compactTrailing: {
                if let row = context.state.topPerLine.first { Text(row.minsLabel).monospacedDigit() }
            } minimal: {
                if let row = context.state.topPerLine.first { Bullet(line: row.line) }
            }
        }
    }
}

// MARK: Home-screen widget

struct SubwayEntry: TimelineEntry {
    let date: Date
    let state: SubwayState?
    let error: String?
}

struct SubwayProvider: TimelineProvider {
    func placeholder(in context: Context) -> SubwayEntry {
        SubwayEntry(date: .now, state: SubwayState(station: "Station", walkMin: 3, rows: [
            .init(line: "A", dest: "Uptown", mins: 4, verdict: "1 min spare", sched: false),
        ], ts: 0), error: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (SubwayEntry) -> Void) {
        completion(placeholder(in: context))
    }

    // Refetches every 2 min (the system throttles widget reloads anyway); the Live Activity is the real-time surface.
    func getTimeline(in context: Context, completion: @escaping (Timeline<SubwayEntry>) -> Void) {
        Task { @MainActor in
            let entry: SubwayEntry
            do {
                let loc = try await OneShotLocation.current()
                entry = SubwayEntry(date: .now, state: try await SubwayAPI.nearby(loc), error: nil)
            } catch {
                entry = SubwayEntry(date: .now, state: nil, error: "\(error)")
            }
            completion(Timeline(entries: [entry], policy: .after(Date.now.addingTimeInterval(120))))
        }
    }
}

struct SubwayWidgetView: View {
    let entry: SubwayEntry
    @Environment(\.widgetFamily) private var family

    var body: some View { SubwayWidgetContent(entry: entry, family: family) }
}

/// The widget's layout, with the family passed in so tests can render both sizes (the environment value is read-only).
struct SubwayWidgetContent: View {
    let entry: SubwayEntry
    let family: WidgetFamily

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let state = entry.state {
                HStack {
                    Text(state.station).font(.caption.bold()).lineLimit(1)
                    Spacer()
                    Text("\(state.walkMin) min").font(.caption2).foregroundStyle(.secondary)
                }
                ForEach(Array(state.topPerLine.prefix(family == .systemSmall ? 3 : 4).enumerated()), id: \.offset) { _, row in
                    RowView(row: row, showDest: family != .systemSmall)
                }
            } else {
                Text(entry.error ?? "").font(.caption2)
            }
            Spacer(minLength: 0)
            if #available(iOS 26.0, *) {
                Button(intent: StartSubwayActivityIntent()) {
                    Label("Track", systemImage: "tram.fill").font(.caption.bold())
                }
            }
        }
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

struct SubwayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.oliverullman.assistantlocation.subway", provider: SubwayProvider()) { entry in
            SubwayWidgetView(entry: entry)
        }
        .configurationDisplayName("Subway")
        .description("Nearest station and next trains.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
