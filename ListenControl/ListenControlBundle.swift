// Two ways onto Listen's Practice from the lock screen, both in this one
// extension:
// - ListenPracticeControl: an iOS 18 Control (lock-screen corner buttons and
//   Control Center). Runs ListenPracticeIntent (PracticeIntent.swift, compiled
//   into this extension AND the app; see that file for the delivery design).
// - ListenPracticeLockScreenWidget: an accessoryCircular widget for the widget
//   row under the clock. That row's picker lists only widgets, never Controls,
//   so without this Listen is absent from it (the Superapp's +/mic buttons
//   there are widgets too, JournalLockScreenWidget.swift).

import AppIntents
import Foundation
import SwiftUI
import WidgetKit

struct ListenPracticeControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: "com.oliverullman.listen.practicecontrol") {
            ControlWidgetButton(action: ListenPracticeIntent()) {
                Label("Practice", systemImage: "rectangle.stack.fill")
            }
        }
        .displayName("Listen Practice")
    }
}

struct ListenPracticeEntry: TimelineEntry {
    let date: Date
}

// Static content: the widget is a button, so one entry that never refreshes.
struct ListenPracticeProvider: TimelineProvider {
    func placeholder(in context: Context) -> ListenPracticeEntry { ListenPracticeEntry(date: Date()) }
    func getSnapshot(in context: Context, completion: @escaping (ListenPracticeEntry) -> Void) {
        completion(ListenPracticeEntry(date: Date()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ListenPracticeEntry>) -> Void) {
        completion(Timeline(entries: [ListenPracticeEntry(date: Date())], policy: .never))
    }
}

// <app bundle id>://practice, the same URL the Control opens. A widget tap
// goes through the OS deep-link path straight to the app's
// application:openURL:options: (ListenAppDelegate.m), cold launch included.
// The scheme is derived from this extension's id so the guest copy
// (com.oliverullman.listenguest.practice) opens the guest app, never the
// personal one.
private let practiceURL: URL = {
    let id = Bundle.main.bundleIdentifier!
    let app = id.hasSuffix(".practice") ? String(id.dropLast(".practice".count)) : id
    return URL(string: "\(app)://practice")!
}()

struct ListenPracticeLockScreenWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.oliverullman.listen.practicecircle", provider: ListenPracticeProvider()) { _ in
            // AccessoryWidgetBackground gives the filled circle the Superapp's
            // lock-screen buttons have; lock-screen widgets render monochrome.
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "rectangle.stack.fill")
                    .font(.title2)
            }
            .widgetURL(practiceURL)
            .widgetAccentable()
        }
        .configurationDisplayName("Listen Practice")
        .description("Open Listen straight into practice.")
        .supportedFamilies([.accessoryCircular])
    }
}

@main
struct ListenControlBundle: WidgetBundle {
    var body: some Widget {
        ListenPracticeControl()
        ListenPracticeLockScreenWidget()
    }
}
