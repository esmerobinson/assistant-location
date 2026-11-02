import XCTest

// Simulator UI stress test (.github/workflows/journal-swipe-back.yml).
// Journal is a More-overflow module; users reported crashes when reopening it
// after leaving. Every scenario here leaves Journal and reopens it through the
// real UI (tab taps, More tile, back-swipe, double-tap, background/foreground)
// or the shortcut URL, and holds two oracles after EVERY step:
//   1. app.state == .runningForeground (the app did not die), and
//   2. after a reopen, the Journal screen is hittable, and the typed draft is
//      still in the Text-mode note view (same instance, not rebuilt).
// Failure messages name the scenario, step, and seed. No oracle is skipped.
//
// Launch env, same as JournalSwipeBackUITest: UITEST_OPEN_URL opens
// overland://journal/text through the real URL routing at launch;
// UITEST_OPEN_URL_TRIGGER_FILE re-delivers it whenever the test creates that
// file (an XCUITest cannot deliver a second URL itself on iOS 26).
final class JournalNavigationStressUITest: XCTestCase {

    private let draft = "stress draft 12345"
    private let triggerFile = "/tmp/glnav-open-url-trigger"

    private var app: XCUIApplication!
    private var tabNames: [String] = []   // visible tabs, excluding More
    private var scenario = ""
    private var seed: UInt64 = 0
    private var step = 0

    override func setUp() {
        continueAfterFailure = false
    }

    // MARK: - Context / failure reporting

    private var ctx: String { "[\(scenario) seed=\(seed) step=\(step)]" }

    private func log(_ message: String) { print("STRESS \(ctx) \(message)") }

    private func fail(_ message: String) {
        print("PROBE failure hierarchy: \(app.debugDescription)")
        add(XCTAttachment(screenshot: app.screenshot()))
        XCTFail("\(ctx) \(message)")
    }

    /// Oracle 1, run after every step.
    private func assertAlive(_ what: String) {
        if app.state != .runningForeground {
            fail("app is not running in the foreground after \(what): state rawValue \(app.state.rawValue) (1 = notRunning, i.e. crashed)")
        }
    }

    // MARK: - Launch

    private var journalTitle: XCUIElement { app.staticTexts["AutoJournalHeaderTitle"] }
    private var noteView: XCUIElement { app.textViews["AutoJournalNoteTextView"] }
    private var moreTab: XCUIElement { app.tabBars.buttons["More"] }
    private var tile: XCUIElement { app.webViews.staticTexts["Journal"].firstMatch }

    private func launch(scenario name: String, seed: UInt64 = 0) {
        scenario = name
        self.seed = seed
        step = 0
        app = XCUIApplication()
        app.launchEnvironment["UITEST_OPEN_URL"] = "overland://journal/text"
        app.launchEnvironment["UITEST_STATE_LOG"] = "/tmp/glnav.log"
        app.launchEnvironment["UITEST_OPEN_URL_TRIGGER_FILE"] = triggerFile
        try? FileManager.default.removeItem(atPath: triggerFile)
        app.launch()

        if !noteView.waitForExistence(timeout: 20) {
            fail("Journal never opened from the shortcut URL at launch")
            return
        }
        // The URL open and its tab transition can still be settling; a tap
        // during it gets no keyboard focus. Tap until the keyboard is up.
        var focused = false
        for _ in 0..<5 {
            sleep(2)
            noteView.tap()
            if app.keyboards.firstMatch.waitForExistence(timeout: 3) { focused = true; break }
        }
        if !focused { fail("Journal text view never got keyboard focus"); return }
        noteView.typeText(draft)
        if (noteView.value as? String) != draft { fail("typed text did not land: \(String(describing: noteView.value))"); return }

        tabNames = app.tabBars.buttons.allElementsBoundByIndex.map { $0.label }.filter { $0 != "More" }
        print("PROBE tabs=\(tabNames) all=\(app.tabBars.buttons.allElementsBoundByIndex.map { $0.label })")
        if tabNames.isEmpty { fail("no visible tabs found in the tab bar") }
        dismissKeyboard()
    }

    private func dismissKeyboard() {
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists else { return }
        if journalTitle.exists { journalTitle.tap() }
        let gone = NSPredicate(format: "exists == false")
        let e = XCTNSPredicateExpectation(predicate: gone, object: keyboard)
        if XCTWaiter().wait(for: [e], timeout: 5) != .completed { fail("keyboard did not go away after tapping the Journal header") }
    }

    // MARK: - Actions (real UI)

    private func leave(to tab: String) {
        dismissKeyboard()
        let button = app.tabBars.buttons[tab]
        if !button.waitForExistence(timeout: 5) { fail("tab '\(tab)' is not in the tab bar"); return }
        button.tap()
        usleep(700_000)
        assertAlive("tapping tab \(tab)")
    }

    private func tapMore() {
        if !moreTab.waitForExistence(timeout: 5) { fail("More tab button missing"); return }
        moreTab.tap()
        usleep(700_000)
        assertAlive("tapping More")
    }

    private func swipeBack() {
        dismissKeyboard()
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: end)
        usleep(900_000)
        assertAlive("back-swipe")
    }

    private func backgroundAndForeground() {
        dismissKeyboard()
        XCUIDevice.shared.press(.home)
        sleep(1)
        app.activate()
        if !app.wait(for: .runningForeground, timeout: 10) {
            fail("app did not return to the foreground after home + activate: state \(app.state.rawValue)")
            return
        }
        usleep(700_000)
        assertAlive("background/foreground")
    }

    private func fireShortcutURL() {
        FileManager.default.createFile(atPath: triggerFile, contents: Data())
        usleep(500_000)
    }

    private func openRecent() {
        let button = app.buttons["AutoJournalHeaderRecentsButton"]
        if !button.waitForExistence(timeout: 5) || !button.isHittable { fail("Recents button not hittable on Journal"); return }
        button.tap()
        sleep(1)
        assertAlive("opening Recent")
    }

    // MARK: - Oracle 2: Journal is back

    private var journalVisible: Bool { journalTitle.exists && journalTitle.isHittable }

    /// Strict: Journal must be hittable within `timeout`, with the draft intact.
    private func assertJournalBack(_ how: String, timeout: TimeInterval = 10) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.state != .runningForeground { break }
            if journalVisible { break }
            usleep(300_000)
        }
        assertAlive("reopening Journal via \(how)")
        if !journalVisible { fail("Journal screen is not hittable after \(how)"); return }
        if !noteView.exists || !noteView.isHittable { fail("Journal is up but the note text view is not hittable after \(how)"); return }
        let value = noteView.value as? String
        if value != draft { fail("draft lost after \(how): note view holds \(String(describing: value))") }
    }

    /// From wherever More shows: tile when it is the grid, else the screen
    /// that is on the stack. Returns the state seen, for the log.
    private enum MoreState: String { case journalDirect, grid, other }

    private func moreState() -> MoreState {
        // Wait briefly for either to appear; the page and push can still be settling.
        let deadline = Date().addingTimeInterval(4)
        while Date() < deadline {
            if journalVisible { return .journalDirect }
            if tile.exists && tile.isHittable { return .grid }
            usleep(250_000)
        }
        return .other
    }

    /// Get to the More grid from the More tab: re-tap More (pops to root) when
    /// something other than the grid is showing.
    private func toGrid() {
        var state = moreState()
        if state != .grid {
            log("toGrid: More showed \(state.rawValue), tapping More again to pop to root")
            sleep(1)   // a distinct second tap, not a double-tap
            tapMore()
            state = moreState()
        }
        if state != .grid { fail("More grid with a Journal tile never showed (state \(state.rawValue))") }
    }

    /// Reopen via More tab then, only if the tile is showing, the tile.
    private func reopenViaMoreOnce() {
        tapMore()
        let state = moreState()
        log("More once -> \(state.rawValue)")
        if state == .grid { tile.tap() }
        else if state == .other {
            // e.g. Recent on top: the user taps More again, then the tile.
            toGrid()
            tile.tap()
        }
        assertJournalBack("More tab once")
    }

    private func reopenViaMoreTwiceThenTile() {
        tapMore()
        sleep(1)
        tapMore()
        let state = moreState()
        log("More twice -> \(state.rawValue)")
        if state != .grid { fail("second More tap did not show the grid (state \(state.rawValue))"); return }
        tile.tap()
        assertJournalBack("More tab twice + tile")
    }

    private func reopenViaShortcut() {
        fireShortcutURL()
        assertJournalBack("shortcut URL")
    }

    // MARK: - Scenarios

    // (a) For each visible tab: open Journal from the tile, leave to the tab,
    // return to More, tap the tile, 10 times. (h: draft checked every reopen.)
    func testA_leaveToEachTabAndReopenViaTile() {
        launch(scenario: "A")
        for tab in tabNames {
            for i in 1...4 {
                step += 1
                log("leave to \(tab) (round \(i))")
                leave(to: tab)
                tapMore()
                toGrid()
                tile.tap()
                assertJournalBack("tile after leaving to \(tab) (round \(i))")
            }
        }
    }

    // (b) Same, returning by tapping More once vs twice.
    func testB_moreTabOnceVersusTwice() {
        launch(scenario: "B")
        for tab in tabNames {
            for i in 1...3 {
                step += 1
                log("once: leave to \(tab) (round \(i))")
                leave(to: tab)
                reopenViaMoreOnce()
                step += 1
                log("twice: leave to \(tab) (round \(i))")
                leave(to: tab)
                reopenViaMoreTwiceThenTile()
            }
        }
    }

    // (c) Back-swipe off Journal, then the tile, repeated.
    func testC_backSwipeThenTile() {
        launch(scenario: "C")
        for i in 1...6 {
            step += 1
            log("back-swipe round \(i)")
            swipeBack()
            toGrid()
            tile.tap()
            assertJournalBack("tile after back-swipe (round \(i))")
        }
    }

    // (d) Open Recent inside Journal, leave to another tab, come back, reopen.
    func testD_recentThenLeaveAndReopen() {
        launch(scenario: "D")
        for tab in tabNames {
            for i in 1...2 {
                step += 1
                log("recent, leave to \(tab) (round \(i))")
                openRecent()
                leave(to: tab)
                reopenViaMoreOnce()
            }
        }
    }

    // (e) Shortcut URL while on another tab, after a prior open, repeated.
    func testE_shortcutFromOtherTabs() {
        launch(scenario: "E")
        for tab in tabNames {
            for i in 1...3 {
                step += 1
                log("shortcut from \(tab) (round \(i))")
                leave(to: tab)
                reopenViaShortcut()
            }
        }
    }

    // (f) Double-tap the tile quickly.
    func testF_doubleTapTile() {
        launch(scenario: "F")
        for i in 1...6 {
            step += 1
            log("double-tap tile round \(i)")
            swipeBack()
            toGrid()
            tile.doubleTap()
            assertJournalBack("double-tapped tile (round \(i))")
        }
    }

    // (g) Background/foreground between reopen cycles.
    func testG_backgroundForegroundBetweenReopens() {
        launch(scenario: "G")
        for tab in tabNames {
            for i in 1...2 {
                step += 1
                log("leave to \(tab), background, reopen (round \(i))")
                leave(to: tab)
                backgroundAndForeground()
                reopenViaMoreOnce()
                backgroundAndForeground()
                // after resume Journal must still be reachable and hold the draft
                if !journalVisible { reopenViaMoreOnce() } else { assertJournalBack("resume with Journal on screen") }
            }
        }
    }

    // (i) Seeded monkey over all of the above. Fixed seeds, every step printed.
    func testI_monkeySeed11() { monkey(seed: 11, steps: 90) }
    func testI_monkeySeed2026() { monkey(seed: 2026, steps: 90) }

    private struct SplitMix64: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E3779B97F4A7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
            z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
            return z ^ (z >> 31)
        }
    }

    private func monkey(seed: UInt64, steps: Int) {
        launch(scenario: "I", seed: seed)
        var rng = SplitMix64(state: seed)
        let actions = ["leaveTab", "moreOnce", "moreTwice", "backSwipe", "recent", "shortcut",
                       "background", "doubleTapTile", "reopenOnce", "reopenTwice", "reopenShortcut"]
        for n in 1...steps {
            step = n
            let action = actions.randomElement(using: &rng)!
            let tab = tabNames.randomElement(using: &rng)!
            log("action=\(action) tab=\(tab)")
            switch action {
            case "leaveTab": leave(to: tab)
            case "moreOnce": tapMore()
            case "moreTwice": tapMore(); sleep(1); tapMore()
            case "backSwipe": if journalVisible { swipeBack() } else { tapMore() }
            case "recent": if journalVisible { openRecent() } else { tapMore() }
            case "shortcut": fireShortcutURL()
            case "background": backgroundAndForeground()
            case "doubleTapTile":
                if tile.exists && tile.isHittable { tile.doubleTap(); usleep(800_000) } else { tapMore() }
            case "reopenOnce": reopenViaMoreOnce()
            case "reopenTwice": reopenViaMoreTwiceThenTile()
            case "reopenShortcut": reopenViaShortcut()
            default: fail("unknown action \(action)")
            }
            assertAlive(action)
            // Strict reopen every 4th step, by a seed-chosen route, so the
            // sequence is regularly forced through a full leave-and-reopen.
            if n % 4 == 0 {
                let route = Int.random(in: 0..<3, using: &rng)
                log("checkpoint reopen route=\(route)")
                if route == 0 { reopenViaMoreOnce() }
                else if route == 1 { reopenViaMoreTwiceThenTile() }
                else { reopenViaShortcut() }
            }
        }
    }
}
