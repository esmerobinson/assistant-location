import UIKit
import UserNotifications

/// Local backup alerts: one per upcoming nag, firing `grace` after the nag time. If the server's push for the nag arrives,
/// the Notification Service Extension cancels the matching backup (same identifier), so the phone alerts once.
enum Notifications {
    static let category = "DUE_NAG"
    static let grace: TimeInterval = 120
    static let maxPending = 60 // iOS keeps the 64 soonest
    private static let queue = DispatchQueue(label: "due.schedule")

    /// Removes the delivered and pending notifications of one reminder for one dueAt (the server's silent `dismissReminderId` push).
    static func dismiss(reminderId: String, dueAt: Double, done: @escaping () -> Void) {
        func matches(_ info: [AnyHashable: Any]) -> Bool { info["reminderId"] as? String == reminderId && (info["dueAt"] as? NSNumber)?.doubleValue == dueAt }
        queue.async {
            let center = UNUserNotificationCenter.current()
            let sem = DispatchSemaphore(value: 0)
            var delivered: [UNNotification] = [], pending: [UNNotificationRequest] = []
            center.getDeliveredNotifications { delivered = $0; sem.signal() }
            center.getPendingNotificationRequests { pending = $0; sem.signal() }
            sem.wait(); sem.wait()
            center.removeDeliveredNotifications(withIdentifiers: delivered.filter { matches($0.request.content.userInfo) }.map(\.request.identifier))
            center.removePendingNotificationRequests(withIdentifiers: pending.filter { matches($0.content.userInfo) }.map(\.identifier))
            done()
        }
    }

    /// Alerts delivered before pushes carried dueAt have none: they never match `live`, so they count as stale.
    private static func isStale(_ info: [AnyHashable: Any], live: [String: Double]) -> Bool {
        guard let id = info["reminderId"] as? String else { return false }
        return live[id] != (info["dueAt"] as? NSNumber)?.doubleValue
    }

    /// Clears what the server says is over: delivered alerts of any closed or moved reminder, and pending backups of closed ones.
    /// A pending backup of a reminder the server has not heard about, or at another dueAt, may be an offline edit, so it stays.
    static func sweep(done: @escaping () -> Void) {
        guard let token = Keychain.token else { return done() }
        var req = URLRequest(url: URL(string: Baked.server + "/api/state")!)
        req.timeoutInterval = 15
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        URLSession.shared.dataTask(with: req) { data, resp, err in
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            guard status == 200, let data = data, let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let reminders = state["reminders"] as? [String: [String: Any]] else {
                Registration.report("sweepFailed", "HTTP \(status) \(String(describing: err))")
                return done()
            }
            var live: [String: Double] = [:], closed = Set<String>()
            for (id, r) in reminders {
                if r["completedAt"] is NSNull, r["deletedAt"] is NSNull, let dueAt = (r["dueAt"] as? NSNumber)?.doubleValue { live[id] = dueAt } else { closed.insert(id) }
            }
            queue.async {
                let center = UNUserNotificationCenter.current()
                let sem = DispatchSemaphore(value: 0)
                var delivered: [UNNotification] = [], pending: [UNNotificationRequest] = []
                center.getDeliveredNotifications { delivered = $0; sem.signal() }
                center.getPendingNotificationRequests { pending = $0; sem.signal() }
                sem.wait(); sem.wait()
                let staleDelivered = delivered.filter { isStale($0.request.content.userInfo, live: live) }.map(\.request.identifier)
                let stalePending = pending.filter { closed.contains($0.content.userInfo["reminderId"] as? String ?? "") }.map(\.identifier)
                center.removeDeliveredNotifications(withIdentifiers: staleDelivered)
                center.removePendingNotificationRequests(withIdentifiers: stalePending)
                Registration.report("sweep", "removed \(staleDelivered.count) delivered, \(stalePending.count) pending")
                done()
            }
        }.resume()
    }

    private static let actionsKey = "due.notificationActions"

    /// The notification buttons are the web layer's REMINDER_ACTIONS (due-clone packages/core/src/actions.ts, the one list
    /// shared with the Mac alert and the right-click menu), sent as [{id, title}] by the `notificationActions` bridge call on
    /// every page load. Cached so launch registers them before the page loads; with no cache yet (first launch), alerts have
    /// no buttons until the page sends them, a second later.
    static func registerCategories(_ actions: [[String: String]]? = nil) {
        if let actions = actions { UserDefaults.standard.set(actions, forKey: actionsKey) }
        let cat = UNNotificationCategory(
            identifier: category,
            actions: cachedActions.map { UNNotificationAction(identifier: $0["id"]!, title: $0["title"]!, options: []) },
            intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([cat])
    }

    private static var cachedActions: [[String: String]] { UserDefaults.standard.array(forKey: actionsKey) as? [[String: String]] ?? [] }
    /// Identifiers a notification tap can come back with that are ours (not the default tap or dismiss).
    static var actionIds: Set<String> { Set(cachedActions.map { $0["id"]! }) }

    struct Nag { let id: String; let reminderId: String; let at: Date; let dueAt: Double; let title: String; let timeSensitive: Bool; let link: String? }

    /// Make the pending set equal the given nags (nearest first). Existing alerts for still-wanted nags are kept untouched;
    /// a nag whose time has passed never gets a new alert (only its already-pending one survives).
    /// Delivered alerts (pushes and local backups) whose reminder is not in `live` (completed or deleted anywhere) or whose dueAt
    /// differs from `live[reminder]` (repeat advanced, snoozed) are removed.
    static func replace(with raw: [[String: Any]], live: [String: Double]) {
        let nags: [Nag] = raw.map {
            Nag(id: $0["id"] as! String, reminderId: $0["reminderId"] as! String,
                at: Date(timeIntervalSince1970: ($0["at"] as! Double) / 1000), dueAt: $0["dueAt"] as! Double, title: $0["title"] as! String,
                timeSensitive: ($0["level"] as? String) == "timeSensitive", link: $0["link"] as? String)
        }
        let wanted = Array(nags.sorted { $0.at < $1.at }.prefix(maxPending))
        queue.async {
            let center = UNUserNotificationCenter.current()
            let sem = DispatchSemaphore(value: 0)
            var pending: [UNNotificationRequest] = []
            center.getPendingNotificationRequests { pending = $0; sem.signal() }
            sem.wait()
            var delivered: [UNNotification] = []
            center.getDeliveredNotifications { delivered = $0; sem.signal() }
            sem.wait()
            let closed = delivered.filter { isStale($0.request.content.userInfo, live: live) }.map(\.request.identifier)
            if !closed.isEmpty { center.removeDeliveredNotifications(withIdentifiers: closed) }
            let wantedIds = Set(wanted.map(\.id))
            let have = Dictionary(uniqueKeysWithValues: pending.map { ($0.identifier, $0) })
            let stale = pending.map(\.identifier).filter { !wantedIds.contains($0) }
            if !stale.isEmpty { center.removePendingNotificationRequests(withIdentifiers: stale) }
            let now = Date()
            for n in wanted {
                let fire = n.at.addingTimeInterval(grace)
                // the link is compared too: one added or changed after scheduling must reach the pending backup
                if let existing = have[n.id], existing.content.body == n.title, existing.content.userInfo["link"] as? String == n.link { continue }
                if n.at <= now { continue }
                let c = UNMutableNotificationContent()
                c.title = "Due"
                c.body = n.title
                c.sound = .default
                c.categoryIdentifier = category
                c.threadIdentifier = n.reminderId
                c.userInfo = ["reminderId": n.reminderId, "nagId": n.id, "dueAt": n.dueAt]
                if let link = n.link { c.userInfo["link"] = link }
                if n.timeSensitive { c.interruptionLevel = .timeSensitive }
                let req = UNNotificationRequest(identifier: n.id, content: c,
                                                trigger: UNTimeIntervalNotificationTrigger(timeInterval: max(1, fire.timeIntervalSince(now)), repeats: false))
                center.add(req) { if let e = $0 { NSLog("due: schedule \(n.id) failed: \(e)") } }
            }
        }
    }
}
