// Lock-screen / Control Center Controls that launch Assistant Location into
// the Journal tab. See JournalIntent.swift for why these open a URL rather
// than posting a notification from an AppIntent's perform().

import AppIntents
import SwiftUI
import WidgetKit

struct JournalControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(
            kind: "com.oliverullman.assistantlocation.journalcontrol2"
        ) {
            // The "2" kind suffix and the fresh intent type names force iOS
            // to register these Controls from scratch — stale registrations
            // were silently skipping perform() entirely. See
            // JournalIntent.swift's header for the full four-design history.
            // Old Controls on the lock screen die with the rename; they must
            // be removed and re-added once.
            ControlWidgetButton(action: JournalVoiceControlIntent()) {
                Label("Voice Journal", systemImage: "mic.fill")
            }
        }
        .displayName("Voice Journal")
    }
}

struct AddTodoControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(
            kind: "com.oliverullman.assistantlocation.addtodocontrol"
        ) {
            ControlWidgetButton(action: AddTodoControlIntent()) {
                Label("Add Todo", systemImage: "plus.circle.fill")
            }
        }
        .displayName("Add Todo")
    }
}

// EXPERIMENT V2 Controls — same UI, but the intent conforms to
// AudioPlaybackIntent, which forces perform() into the APP process. Shown
// in the gallery as "Voice/Text Journal V2". If V2 works and V1 doesn't,
// the fix is the protocol conformance; V1 then gets deleted.
struct JournalControlV2: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(
            kind: "com.oliverullman.assistantlocation.journalcontrol.v2audio"
        ) {
            ControlWidgetButton(action: JournalVoiceV2Intent()) {
                Label("Voice Journal V2", systemImage: "mic.badge.plus")
            }
        }
        .displayName("Voice Journal V2")
    }
}

// "New session (voice)"/"New session (text)" Controls — see
// SessionIntent.swift's header for why these get their own intent types
// rather than reusing Journal's. No V2/AudioPlaybackIntent experiment pair
// here: that split in Journal's Controls exists to isolate an unresolved
// process-placement bug (see JournalIntent.swift's design history), not
// because every Control needs one — Sessions ships the same
// OpenURLIntent-pattern shape Journal's V1 Controls use, unless the same
// bug turns up here too.
struct SessionVoiceControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(
            kind: "com.oliverullman.assistantlocation.sessionvoicecontrol"
        ) {
            ControlWidgetButton(action: SessionVoiceControlIntent()) {
                Label("New Session (Voice)", systemImage: "mic.fill")
            }
        }
        .displayName("New Session (Voice)")
    }
}

struct SessionTextControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(
            kind: "com.oliverullman.assistantlocation.sessiontextcontrol"
        ) {
            ControlWidgetButton(action: SessionTextControlIntent()) {
                Label("New Session (Text)", systemImage: "terminal")
            }
        }
        .displayName("New Session (Text)")
    }
}

@main
struct JournalControlBundle: WidgetBundle {
    var body: some Widget {
        JournalControl()
        AddTodoControl()
        JournalControlV2()
        SessionVoiceControl()
        SessionTextControl()
        // Lock Screen accessory widgets (accessoryCircular) — a separate
        // WidgetKit surface from the Controls above. See
        // JournalLockScreenWidget.swift.
        JournalVoiceLockScreenWidget()
        AddTodoLockScreenWidget()
        NewSessionLockScreenWidget()
        SubwayWidget()
        SubwayLiveActivity()
    }
}
