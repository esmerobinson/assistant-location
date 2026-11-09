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

/// Colour tokens from the design mockup (light + dark), picked explicitly from the colour scheme so renders are deterministic.
struct SubwayPalette {
    let dark: Bool
    var bg: Color { dark ? Color(red: 0.11, green: 0.11, blue: 0.118) : .white }
    var fg: Color { dark ? .white : .black }
    var mut: Color { dark ? Color(red: 0.596, green: 0.596, blue: 0.624) : Color(red: 0.431, green: 0.431, blue: 0.451) }
    var chip: Color { dark ? Color(red: 0.92, green: 0.92, blue: 0.96).opacity(0.14) : Color(red: 0.235, green: 0.235, blue: 0.263).opacity(0.10) }
    func color(_ u: SubwayUrgency) -> Color {
        switch u {
        case .now: return dark ? Color(red: 1, green: 0.271, blue: 0.227) : Color(red: 1, green: 0.231, blue: 0.188)
        case .soon: return dark ? Color(red: 1, green: 0.624, blue: 0.039) : Color(red: 0.902, green: 0.525, blue: 0)
        case .ok: return dark ? Color(red: 0.188, green: 0.82, blue: 0.345) : Color(red: 0.122, green: 0.659, blue: 0.29)
        }
    }
    /// Ring track tint.
    func tint(_ u: SubwayUrgency) -> Color {
        switch u {
        case .now: return dark ? Color(red: 1, green: 0.271, blue: 0.227).opacity(0.22) : Color(red: 1, green: 0.231, blue: 0.188).opacity(0.14)
        case .soon: return dark ? Color(red: 1, green: 0.624, blue: 0.039).opacity(0.22) : Color(red: 1, green: 0.584, blue: 0).opacity(0.18)
        case .ok: return dark ? Color(red: 0.188, green: 0.82, blue: 0.345).opacity(0.20) : Color(red: 0.204, green: 0.78, blue: 0.349).opacity(0.17)
        }
    }
    /// Background of the most urgent row.
    func rowHighlight(_ u: SubwayUrgency) -> Color { color(u).opacity(dark ? 0.10 : 0.07) }
}

private struct Bullet: View {
    let line: String
    var size: CGFloat = 24
    var body: some View {
        Text(line)
            .font(.system(size: size * 0.55, weight: .bold))
            .foregroundStyle(["N", "Q", "R", "W"].contains(line) ? Color.black : Color.white)
            .frame(width: size, height: size)
            .background(bulletColor(line), in: Circle())
    }
}

enum SubwayDensity {
    case small, medium, live

    var rowHeight: CGFloat { self == .small ? 36 : self == .medium ? 38 : 34 }
    var rowGap: CGFloat { self == .live ? 4 : 0 }
    var maxRows: Int { 3 }
    var bullet: CGFloat { self == .small ? 20 : 24 }
    var ring: CGFloat { self == .small ? 27 : self == .medium ? 34 : 30 }
    var ringLine: CGFloat { self == .small ? 3 : 3.5 }
    var ringFont: CGFloat { self == .small ? 11 : self == .medium ? 14 : 13 }
    var destFont: CGFloat { self == .small ? 12 : 13 }
    var subFont: CGFloat { self == .small ? 10 : 12 }
    var subGap: CGFloat { self == .small ? 3 : 8 }
    var hPad: CGFloat { self == .live ? 16 : 14 }
    var vPad: CGFloat { self == .live ? 12 : 14 }
    var titleFont: CGFloat { self == .small ? 14 : 15 }
    var rowSpacing: CGFloat { self == .small ? 7 : 9 }
}

private struct Glyph: View {
    let name: String
    let size: CGFloat
    var body: some View {
        Image(systemName: name).font(.system(size: size, weight: .semibold)).fixedSize()
    }
}

/// Ring: the number is minutes until the train; the arc is the share of the walk time still available.
private struct Ring: View {
    let timing: SubwayTiming
    let density: SubwayDensity
    let palette: SubwayPalette
    var body: some View {
        let u = timing.urgency
        ZStack {
            Circle().stroke(palette.tint(u), lineWidth: density.ringLine)
            Circle().trim(from: 0, to: timing.fraction)
                .stroke(palette.color(u), style: StrokeStyle(lineWidth: density.ringLine, lineCap: .butt))
                .rotationEffect(.degrees(-90))
            Text("\(timing.minsToTrain)")
                .font(.system(size: density.ringFont, weight: .bold)).monospacedDigit()
                .foregroundStyle(palette.color(u))
        }
        .frame(width: density.ring - density.ringLine, height: density.ring - density.ringLine)
        .frame(width: density.ring, height: density.ring)
    }
}

private struct TrainRow: View {
    let row: SubwayState.Row
    let walkSec: Double
    let now: Double
    let density: SubwayDensity
    let palette: SubwayPalette
    let highlighted: Bool

    var body: some View {
        let t = row.timing(walkSec: walkSec, now: now)
        let u = t.urgency
        let dest = density == .small ? subwayShortDest(row.dest) : row.dest
        HStack(spacing: density.rowSpacing) {
            Bullet(line: row.line, size: density.bullet)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text("\u{2192}").foregroundStyle(palette.mut).fontWeight(.medium)
                    Text(dest).foregroundStyle(palette.fg).fontWeight(.semibold).lineLimit(1)
                }
                .font(.system(size: density.destFont))
                HStack(spacing: density.subGap) {
                    HStack(spacing: 3) {
                        Glyph(name: "tram.fill", size: density.subFont - 1).foregroundStyle(palette.mut)
                        Text(row.clock()).fontWeight(.semibold).foregroundStyle(palette.fg)
                    }
                    HStack(spacing: 3) {
                        Glyph(name: "figure.walk", size: density.subFont).foregroundStyle(palette.mut)
                        Text(row.leaveLabel(walkSec: walkSec, now: now)).fontWeight(.semibold).foregroundStyle(palette.color(u))
                    }
                }
                .font(.system(size: density.subFont)).monospacedDigit().lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Ring(timing: t, density: density, palette: palette)
        }
        .padding(.horizontal, highlighted ? 6 : 0)
        .frame(height: density.rowHeight)
        .background(RoundedRectangle(cornerRadius: 10).fill(highlighted ? palette.rowHighlight(u) : .clear))
        .padding(.horizontal, highlighted ? -6 : 0)
    }
}

/// The redesigned board (header + 3 rows), shared by the home-screen widget and the Live Activity.
struct SubwayBoard: View {
    let state: SubwayState
    let now: Double
    let density: SubwayDensity
    var trackButton = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let palette = SubwayPalette(dark: scheme == .dark)
        let rows = Array(state.catchable(now: now).prefix(density.maxRows))
        VStack(alignment: .leading, spacing: density.rowGap) {
            HStack(spacing: 6) {
                Text(state.station).font(.system(size: density.titleFont, weight: .bold)).lineLimit(1)
                    .minimumScaleFactor(0.8).foregroundStyle(palette.fg)
                Spacer(minLength: 2)
                HStack(spacing: 4) {
                    Glyph(name: "figure.walk", size: 11)
                    Text("\(state.walkMin) min").lineLimit(1).fixedSize()
                }
                .font(.system(size: 12, weight: .semibold)).foregroundStyle(palette.mut)
                if trackButton {
                    if #available(iOS 26.0, *) {
                        Button(intent: StartSubwayActivityIntent()) {
                            Glyph(name: "tram.fill", size: 11)
                                .foregroundStyle(palette.mut)
                                .frame(width: 22, height: 22)
                                .background(palette.chip, in: Circle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .frame(height: 22)
            .padding(.bottom, 4)
            ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                TrainRow(row: row, walkSec: state.walkSec, now: now, density: density, palette: palette, highlighted: i == 0)
            }
            Spacer(minLength: 0)
        }
    }
}

/// Background colour for the real widget/Live Activity surfaces (matches the mockup's white / #1c1c1e).
let subwaySurface = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 0.11, green: 0.11, blue: 0.118, alpha: 1) : .white })

// MARK: Live Activity

struct SubwayLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SubwayAttributes.self) { context in
            SubwayBoard(state: context.state, now: Date().timeIntervalSince1970, density: .live)
                .padding(.horizontal, SubwayDensity.live.hPad)
                .padding(.vertical, SubwayDensity.live.vPad)
                .activityBackgroundTint(subwaySurface)
        } dynamicIsland: { context in
            let now = Date().timeIntervalSince1970
            let top = context.state.catchable(now: now).first
            return DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    SubwayBoard(state: context.state, now: now, density: .live)
                }
            } compactLeading: {
                if let row = top { Bullet(line: row.line, size: 20) }
            } compactTrailing: {
                if let row = top { Text("\(row.timing(walkSec: context.state.walkSec, now: now).minsToTrain)").monospacedDigit() }
            } minimal: {
                if let row = top { Bullet(line: row.line, size: 20) }
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
        let now = Date.now
        return SubwayEntry(date: now, state: SubwayState(station: "Station", walkMin: 3, walkSec: 180, rows: [
            .init(line: "A", dest: "Uptown", mins: 6, verdict: "3 min spare", sched: false, arrive: now.timeIntervalSince1970 + 380),
        ], ts: now.timeIntervalSince1970), error: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (SubwayEntry) -> Void) {
        completion(placeholder(in: context))
    }

    // Refetches every 2 min (the system throttles widget reloads anyway); the Live Activity is the real-time surface.
    func getTimeline(in context: Context, completion: @escaping (Timeline<SubwayEntry>) -> Void) {
        Task { @MainActor in
            let entries: [SubwayEntry]
            let start = Date.now
            do {
                let loc = try await OneShotLocation.current()
                let state = try await SubwayAPI.nearby(loc)
                // One entry a minute from the same response: minutes, leave-by and rings stay right until the refetch.
                entries = (0..<2).map { SubwayEntry(date: start.addingTimeInterval(Double($0) * 60), state: state, error: nil) }
            } catch {
                entries = [SubwayEntry(date: start, state: nil, error: "\(error)")]
            }
            completion(Timeline(entries: entries, policy: .after(start.addingTimeInterval(120))))
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
        Group {
            if let state = entry.state {
                SubwayBoard(state: state, now: entry.date.timeIntervalSince1970,
                            density: family == .systemSmall ? .small : .medium, trackButton: true)
            } else {
                Text(entry.error ?? "").font(.caption2)
            }
        }
        .padding(14)
        .containerBackground(subwaySurface, for: .widget)
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
        .contentMarginsDisabled()
    }
}
