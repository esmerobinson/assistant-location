# Adding a micro app (tab)

Read this before writing any code. The app is a shell; each tab is an
independent **module** under `Modules/`. Several sessions can add tabs at the
same time because a module shares **no file** with any other module.

## The contract

`Modules/GLModule.h`:

```objc
@protocol GLModule <NSObject>
+ (NSString *)moduleTitle;        // tab bar title
+ (UIImage *)moduleIcon;          // e.g. [UIImage systemImageNamed:@"calendar"]
+ (NSInteger)moduleOrder;         // lower sorts left; ties break on class name
+ (UIViewController *)makeViewController;   // fresh root VC for the tab
@end
```

Your module class must also register itself at load time:

```objc
+ (void)load {
    [GLModuleRegistry registerModule:self];
}
```

**Forgetting this is silent** — the module simply never appears as a tab, and
nothing fails until CI's `installed N tabs` log-line assertion catches the
missing name (see "CI and verification" below). `GLModuleRegistry` no longer
scans for conformers; it only sorts whatever registered itself. Copy the
snippet above into your module's own `.m` file exactly — it also needs
`#import "GLModuleRegistry.h"`.

`GLModuleRegistry` collects everything that calls `+registerModule:`, sorts
the conformers by `+moduleOrder` then class name, calls `+makeViewController`
on each, and sets `title` / `tabBarItem` / `restorationIdentifier` on the
result. **Do not set your own `tabBarItem`** — the registry owns it.

**`+makeViewController` returns a plain view controller, never a
`UINavigationController`.** Overflow modules (behind More) are pushed onto the
shared More stack, and a module's own sub-screens are pushed onto
`self.navigationController` (that same stack). A self-wrapped module made UIKit
move the wrapper's children onto the More stack and leave the wrapper empty,
which crashed reopening Journal. `scripts/check_module_nav_wrappers.sh` (run by
`ota`) fails the build on a wrapper.

(Runtime discovery via `objc_copyClassList` + `class_conformsToProtocol` was
the original approach, replaced because it realizes every class in the
process — UIKit, Foundation, everything — just to test each one, which
measured as the single largest phase of cold launch. Self-registration touches
only the classes that actually are modules.)

Orders in use: Sessions ("New Session") 50, Events 100, Todos 150, Overstim 160, Football 200, Settings
300, Finances 610, AutoJournal (Journal) 620,
Esme 650, Growth 660, Outfits 670, Upload 690, Tracker 700, GoalTracker 705, Debate 707, Clips 710. Pick an unused value;
`new_module.sh` defaults to highest + 100.
iOS shows only the first 4 tabs by order plus a "More" bucket for the rest,
so today's visible tab bar is New Session | Events | Todos | Overstim, with Football,
Settings, Tracker, Finances, Journal, Esme, Growth, Outfits and Upload behind More.
Quotes is not part of the Superapp: it is a standalone app (`com.oliverullman.quotes`) built from
`QuotesApp/` (app shell) and `QuotesApp/Sources/` (UI, store, rule engine), like Listen
(`scripts/add_quotes_app.rb`, `ota-quotes.yml`). Its home-screen widget is the `QuotesWidget`
extension (`com.oliverullman.quotes.widget`, `QuotesWidget/`, `scripts/add_quotes_widget_ext.rb`)
embedded in Quotes.app, with its own ad-hoc profile registered by the `quotes_adhoc` lane. App and
widget share the quotes data through the keychain group
`com.oliverullman.assistantlocation.quotes` (name kept so older data survives). The Superapp and
JournalControl contain no Quotes code or entitlement.
Marketplace is also standalone (`com.oliverullman.marketplace`, `MarketplaceApp/`,
`scripts/add_marketplace_app.rb`, `ota-marketplace.yml`, lane `marketplace_adhoc`): one
full-screen WKWebView hosting the bundled `Modules/WebPages/questions.html` (plus `page.css`,
`gl-bridge.js`, referenced by path, not copied), talking to the marketplace server on port 8324
(`GET /questions`, `POST /reply`, `/listings/sold`, `/takeovers/*`, `/register`). It has its own APNs
registration (the lane enables the PUSH_NOTIFICATIONS capability on the App ID before generating the
profile), the FB_REPLY inline-reply category, and a durable reply outbox (`MarketplaceOutbox`). The
page's `/push/reply` endpoint is remapped to `/reply` by a fetch shim in `MarketplaceViewController.m`.
The Superapp has no Facebook tab or FB_REPLY handling any more; the Marketplace app replaced them.
Gripes is standalone too (`com.oliverullman.gripes`, `GripesApp/`, `scripts/add_gripes_app.rb`,
`ota-gripes.yml`, lane `gripes_adhoc`, URL scheme `gripes://log`): a pain and complaint logger with no
notifications and no push. A full-screen WKWebView hosts the bundled `GripesApp/web/` page (logic in
`gripes-core.js`, unit-tested by `WebPagesTests/test/gripes-core.test.mjs`; `page.css` and `gl-bridge.js`
are referenced from `Modules/WebPages/`). It is fully offline: entries live in a JSON file in
Application Support (`GripesStore`), each write marks the entry dirty in a durable outbox, and a silent
sync pushes dirty entries to the box (port 8326, `POST/GET /api/entries`) and pulls newer ones.
Voice entry is native SFSpeechRecognizer (`GripesVoiceListener`) with a deterministic on-device parser.
`gripes-shots.yml` (manual) screenshots the key screens from DEBUG-only `GRIPES_SHOT` scenarios.
Cycle is standalone too (`com.oliverullman.cycle`, `CycleApp/`, `scripts/add_cycle_app.rb`,
`ota-cycle.yml` and `testflight-cycle.yml` (both manual), lanes `cycle_adhoc` and `cycle_beta`): a
full-screen WKWebView hosts the bundled `CycleApp/web/` folder reference (a folder, so new web files
need no project change). The shell has no logic of its own beyond the `cycle` bridge
(`CycleBridge`; page sends `{id, cmd, args}`, native answers `window.__cycleReply(id, result, error)`):
`store.get/set/keys` over a single atomic JSON file in Application Support (`CycleStore`, backed up,
survives updates), `notify.permission/status/schedule/cancel` as local notifications (`status` never prompts; `app.openSettings` opens the app's Settings page) (`CycleNotifier`; the
page's id is the notification identifier, so re-scheduling an id replaces it), `haptic`, and `ready`.
A notification tap calls `window.cycleNative.route(route)`, queued until the page sends `ready`;
`cycleNative.foreground()` fires on becoming active. No background modes. Remote push (APNs, sent by the box's
`cycle-server`) is delivered by the embedded `CycleNSE` Notification Service Extension (`com.oliverullman.cycle.nse`,
`CycleNSE/`, `scripts/add_cycle_nse.rb`, profiles `Cycle NSE AdHoc`/`Cycle NSE AppStore`, signed in both `cycle_adhoc` and
`cycle_beta`): the box sends `mutable-content` pushes carrying `receipt: {id, url}`, and the extension POSTs `{id}` to
`<boxUrl>/push/delivered` (https only, 5 s, alert shown unchanged whether or not it succeeds) so the box's
`~/.config/cycle/push-receipts.json` records `deliveredAt` per send. APNs 200 only means Apple accepted it; this is the
only delivery signal. Receipt parsing and the exactly-once contentHandler gate live in `CycleNSE/CycleReceipt.m`
(unit-tested in `SharedTests/CycleReceiptTests.m`); `ota-cycle` opens the built ipa and checks the appex id and signing.
Adding the extension needed a reinstall (native code), not a web OTA. The page's
`config.js` (Supabase URL and anon key, box URL) is generated in the workflows from the secrets
`CYCLE_SUPABASE_URL`, `CYCLE_SUPABASE_ANON_KEY`, `CYCLE_BOX_URL`, never committed (`.gitignore`), and
the build fails when any is empty. Tests: `SharedTests/Cycle*Tests.m` (store, bridge, notifier, and
the Info.plist/asset values). Installing needs each device's UDID registered for ad hoc, or the
App Store Connect app record (a one-time manual step) plus testers for TestFlight.
Web OTA (`CycleWebUpdater`): the bundle is the offline floor, and on launch and foreground (throttled to 10 min) the shell
fetches `<boxUrl>/app/manifest.json` (`{version, minShell, files: {path: sha256}}`, served by cycle-server from the dir
`server/deploy-web.sh` fills). `version` is the commit time of the last change under `CycleApp/web`: deploy-web.sh writes it to
`version.json` on the box, and the ota/testflight workflows stamp it into the bundle (gitignored). A newer manifest whose `minShell`
(committed `CycleApp/web/shell.json`) is <= the app's `CycleShellVersion` (Info.plist; bump it with any bridge change that new web code
needs) is downloaded into `Application Support/web-ota/staging` (unchanged files reused from the active copy or bundle, each sha256
checked, bundled `config.js` copied in), moved to `v<version>/` and activated by an atomic `active.txt` write. Any failure leaves the
previous copy active. The page loads the newer of bundle and active copy at `viewDidLoad` only, never mid-session. Data is unaffected:
the page's store goes through the native bridge, not `localStorage` (only the no-bridge dev fallback uses it).
Layout rules and the layout sweep test: `CycleApp/web/LAYOUT.md`.
(Finances held slot 50 — the first visible tab — until Esme took it over;
Finances moved to 610, between Upload and Journal, to make room.)

The More bucket's order is chosen for thumb reach, not alphabetically: the
grid renders the first tile alone on its own row -- full-width ("hero")
whenever the module count is odd, as it is today -- so the module that
lands first (Settings) sits in the hardest-to-reach spot and the two
most-used ones fall on the bottom row. `more.html`'s own
`DEFAULT_ORDER` mirrors this sequence so the ordering ships via the webpages
deploy rather than waiting on an OTA; `events/test_more_grid_order.py` in the
assistant repo fails if the two ever disagree.

### More-grid icons are required

Any module that lands in the More grid (everything past the first four by
order) MUST have its own inline-SVG entry in `MODULE_ICONS` in
`Modules/WebPages/more.html`, matching the SF Symbol its `+moduleIcon` returns.
The plain-square `FALLBACK_ICON` is a bug marker, not a default.
`WebPagesTests/test/more-icons.test.mjs` fails when a More module has no entry,
so a new module cannot ship without one. Adding a module = add the icon in the
same change.

### Optional hooks: fan-out from the app shell

The app shell (`AppDelegate.m` / `SceneDelegate.m`) contains **zero**
feature-specific knowledge — it doesn't import `GLManager.h`, `CoreLocation`,
or any module header, and it doesn't know what any URL scheme, quick-action
type, or `NSUserActivity` type means. Instead it fans out generically to
every module via five `@optional` methods on `GLModule`:

```objc
+ (void)moduleDidFinishLaunchingWithOptions:(nullable NSDictionary *)launchOptions;  // app launch, once
+ (BOOL)moduleHandleURL:(NSURL *)url;                                // return YES if consumed
+ (BOOL)moduleHandleUserActivity:(NSUserActivity *)activity;         // return YES if consumed
+ (BOOL)moduleHandleShortcutItem:(UIApplicationShortcutItem *)item;  // return YES if consumed
+ (NSString *)moduleDiagnosticSummary;                               // lines for the launch diagnostic alert, or nil
```

`moduleDidFinishLaunchingWithOptions:` receives UIKit's real launch-options
dictionary unmodified — the shell attaches no meaning to any key in it
(including `UIApplicationLaunchOptionsLocationKey`, a background-location
relaunch signal only a location module cares about). Likewise
`moduleHandleUserActivity:` and `moduleHandleShortcutItem:` receive the real
`NSUserActivity` / `UIApplicationShortcutItem` UIKit handed the shell — never
a synthetic stand-in constructed by the shell to signal something else.
**A module MUST return `NO` from `moduleHandleUserActivity:` and
`moduleHandleShortcutItem:` for any activity/item type it does not own**, so
the registry can offer it to the next module; returning `YES` (or mutating
shared state) for an unrecognized type is a bug, not permissive handling.

`GLModuleRegistry` exposes the matching fan-out, walking the same
`+moduleClasses` list tab installation uses (cached via `dispatch_once` since
module membership can't change at runtime), and guarding every call with
`respondsToSelector:` since the hooks are optional:

```objc
+ (void)notifyModulesDidFinishLaunchingWithOptions:(nullable NSDictionary *)launchOptions;
+ (BOOL)routeURL:(NSURL *)url;                 // first module returning YES wins
+ (BOOL)routeUserActivity:(NSUserActivity *)activity;
+ (BOOL)routeShortcutItem:(UIApplicationShortcutItem *)item;
+ (NSString *)diagnosticSummary;               // joins each module's summary, skipping nil/empty
```

The launch fan-out logs which modules responded (`Module registry: launch
hooks fired for N modules: ...`), the same way tab installation logs which
tabs it installed — `sim-test.yml` asserts on both lines, so a hook renamed
out from under `respondsToSelector:` fails CI instead of silently going dead.

If your module needs to run setup at launch, handle a custom-scheme URL, a
Siri/Handoff continuation, or a home-screen quick action, or contribute a
line to the build diagnostic, implement the relevant method(s) — don't touch
the shell. For lifecycle events that already have a real UIKit notification
(foreground/background/resign-active/terminate), observe the notification
yourself from inside your module rather than asking the shell to call you —
see `Modules/Tracker/TrackerAppLifecycle.m`'s `+load` for the pattern.

## Where files go

```
Modules/<Name>/          ← yours, exclusively. Nothing else may live here.
Modules/GLModule.h       ← the contract (do not edit)
Modules/GLModuleRegistry.{h,m}  ← discovery (do not edit)
Shared/, App/, Location/ ← shared code: the platform layer, BakedConfig, and
                           the location library (see below). You may IMPORT
                           these; do not restructure them.
```

`Modules/` is a **file-system-synchronized folder** (`objectVersion = 77`,
`PBXFileSystemSynchronizedRootGroup`). Every `.m` you drop under it is compiled
automatically — **there is no `project.pbxproj` edit**, which is why concurrent
branches merge cleanly.

`HEADER_SEARCH_PATHS` covers `Modules/`, `App/`, `Location/` and `Shared/`, so
import by bare name: `#import "GLManager.h"`, `#import "GLDropUploader.h"`,
`#import "BakedConfig.h"`.

## The shared platform layer (`Shared/`)

Every tab should look and behave like the same app. Before hand-rolling a
button, a colour, a font size, a failure message, or a launch/background
hook, check whether `Shared/` already has it — it exists specifically because
each of these was previously built two-to-four times, differently, per module.

- **`GLTheme.h`** — appearance mode (`+currentMode`/`+setCurrentMode:`,
  System/Light/Dark, persisted, applies `overrideUserInterfaceStyle` to every
  scene and posts `GLThemeDidChangeNotification`) plus colour tokens
  (`+backgroundColor`, `+surfaceColor`, `+accentColor`, `+destructiveColor`,
  `+textPrimaryColor`, `+textSecondaryColor`), type tokens built on
  `preferredFontForTextStyle:` (`+titleFont`, `+bodyFont`, `+captionFont`,
  `+monoDigitFont`, `+buttonFont`), and metric tokens: a spacing scale
  (`+spacingXXS` through `+spacingXL`), one `+cornerRadius`, one
  `+controlHeight`. Never hardcode a colour, font size, radius or height —
  use these instead.
- **`GLWebModuleViewController.h`** — base class for a tab that's a thin
  wrapper around a web app, three flavors: a locally-hosted server (Events,
  Todos — `-initWithURL:displayName:`), a page bundled straight into the app
  with no update path (`-initWithBundledPageNamed:`), or a **managed** page
  (More, Settings, Journal's Recent screen —
  `-initWithManagedPageNamed:`) — see "Web pages: bundle floor + server
  updates" below. Provides WKWebView setup, pull-to-refresh, a loading
  indicator, an error view with retry, and theme propagation into the page
  (`?theme=light|dark` query param + `data-theme` on `documentElement`, kept
  in sync via `GLThemeDidChangeNotification`).
- **`GLComponents.h`** — `+primaryButtonWithTitle:`, `+statusLabel`,
  `+emptyStateViewWithMessage:`, `+failureViewWithMessage:retryHandler:`,
  `+showToastInView:message:`. One way to build each, all reading `GLTheme`
  tokens.
- **`GLHaptics.h`** — `GLHapticSuccess()`, `GLHapticWarning()`,
  `GLHapticSelection()`. Use these instead of hand-rolling a feedback
  generator per call site.
- **`GLLog.h`** — `GLLog(format, ...)`, prefixes the log line with the
  calling class name (`[EventsViewController] uploaded %@`). Use it instead
  of a bare `NSLog`.
- **`GLFormat.h`** — `GLFormatDuration(seconds)` ("mm:ss" below an hour,
  "h:mm:ss" at or past one) and `GLFilenameTimestamp()`
  ("yyyy-MM-dd-HHmmss"). The correct, single implementation — don't write
  your own duration formatter.
- **`GLDefaultsKeys.h`** — centralizes cross-module `NSUserDefaults` key
  constants that don't belong to one module. Add a raw string literal here
  instead of hardcoding it at the call site.

### Web-backed tabs: writes are optimistic and offline-queued

A tab whose content is a web app (the `GLWebModuleViewController` flavors
above) does not get to define its own save behavior. Those apps share one
write contract, written up in the assistant repo's `CLAUDE.md` — one
directory up from this checkout — under `## MANDATORY: Every write in an
/app tab is optimistic and offline-queued`. Read it before changing any
mutation path in a tab's web app.

In short: a user-initiated write commits to the UI immediately, without
awaiting the network, and a request that fails at the network level goes
onto a durable local queue keyed by an `opId` and replays when connectivity
returns, so the server route must be idempotent on that id. A genuine HTTP
4xx/5xx from a reachable server is handled the other way — never queued, it
reverts the optimistic change and surfaces the failure. This matters more
here than on the desktop: the phone is where the underground, the lift and
the dying connection actually happen.


### Web-backed tabs: cold launch with no connection

`Shared/GLOfflineShell.{h,m}`. Every remote web tab (via
`GLWebModuleViewController`) and Listen (`ListenViewController`) saves the
server's `<tabBase>/shell.html` after each successful live load (Application
Support/ShellCache, atomic, 200 + text/html only; a 404 keeps any old copy).
On a later cold load that fails with a network-class error, or gets no
response within ~4s, the saved copy is shown with
`loadSimulatedRequest:responseHTMLString:` at the live page's own URL, so the
origin and its localStorage (the app's offline queue and read cache) are
shared. An "Offline copy" pill shows meanwhile; the page goes live on the next
cold launch, on Refresh, or on foreground once the copy has been up ~1 min and
the server answers. No service workers (WKWebView only runs them for
`WKAppBoundDomains`). A tab whose server does not serve `/shell.html` has no
fallback and keeps the error view. Tests: `ShellTests/` (hosted bundle, real
WKWebView + local server), generated by `scripts/add_shell_tests_target.rb` and
run by `unit-test.yml`.

### Optional lifecycle hooks

Beyond the five hooks in the contract above, `GLModule` also declares three
`@optional` UIKit lifecycle hooks, fanned out by `GLModuleRegistry` from a
single observed `UIScene` notification each (in `+moduleOrder`-then-class-name
order, same as everything else):

```objc
+ (void)moduleDidEnterBackground;     // mirrors UISceneDidEnterBackgroundNotification
+ (void)moduleWillEnterForeground;    // mirrors UISceneWillEnterForegroundNotification
+ (void)moduleWillResignActive;       // mirrors UISceneWillDeactivateNotification
```

Implement whichever your module needs instead of hand-rolling your own
`+load` notification observer (the old pattern, still present in
`TrackerAppLifecycle.m` for reference, but not one a new module should copy).

### The default tab

```objc
+ (BOOL)moduleIsDefaultTab;    // return YES to make this the tab the app opens on
```

`GLModuleRegistry` walks `+moduleClasses` in the same order as everything
else and selects the FIRST module that returns `YES` here
(`+selectDefaultTabInTabBarController:`) — at most one module should
implement this returning `YES`. `SceneDelegate` calls it on a cold launch
and again on a foreground resume once the app has been backgrounded past a
threshold (`UITEST_RESUME_THRESHOLD_SECONDS`, default 180s); a quick
app-switch below that threshold leaves the current tab alone. A default
module in the More overflow is opened by selecting More and pushing it,
exactly like a tile tap. Growth (a More-grid module) is the default; Todos
opts in only during Growth's post-review quiet window, and because Todos
sorts before Growth, its answer must stay the exact complement of Growth's.

## Web pages: bundle floor + server updates

More, Settings, and Journal's Recent screen (`Modules/WebPages/{more,settings,
recents}.html` + shared `page.css`/`gl-bridge.js`) are **managed pages**,
loaded via `-[GLWebModuleViewController initWithManagedPageNamed:]`. Every
managed page ships in the app bundle exactly like a plain bundled page — the
bundle is the offline floor and always renders, even with no network ever —
but `GLWebPageCache` (`Shared/GLWebPageCache.h`) ALSO checks in the
background, on every open, for a newer verified copy published by
`events/server.py`'s `GET /webpages/manifest.json` + `GET /webpages/files/<name>`
routes, and swaps it in for the next open if one exists. This is what lets a
plain CSS/copy tweak to one of these pages reach the phone through the
normal ~2-minute `assistant` deploy instead of a full OTA rebuild.

**Single source of truth**: `Overland-iOS/Modules/WebPages/`. `events/server.py`
does NOT publish a second, committed copy of these files anywhere — it reads
them straight off disk from the nested Overland-iOS checkout on the same box
(kept at `origin/main` by `deploy/assistant-deploy`'s own Overland-iOS pull,
piggybacked on its normal 2-minute tick) and computes the manifest's hashes
live, on every request. There is nothing here that can drift, by
construction — see `events/test_webpages_route.py`'s drift-check tests,
which prove the served bytes and the manifest's claimed hash both match the
real file on disk.

**Adding a page** needs no new plumbing on either side: drop a new `.html`
into `Modules/WebPages/` (referencing `gl-bridge.js`/`page.css` as sibling
files the way the existing three do), reference it from your module with
`initWithManagedPageNamed:@"yourpage.html"`, done — the server's manifest
route walks the directory, so a new file is served automatically, and the
whole `WebPages/` directory updates as ONE atomic set (page.css/gl-bridge.js
are shared, so a new page's HTML and the shared CSS/JS are never split
across an update).

**Never** hand-edit `location-server/public/` to add a page-serving route —
that directory no longer exists; the pattern above (read live from the
nested Overland-iOS checkout) is the one mechanism, and location-server's own
`GET /recents.html` static route (kept for headless testing) reads from the
same directory rather than a second copy, for the same drift-free reason.

## The location library (`Location/`)

`GLManager`, `LOLDatabase`, `NSArray+map` and `WifiZoneViewController` live in
`Location/` as a **library, not a module** — it has no tab of its own and no
`GLModule` conformer. `Modules/Tracker` and `Modules/Settings` both import it
(`#import "GLManager.h"`) without violating the no-cross-module-imports rule,
because it isn't another module.

### Rules

- **Never** forget the `+load` self-registration snippet above — a module
  that conforms to `GLModule` but never calls `+registerModule:` compiles
  fine and simply has no tab, with no error anywhere.
- **Never** edit `Location/Base.lproj/Location.storyboard` or
  `App/Base.lproj/Main.storyboard`. Build your UI in code.
- **Never** edit another module's directory, `GLModuleRegistry.{h,m}`,
  `GLModule.h`, `AppDelegate.m`, `SceneDelegate.m`, or
  `Overland.xcodeproj/project.pbxproj`. These five are the shared contract
  and the shell — a module session touching them can break every other
  module or race a concurrent session editing the same file. Everything an
  ordinary module needs is reachable through the optional-hook fan-out above
  (implement `+moduleDidFinishLaunchingWithOptions:` / `+moduleHandleURL:` /
  `+moduleHandleUserActivity:` / `+moduleHandleShortcutItem:` /
  `+moduleDiagnosticSummary` in your own module class, or observe a UIKit
  notification yourself) — that is the
  extension point, not editing the shell. A session that finds it genuinely
  needs a new shell hook should propose extending `GLModule.h` /
  `GLModuleRegistry` explicitly, the way this one did, rather than reaching
  into `AppDelegate.m` / `SceneDelegate.m` directly.
- **Never** import another module's headers. Modules depend on `Shared/`,
  `App/` and `Location/` only, never on each other.
- No defensive fallbacks. If a shared invariant is violated, raise.

## Worktree convention

```bash
cd ~/coding/assistant/Overland-iOS
git worktree add .claude/worktrees/<module-name> -b <module-name> main
```

One worktree per module, always branched off `main`.

## Scaffolding

```bash
scripts/new_module.sh Events          # → Modules/Events/, order = highest+100
scripts/new_module.sh Events 500      # explicit order
```

Produces a compiling app with a new tab showing a centred label. `git status`
after running it shows **only** `Modules/Events/`.

## CI budget

macOS GitHub Actions runners bill at **10x** normal minutes. The free tier is
~200 macOS minutes/month — that's it, no more.

- `ota` is the default delivery path. It runs automatically on every push to
  `main`, builds an ad-hoc ipa, and a poller on the dev box installs it
  (~1 min, no ASC processing). Don't add anything else to its auto-trigger.
- `build` (TestFlight) is **manual only** (`workflow_dispatch`). Dispatch it
  by hand only when the phone is off the tailnet and OTA can't reach it.
- `sim-test` is **manual only**. It is opt-in — dispatch it when there is an
  actual visual/behavioral claim to verify, not reflexively. Batch: one run
  per change, never one run per question.
- `gen-project` and `device-farm-build` are already manual-only; keep them
  that way.
- Agents must not use CI as a compiler. Don't push or dispatch a workflow to
  "see if it builds" — read the code, use `xcodebuild` locally if available,
  or ask.
- Before dispatching any workflow, run `gh run list` and check for an
  in-flight run of the same workflow first. Don't queue a duplicate.
- Every workflow carries a `concurrency` group keyed on
  `${{ github.workflow }}-${{ github.ref }}` with `cancel-in-progress: true`,
  so rapid successive pushes cancel the stale run instead of stacking minutes.
  Don't remove it.
- `ota.yml`'s `paths-ignore` keeps doc/tooling-only changes from triggering a
  macOS build. When adding a new ignored path, confirm it truly can't affect
  the built product — when in doubt, don't ignore it.

## CI and verification

```bash
gh workflow run sim-test --ref <branch>              # build + boot in simulator
gh run list --branch <branch> --limit 1              # poll to completion
gh run download <run-id> -n main-screen -D /tmp/shots
```

`sim-test` builds for the simulator, boots the app, drives location, and
screenshots each tab. Select a tab with `SIMCTL_CHILD_UITEST_TAB=<index>`
(read by `SceneDelegate`). **Add a screenshot step for your tab's index** in
`.github/workflows/sim-test.yml` — that file is the one shared file a module
session may touch, and only to append its own screenshot + artifact path.

Verification means **looking at the pixels** in the downloaded PNGs: your tab
renders its content, and the tab bar shows every module's title in order. A
green run alone is not verification.

The run also asserts on the registry's launch log lines:

```
Module registry: installed N tabs: Tracker, Settings, Upload
Module registry: launch hooks fired for N modules: Tracker
```

Bump `N` and the title list for the tabs line when your tab is added; bump
the launch-hooks line only if your module implements
`moduleDidFinishLaunchingWithOptions:`.

## Getting a build onto the phone

Pushing to `main` triggers exactly one workflow:

- **`ota`** — ad-hoc ipa, published to the tailnet-only OTA install page
  (URL kept out of this public repo — ask whoever owns the deployment).
  Reaches the phone within ~2 minutes of the push. This is the default
  delivery path.

**`build`** (signed archive → TestFlight) is `workflow_dispatch`-only. Dispatch
it by hand only when the phone is off the tailnet and OTA can't reach it — see
the CI budget section above.

### TestFlight delivery is verified via the ASC API, never a CI log line

A green `build` run means "uploaded", not "installable". Processing can still
fail silently afterwards. Confirm with App Store Connect:

```bash
python3 ~/.config/assistant/asc.py GET \
  "/v1/builds?filter[app]=<APP_ID>&limit=1&include=betaGroups&fields[builds]=version,processingState"
```

A build is delivered only when it has `betaGroups` containing `Internal` **and**
`internalBuildState = IN_BETA_TESTING`. Anything else — including
`PROCESSING`, `READY_FOR_BETA_SUBMISSION`, or an empty `betaGroups` — is not
delivered, and reporting it as delivered is a false PASS.

## Worked example: adding an Events tab

```bash
cd ~/coding/assistant/Overland-iOS
git worktree add .claude/worktrees/events -b events main
cd .claude/worktrees/events

scripts/new_module.sh Events
# → Modules/Events/EventsModule.{h,m}, Modules/Events/EventsViewController.{h,m}

# Build the real UI in EventsViewController.m. Import shared code by name:
#   #import "GLManager.h"        (location state)
#   #import "BakedConfig.h"      (GL_BAKED_HOST / GL_BAKED_TOKEN)
#   #import "GLEndpoints.h"      (GLEndpointURL(path) — build a full URL)
#   #import "GLDropUploader.h"   (POST helper)

# Append an Events screenshot step to .github/workflows/sim-test.yml
# (tab index 3) and bump the "installed 4 tabs" assertion.

git add -A && git commit -m "Add the Events micro app"
git push -u origin events
gh workflow run sim-test --ref events

# Poll, download main-screen artifact, LOOK at events-screen.png and
# main-screen.png (at the time Events was added the visible tab bar read
# Tracker | Settings | Upload | Events; today's current order is
# Journal | Todos | Events | Tracker, with Settings/Upload behind More).

git checkout main && git merge events && git push
# Watch `ota` go green (the only workflow the push triggers), then check the
# OTA page picked up the new build number.
```

Total files touched outside `Modules/Events/`: one — `sim-test.yml`. Two
sessions appending different screenshot steps to it conflict only on adjacent
lines; take both hunks.
