// Intent behind the Listen "Practice" lock-screen Control. Same delivery shape
// as Overland's JournalControl/JournalIntent.swift (read its header for the
// history): compiled into BOTH the ListenControl extension and the Listen app,
// openAppWhenRun = true, and perform() fires two independent signals that the
// app collapses into one idempotent "open practice" (ListenViewController
// -openPracticeFromShortcut):
//  - an NSNotification, which wins when iOS runs perform() in the app process
//    (warm, or background-pre-launched before the window exists — the view
//    controller also checks the pending flag the post leaves behind);
//  - <app bundle id>://practice, which covers perform() running in the extension and
//    any cold launch (ListenAppDelegate application:openURL:options:).

import AppIntents
import Foundation
import SwiftUI

@available(iOS 18.0, *)
struct ListenPracticeIntent: AppIntent {
    static let title: LocalizedStringResource = "Listen Practice"
    static let description = IntentDescription("Open Listen straight into practice.")
    static let openAppWhenRun: Bool = true

    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "ListenPendingPracticeAt")
        NotificationCenter.default.post(name: Notification.Name("ListenOpenPractice"), object: nil)
        // The app's scheme is its bundle id (ListenApp/Info.plist), so the guest copy never answers this one's press.
        // From the extension, Bundle.main is the extension: drop its ".practice" suffix to get the host app's id.
        let id = Bundle.main.bundleIdentifier!
        let app = id.hasSuffix(".practice") ? String(id.dropLast(".practice".count)) : id
        EnvironmentValues().openURL(URL(string: "\(app)://practice")!)
        return .result()
    }
}
