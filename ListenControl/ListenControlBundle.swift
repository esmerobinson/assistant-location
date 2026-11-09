// Lock-screen / Control Center Control that opens Listen straight into
// practice. The intent (PracticeIntent.swift) is compiled into this
// extension AND the Listen app; see that file for the delivery design.

import AppIntents
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

@main
struct ListenControlBundle: WidgetBundle {
    var body: some Widget {
        ListenPracticeControl()
    }
}
