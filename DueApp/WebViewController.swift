import UIKit
import WebKit

/// Native top strip (status bar area, follows the page's theme-color) above the web view. The strip is its own view so
/// the page colour never touches `view`/`webView`/`scrollView` backgrounds.
final class WebViewController: UIViewController {
    static let ash = UIColor(red: 0x54 / 255, green: 0x54 / 255, blue: 0x54 / 255, alpha: 1)
    let bridge = Bridge()
    private(set) var webView: WKWebView!
    private let strip = UIView()
    private var themeObs: NSKeyValueObservation?
    private(set) var storeReady = false
    // A compose request that arrived before the page's store was ready (cold launch via the lock-screen button); fired from onReady.
    private var pendingCompose = false
    private var pendingComposeTitle: String?

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.ash
        strip.backgroundColor = Self.ash
        bridge.onReady = { [weak self] in
            DispatchQueue.main.async {
                self?.storeReady = true
                if self?.pendingCompose == true { self?.compose(title: self?.pendingComposeTitle) }
            }
        }
        webView = WebFactory.make(headless: false, bridge: bridge)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        themeObs = webView.observe(\.themeColor, options: [.new]) { [weak self] web, _ in
            self?.strip.backgroundColor = web.themeColor ?? Self.ash
        }
        for v in [strip, webView!] as [UIView] { v.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(v) }
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            strip.topAnchor.constraint(equalTo: view.topAnchor),
            strip.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            strip.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            strip.bottomAnchor.constraint(equalTo: safe.topAnchor),
            webView.topAnchor.constraint(equalTo: safe.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    /// Open the New Reminder sheet (lock-screen button). Before the store is ready, window.dueCompose may not exist yet, so the
    /// request is held and replayed from onReady. Idempotent: the intent's notification and URL both arrive for one press, and
    /// the page just reopens the same blank sheet.
    func compose(title: String? = nil) {
        guard storeReady else { pendingCompose = true; pendingComposeTitle = title; return }
        pendingCompose = false
        pendingComposeTitle = nil
        // Passed as an argument, never spliced into the script: the title is arbitrary text from a URL.
        webView.callAsyncJavaScript("if (window.dueCompose) window.dueCompose(title); return true;", arguments: ["title": title ?? ""], in: nil, in: .page) { r in
            if case .failure(let e) = r { NSLog("due: dueCompose failed: \(e)") }
        }
    }

    /// Ask the live page to apply any recorded notification intents. `done(false)` if the page is not up or does not answer.
    func drainIntents(done: @escaping (Bool) -> Void) {
        guard storeReady else { return done(false) }
        var answered = false
        let finish = { (ok: Bool) in if !answered { answered = true; done(ok) } }
        webView.callAsyncJavaScript("if (window.dueDrain) await window.dueDrain(); return true;", arguments: [:], in: nil, in: .page) { r in
            if case .failure(let e) = r { NSLog("due: dueDrain failed: \(e)"); finish(false) } else { finish(true) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { finish(false) }
    }
}
