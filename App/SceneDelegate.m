//
//  SceneDelegate.m
//  Overland
//
//  Created by Aaron Parecki on 12/10/23.
//  Copyright © 2023 Aaron Parecki. All rights reserved.
//

#import <objc/runtime.h>
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h> // CACurrentMediaTime, logged beside the real clock (see GLContinuousSeconds).
#include <time.h>

#import "SceneDelegate.h"
#import "GLModuleRegistry.h"
#import "GLDefaultTabArbiter.h"
#import "GLTheme.h"
#import "GLLog.h"
#import "GLDefaultsKeys.h"
#import "GLEndpoints.h"
#import "GLAppStateReporter.h"
#import "GLCrashReporter.h"
#import "BuildStamp.generated.h"

// How long the app has to have been backgrounded before a foreground resume
// resets to the default tab — a quick app-switch must not yank the user off
// whatever tab they were on, but a real absence should. Overridable so
// sim-test can drive both the "long absence" and "quick switch" paths
// without an actual multi-minute wait (see UITEST_RESUME_THRESHOLD_SECONDS
// in sim-test.yml).
static NSTimeInterval const kGLDefaultTabResumeThresholdSecondsDefault = 180.0;

static NSTimeInterval GLDefaultTabResumeThresholdSeconds(void) {
    NSString *override = [[NSProcessInfo processInfo] environment][@"UITEST_RESUME_THRESHOLD_SECONDS"];
    if (override.length > 0) {
        return [override doubleValue];
    }
    return kGLDefaultTabResumeThresholdSecondsDefault;
}

// After the default tab has been auto-selected, no further resume reset for
// this long, and no cold-launch selection either; the start time is persisted
// so a relaunch does not reset it. Overridable for sim-test, like the threshold above.
// 0 = off (2026-11-04, Oliver: Growth "wasn't opening enough"; it was shown
// once, ignored, then skipped on every open for 4 hours). The rest after a
// real Growth answer/pick is Growth's own quiet window (GLGrowthQuietWindow:
// 30 min after a card, 4 hours after a tile pick), so this cooldown only ever
// suppressed the default tab when nothing had been done with it. Kept as a
// knob rather than deleted because sim-test.yml drives it via the override.
static NSTimeInterval const kGLDefaultTabCooldownSecondsDefault = 0;

static NSTimeInterval GLDefaultTabCooldownSeconds(void) {
    NSString *override = [[NSProcessInfo processInfo] environment][@"UITEST_DEFAULT_TAB_COOLDOWN_SECONDS"];
    if (override.length > 0) {
        return [override doubleValue];
    }
    return kGLDefaultTabCooldownSecondsDefault;
}

// Seconds on a clock that keeps counting while the phone sleeps. The resume
// threshold used to be measured with CACurrentMediaTime(), which is
// mach_absolute_time and STOPS during device sleep: a phone locked for 30
// minutes measured as a few seconds away, so the default tab almost never
// came back. CLOCK_MONOTONIC on Darwin includes sleep and, unlike NSDate,
// can't be moved by DST, NTP or a manual clock change.
static NSTimeInterval GLContinuousSeconds(void) {
    return (NSTimeInterval)clock_gettime_nsec_np(CLOCK_MONOTONIC) / NSEC_PER_SEC;
}

@interface SceneDelegate ()
@property (nonatomic, strong) GLDefaultTabArbiter *gl_defaultTabArbiter;
// CACurrentMediaTime() at the last background, only so the resume debug log
// can show the old clock's reading next to the real one.
@property (nonatomic, assign) CFTimeInterval gl_backgroundedAtMediaTime;
@end

// TEMPORARY — same fire-and-forget server log as AutoJournalViewController's
// journalDebugLog:, duplicated here so URL *arrival* is visible separately
// from the notification handler running. Delete together with the /debug-log
// endpoint once the Control chain is confirmed working.
static void GLSceneDebugLog(NSString *message) {
    // GLEndpointURL raises when GL_BAKED_HOST is unbaked (always true for
    // sim-test's CI build — see SettingsViewController.m), which was
    // crashing the app on every cold launch, before it ever rendered a
    // frame. This is the actual precondition GLEndpointURL checks; guard on
    // it explicitly and return (no @try/@catch — that would also hide a
    // real bug in this code path, which is exactly how this one went
    // unnoticed for months) so the fire-and-forget contract holds without
    // swallowing anything unexpected.
    if (GL_BAKED_HOST.length == 0 || [GL_BAKED_HOST isEqualToString:@"NO_HOST_BAKED_IN"]) {
        NSLog(@"GLSceneDebugLog: inert, GL_BAKED_HOST is unbaked");
        return;
    }
    NSString *encoded = [message stringByAddingPercentEncodingWithAllowedCharacters:
                          [NSCharacterSet URLQueryAllowedCharacterSet]];
    NSURL *url = [NSURL URLWithString:[NSString stringWithFormat:@"?msg=%@", encoded]
                         relativeToURL:GLEndpointURL(@"/debug-log")];
    [[[NSURLSession sharedSession] dataTaskWithURL:url] resume];
}

@implementation SceneDelegate

#pragma mark - First-launch build diagnostic

// Presented from the scene delegate, on the window's root view controller,
// deliberately: the previous build markers all lived inside a custom view and
// none of them were readable on the device. A UIAlertController owns its own
// window-level presentation, so it shows up whether or not the app's own views
// draw anything useful.
- (void)presentBuildDiagnosticIfNeeded:(UIScene *)scene {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *shown = [defaults stringForKey:GLBuildAlertShownStampDefaultsName];
    if ([shown isEqualToString:GL_BUILD_STAMP]) {
        return;
    }

    UIWindowScene *windowScene = (UIWindowScene *)scene;
    UIWindow *window = windowScene.windows.firstObject;
    UIViewController *presenter = window.rootViewController;
    while (presenter.presentedViewController) {
        presenter = presenter.presentedViewController;
    }
    if (presenter == nil) {
        return; // Try again on the next activation, once the scene has a root.
    }

    // build stamp / bundle version / app name are shell-owned facts; the
    // endpoint / token / auth lines are module-owned and sourced through the
    // registry so this file no longer needs to know which module (if any)
    // has network/location state to report.
    NSString *moduleLines = [GLModuleRegistry diagnosticSummary];

    NSString *body = [NSString stringWithFormat:
                      @"build stamp: %@\n"
                      @"bundle version: %@\n"
                      @"app name: %@\n\n"
                      @"%@",
                      GL_BUILD_STAMP,
                      [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleVersion"],
                      [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleDisplayName"],
                      moduleLines];

    NSLog(@"Build diagnostic: %@", [body stringByReplacingOccurrencesOfString:@"\n" withString:@" | "]);

    UIAlertController *alert =
        [UIAlertController alertControllerWithTitle:@"Build Identity"
                                            message:body
                                     preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK"
                                              style:UIAlertActionStyleDefault
                                            handler:nil]];
    [defaults setObject:GL_BUILD_STAMP forKey:GLBuildAlertShownStampDefaultsName];
    [presenter presentViewController:alert animated:YES completion:nil];
}

- (void)sceneDidDisconnect:(UIScene *)scene {
    // Called as the scene is being released by the system.
    // This occurs shortly after the scene enters the background, or when its session is discarded.
    // Release any resources associated with this scene that can be re-created the next time the scene connects.
    // The scene may re-connect later, as its session was not necessarily discarded (see `application:didDiscardSceneSessions` instead).
}


- (void)sceneDidBecomeActive:(UIScene *)scene {
    // Called when the scene has moved from an inactive state to an active state.
    // Use this method to restart any tasks that were paused (or not yet started) when the scene was inactive.

    // Before the UITEST hooks below, so UITEST_TAB still overrides a reset.
    [self gl_applyDefaultTabDecision];

    // Test hook (same pattern as UITEST_ENDPOINT in AppDelegate): let the
    // simulator smoke test select a tab, so CI can screenshot the Settings tab
    // and not just the one the app opens on.
    NSString *tab = [[NSProcessInfo processInfo] environment][@"UITEST_TAB"];
    if(tab != nil) {
        UIViewController *root = self.window.rootViewController;
        if([root isKindOfClass:[UITabBarController class]]) {
            UITabBarController *tabs = (UITabBarController *)root;
            // Cold launch already opened the default tab, and the default
            // (Growth) lives in More, so it sits pushed on the More stack.
            // Pop it so every UITEST_TAB run starts from the bare More page:
            // otherwise "more" screenshots Growth instead of the page, and the
            // UITEST_MORE_TILE_TAP hook below can't reach the page's DOM.
            [tabs.moreNavigationController popToRootViewControllerAnimated:NO];
            // "more" selects the More tab itself rather than a module.
            // Selecting by index can't reach it: an index past the visible
            // tabs opens that module's own screen, never the More screen.
            // That screen is no longer UIKit's list — GLMoreGridViewController
            // replaces it as the root of moreNavigationController (see
            // GLModuleRegistry) — so this is what screenshots the grid.
            if([tab isEqualToString:@"more"]) {
                tabs.selectedViewController = tabs.moreNavigationController;
            } else {
                tabs.selectedIndex = [tab integerValue];
            }
        }
    }

    // Test hook: open one More-grid TILE, by the module's restoration
    // identifier (e.g. "GLModule.AutoJournalModule"), through the same code
    // path a finger does. UITEST_TAB above cannot cover this: it sets
    // `selectedIndex`, which is UIKit's own routing, whereas a tile tap runs
    // the grid's handler — and that handler is where a module wrapping
    // itself in a UINavigationController (Journal) raises if it is pushed
    // rather than selected. Without this, no screenshot test touches the one
    // piece of the More screen that can crash.
    NSString *moreTile = [[NSProcessInfo processInfo] environment][@"UITEST_MORE_TILE"];
    if (moreTile != nil) {
        UIViewController *root = self.window.rootViewController;
        if ([root isKindOfClass:[UITabBarController class]]) {
            UITabBarController *tabs = (UITabBarController *)root;
            // Show the More screen first: the grid only exists once its
            // navigation controller has been taken over, and opening a tile
            // from a different tab would leave the wrong tab selected.
            tabs.selectedViewController = tabs.moreNavigationController;
            // After a turn of the run loop, so the grid's view has loaded and
            // the coordinator has re-planted it as the stack's root.
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{
                BOOL opened = [GLModuleRegistry openMoreTileWithIdentifier:moreTile];
                NSLog(@"UITEST_MORE_TILE %@: %@", moreTile, opened ? @"opened" : @"NO SUCH TILE");
            });
        }
    }

    // Test hook: same target (a More-grid tile's restoration identifier) as
    // UITEST_MORE_TILE above, but tapped THROUGH THE WEB PAGE rather than by
    // calling GLModuleRegistry's open method directly. UITEST_MORE_TILE calls
    // native code and never touches more.html, GLBridge.js, or GLWebBridge's
    // `openModule` handler -- the exact path a real finger tap runs, and the
    // one CI had never exercised (see the Events-tile crash this hook exists
    // to reproduce). A longer delay than UITEST_MORE_TILE's 0.5s: this has to
    // wait for the web page to finish its OWN async load (listModules over
    // the bridge, then a DOM render) before the tile even exists to tap.
    // Test hook: the app opens a URL on itself, which goes through
    // -scene:openURLContexts: like a Control Center OpenURLIntent does.
    // `simctl openurl` can't be used for this: iOS 26 stops it at an
    // "Open in ...?" alert CI can't tap (runs 34770424136, 34771683088).
    NSString *openURLString = [[NSProcessInfo processInfo] environment][@"UITEST_OPEN_URL"];
    if (openURLString != nil) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            [[UIApplication sharedApplication] openURL:[NSURL URLWithString:openURLString]
                                               options:@{}
                                     completionHandler:^(BOOL success) {
                [GLModuleRegistry appendTestLog:[NSString stringWithFormat:
                    @"UITEST_OPEN_URL %@: %@", openURLString, success ? @"opened" : @"FAILED"]];
            }];
        });
        // UITEST_OPEN_URL_TRIGGER_FILE: open the same URL again each time that
        // file appears (it is deleted when consumed). An XCUITest cannot
        // deliver a second URL to the running app (see above: the "Open in
        // ...?" alert), and the journal-swipe-back test needs a SECOND
        // shortcut open after it has swiped Journal away. A trigger the test
        // fires, rather than a repeating timer, so the re-open cannot land
        // while the test is still typing.
        NSString *triggerFile = [[NSProcessInfo processInfo] environment][@"UITEST_OPEN_URL_TRIGGER_FILE"];
        if (triggerFile.length > 0) {
            dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
            dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)),
                                      (uint64_t)(0.5 * NSEC_PER_SEC), NSEC_PER_SEC / 10);
            dispatch_source_set_event_handler(timer, ^{
                if (![[NSFileManager defaultManager] fileExistsAtPath:triggerFile]) return;
                [[NSFileManager defaultManager] removeItemAtPath:triggerFile error:nil];
                [GLModuleRegistry appendTestLog:@"UITEST_OPEN_URL trigger file consumed"];
                // Straight into the router the warm -scene:openURLContexts:
                // calls: a second self-openURL on a running app is not
                // delivered on iOS 26 (observed: no route followed it).
                [GLModuleRegistry routeURL:[NSURL URLWithString:openURLString]];
            });
            dispatch_resume(timer);
            objc_setAssociatedObject(self, "uitestOpenURLTrigger", timer, OBJC_ASSOCIATION_RETAIN);
        }
    }

    NSString *moreTileTap = [[NSProcessInfo processInfo] environment][@"UITEST_MORE_TILE_TAP"];
    if (moreTileTap != nil) {
        UIViewController *root = self.window.rootViewController;
        if ([root isKindOfClass:[UITabBarController class]]) {
            UITabBarController *tabs = (UITabBarController *)root;
            tabs.selectedViewController = tabs.moreNavigationController;
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)),
                           dispatch_get_main_queue(), ^{
                [GLModuleRegistry tapMoreGridTileWithIdentifier:moreTileTap completionHandler:^(BOOL tapped) {
                    NSLog(@"UITEST_MORE_TILE_TAP %@: %@", moreTileTap, tapped ? @"tapped" : @"NO SUCH TILE IN DOM");
                }];
            });
        }
    }

    // Test hook: log the palette keys the More screen's web page actually
    // received via window.GL_BOOT.palette (GLModuleRegistry's
    // +logPaletteKeysReceivedByMoreScreen), so sim-test.yml can assert an
    // injected palette (SIMCTL_CHILD_UITEST_NATIVE_PALETTE) round-tripped
    // intact into the page rather than trusting the env var alone was
    // enough -- see that method's own comment for the class of bug this
    // guards against. `.length > 0` rather than `!= nil`: the workflow sets
    // this unconditionally across both dusk targets (more/journal) and
    // relies on an EMPTY value being equivalent to unset for the
    // journal-only launches, where there is no More-screen web page to read
    // back from.
    NSString *dumpPaletteKeys = [[NSProcessInfo processInfo] environment][@"UITEST_DUMP_PALETTE_KEYS"];
    if (dumpPaletteKeys.length > 0) {
        // Same 2s delay class as the tile hooks above: the More screen's
        // WKWebView only starts loading more.html once UITEST_TAB (above)
        // has made it the selected view controller this same run-loop turn,
        // and more.html's own load() does an async bridge round-trip
        // (listModules) before GL_BOOT is meaningfully readable in the DOM's
        // own terms -- GL_BOOT itself is injected at document-start, but
        // reading it this early just proves the injection path, not that
        // the page survived far enough to matter, so the delay matches the
        // other hooks' margin rather than racing them for no reason.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.0 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            [GLModuleRegistry logPaletteKeysReceivedByMoreScreen];
        });
    }

    // Test hook (same pattern as UITEST_TAB above): simulate the Control
    // Center "start journal capture" path, which XCUITest can't trigger
    // directly since Control Center is outside the app sandbox. Posts the
    // same notification AutoJournalModule +moduleHandleURL: posts when the
    // Control's overland://journal/voice URL arrives, after a short delay so
    // AutoJournalViewController has finished -init (where it registers its
    // observer) and is on-screen. NOTE this deliberately starts from the
    // notification, so it does NOT exercise the Control -> URL -> scene
    // routing hop — see JournalControlUITest.swift's scope comment.
    if([[NSProcessInfo processInfo] environment][@"UITEST_JOURNAL_AUTOSTART"] != nil) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.0 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            [[NSNotificationCenter defaultCenter] postNotificationName:@"GLJournalStartCapture"
                                                                  object:nil];
        });
    }

    // Test hook (same pattern as UITEST_JOURNAL_AUTOSTART above): open
    // Journal's Recent-recordings web page (the Settings/More/Recents
    // web-conversion work), through the exact code -recentTapped runs, by
    // posting the notification AutoJournalViewController's
    // -handleOpenRecentsNotification observes. No tabs/navigation-controller
    // lookup needed here: that handler already selects the Journal tab
    // itself (-selectJournalTab) before pushing, the same self-contained
    // shape as UITEST_JOURNAL_AUTOSTART's own notification post.
    if([[NSProcessInfo processInfo] environment][@"UITEST_JOURNAL_RECENTS"] != nil) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.0 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            [[NSNotificationCenter defaultCenter] postNotificationName:@"GLJournalOpenRecents"
                                                                  object:nil];
        });
    }

    // TEMPORARY baseline signal: proves app-side debug logging works at all
    // on every app open, independent of the Controls. Without this, "zero
    // log lines" can't distinguish "button chain dead" from "logging dead".
    GLSceneDebugLog(@"sceneDidBecomeActive");

    // Slight delay so the root view controller has finished its own
    // presentation work before the diagnostic goes up.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        [self presentBuildDiagnosticIfNeeded:scene];

        // Server-side twin of the alert above: the alert only reaches
        // whoever is looking at the phone right now, which is how a
        // theming bug got verified against the wrong resolved variant for
        // days — nothing about a running install reached the server at
        // all. Same trigger point deliberately, so "did the alert show" and
        // "did the report go out" are always the same launch.
        [GLAppStateReporter report];

        // Same trigger point again, for the OTHER report a running install
        // can carry: if the PREVIOUS launch crashed, GLCrashReporter's
        // uncaught-exception handler persisted a report to disk, and this
        // is where it finally gets sent -- see GLCrashReporter.h for why
        // sending happens here instead of inside the handler itself.
        [GLCrashReporter reportPendingCrashIfAny];
    });
}

// sceneWillEnterForeground / sceneDidEnterBackground / sceneWillResignActive
// used to live here and drove module-specific behavior directly. That work
// moved into whichever module cares, which observes the equivalent
// UISceneWillEnterForegroundNotification / UISceneDidEnterBackgroundNotification
// / UISceneWillDeactivateNotification itself — see the Tracker module's
// app-lifecycle observer for an example.
//
// -sceneDidEnterBackground: and -sceneWillEnterForeground: are back below,
// deliberately, despite the note above: selecting a tab is shell-owned (the
// shell owns the UITabBarController), so "was the app away long enough to
// reset to the default tab" cannot be a module's own notification observer
// the way the paragraph above describes — it has to run here. This is not a
// regression of that removal; don't move it back into a module.
// -sceneWillResignActive: still has nothing to do here and stays out.

#pragma mark - Default tab on resume

// Shared by the cold-launch call site in -scene:willConnectToSession:options:
// below and by -gl_applyDefaultTabDecision here: reads back the outcome
// GLModuleRegistry already applied to `tabs` (its own selectedIndex + the
// view controller's title, which +makeViewControllers already set to
// +moduleTitle) rather than re-deriving which module won, so this file
// doesn't need to know module identities either.
- (void)gl_logDefaultTabOutcome:(BOOL)selected inTabBarController:(UITabBarController *)tabs context:(NSString *)context {
    // A default module in the More overflow (Growth) is opened by pushing it
    // onto the More stack, and with More selected UIKit reports selectedIndex
    // as NSNotFound -- indexing viewControllers with it would crash. Resolve
    // through More's top controller instead; the index logged is the module's
    // position in viewControllers.
    UIViewController *shown = tabs.selectedViewController;
    if (shown == tabs.moreNavigationController) {
        shown = tabs.moreNavigationController.topViewController;
    }
    NSUInteger idx = [tabs.viewControllers indexOfObject:shown];
    NSString *line;
    if (selected) {
        line = [NSString stringWithFormat:@"GLDefaultTab: %@ -> %@ (index %ld)", context, shown.title, (long)idx];
    } else {
        line = [NSString stringWithFormat:@"GLDefaultTab: %@ -> kept current tab (%@, index %ld)", context, shown.title, (long)idx];
    }
    NSLog(@"%@", line);
    GLSceneDebugLog(line);
}

// Outcomes where nothing was selected for a named reason; logs the tab on
// display too, so the box log shows what the user is looking at.
- (void)gl_logDefaultTabSkip:(GLDefaultTabDecision)decision inTabBarController:(UITabBarController *)tabs context:(NSString *)context {
    UIViewController *shown = tabs.selectedViewController;
    if (shown == tabs.moreNavigationController) {
        shown = tabs.moreNavigationController.topViewController;
    }
    NSString *line = [NSString stringWithFormat:@"GLDefaultTab: %@ -> %@ (tab: %@)",
                      context, GLDefaultTabDecisionName(decision), shown.title];
    NSLog(@"%@", line);
    GLSceneDebugLog(line);
}

- (GLDefaultTabArbiter *)gl_defaultTabArbiter {
    if (_gl_defaultTabArbiter == nil) {
        _gl_defaultTabArbiter = [[GLDefaultTabArbiter alloc]
            initWithThresholdSeconds:GLDefaultTabResumeThresholdSeconds()
                     cooldownSeconds:GLDefaultTabCooldownSeconds()
                            defaults:NSUserDefaults.standardUserDefaults
                           wallClock:^NSTimeInterval { return NSDate.timeIntervalSinceReferenceDate; }];
        // sim-test relaunches the same simulator repeatedly; this stops one
        // scenario's persisted selection from suppressing the next one's.
        if ([[NSProcessInfo processInfo] environment][@"UITEST_RESET_DEFAULT_TAB_COOLDOWN"] != nil) {
            [_gl_defaultTabArbiter resetCooldown];
        }
    }
    return _gl_defaultTabArbiter;
}

- (void)sceneDidEnterBackground:(UIScene *)scene {
    self.gl_backgroundedAtMediaTime = CACurrentMediaTime();
    [self.gl_defaultTabArbiter didEnterBackgroundAt:GLContinuousSeconds()
                            explicitNavigationCount:[GLModuleRegistry explicitNavigationCount]];
}

// Only measures the absence. The decision waits for -sceneDidBecomeActive:,
// because a warm lock-screen URL (-scene:openURLContexts:) arrives between
// the two, and the arbiter needs to have seen it. Cold launches also come
// through here, with no background recorded, and the arbiter ignores them.
- (void)sceneWillEnterForeground:(UIScene *)scene {
    CFTimeInterval mediaElapsed = CACurrentMediaTime() - self.gl_backgroundedAtMediaTime;
    [self.gl_defaultTabArbiter willEnterForegroundAt:GLContinuousSeconds()];
    if (self.gl_backgroundedAtMediaTime > 0) {
        GLSceneDebugLog([NSString stringWithFormat:@"resume: away %.0fs (sleep-paused clock said %.0fs)",
                         self.gl_defaultTabArbiter.lastElapsedSeconds, mediaElapsed]);
    }
    self.gl_backgroundedAtMediaTime = 0;
}

- (void)gl_applyDefaultTabDecision {
    UITabBarController *tabs = (UITabBarController *)self.window.rootViewController;
    GLDefaultTabDecision decision = [self.gl_defaultTabArbiter
        takeDecisionWithExplicitNavigationCount:[GLModuleRegistry explicitNavigationCount]
                             currentScreenHolds:[GLModuleRegistry currentScreenHoldsTabOnResumeInTabBarController:tabs]];
    if (decision == GLDefaultTabDecisionNone) return;

    NSString *context = [NSString stringWithFormat:@"resume after %.0fs",
                         self.gl_defaultTabArbiter.lastElapsedSeconds];
    switch (decision) {
        case GLDefaultTabDecisionSelectDefault: {
            BOOL selected = [GLModuleRegistry selectDefaultTabInTabBarController:tabs];
            if (selected) [self.gl_defaultTabArbiter didSelectDefault];
            [self gl_logDefaultTabOutcome:selected inTabBarController:tabs context:context];
            break;
        }
        case GLDefaultTabDecisionKeepCurrent:
            // A quick app-switch: never touch the tab bar at all.
            [self gl_logDefaultTabOutcome:NO inTabBarController:tabs context:context];
            break;
        case GLDefaultTabDecisionExplicitNavigationWins:
        case GLDefaultTabDecisionCurrentTabHolds:
        case GLDefaultTabDecisionRecentlyShownDefault:
        case GLDefaultTabDecisionNone:
            [self gl_logDefaultTabSkip:decision inTabBarController:tabs context:context];
            break;
    }
}

// Warm-app URL delivery. Cold launches do NOT get this callback — their URL
// arrives in connectionOptions.URLContexts inside willConnectToSession
// below; missing that was one of the two bugs that made the lock-screen
// Controls open the app on the default tab.
- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)URLContexts {
    UIOpenURLContext *context = [URLContexts anyObject];
    GLSceneDebugLog([NSString stringWithFormat:@"openURLContexts (warm): %@", context.URL.absoluteString]);
    [GLModuleRegistry routeURL:context.URL];
}

#pragma mark - Modules

// The tab bar is assembled at runtime from every class conforming to GLModule
// (see MODULES.md). The storyboard still owns the Tracker and Settings LAYOUTS
// — its tab bar controller is an empty shell — so adding a tab needs no
// storyboard edit, no central registry and no project.pbxproj entry, and two
// sessions can add tabs at the same time without sharing a file.
- (void)installModules {
    UITabBarController *tabs = (UITabBarController *)self.window.rootViewController;
    if(![tabs isKindOfClass:[UITabBarController class]]) {
        [NSException raise:NSInternalInconsistencyException
                    format:@"Root view controller is %@, not a UITabBarController; "
                           @"Main.storyboard's initial view controller must stay a tab bar controller",
                           tabs.class];
    }
    [GLModuleRegistry installIntoTabBarController:tabs];
}

- (void)gl_windowAppearanceDidChange {
    GLLog(@"SceneDelegate: window appearance changed to %@, re-theming", [GLTheme effectiveModeName]);
    [[NSNotificationCenter defaultCenter] postNotificationName:GLThemeDidChangeNotification object:nil];
}

#pragma mark - Quick Actions

// https://developer.apple.com/documentation/uikit/menus_and_shortcuts/add_home_screen_quick_actions?language=objc
//
// Registering the actual UIApplicationShortcutItem array is module-specific
// and now happens inside whichever module owns it, triggered off its own
// lifecycle notification observer. This file only routes shortcut
// activations to whichever module claims them.

- (void)scene:(UIScene *)scene willConnectToSession:(UISceneSession *)session options:(UISceneConnectionOptions *)connectionOptions {
    // A newly connected scene's window doesn't yet have the persisted
    // appearance override applied — AppDelegate's launch-time call only
    // reaches scenes that already existed at that point (there are none on
    // cold launch), so a scene created after launch needs it applied here.
    [GLTheme applyCurrentMode];
    // Re-theme the chrome now that this scene's window exists, and AFTER
    // +applyCurrentMode has put any override on it. AppDelegate's launch-time
    // call had no window to resolve light/dark against, so on a cold launch it
    // is this call -- not that one -- that first builds the tab/nav bar
    // appearance from the variant actually being rendered. It re-applies
    // directly to the storyboard's already-created bars, so running after
    // they exist is fine (see +applyChromeAppearance).
    [GLTheme applyChromeAppearance];
    // In System mode the device flipping light<->dark (automatic appearance at
    // sunset) changes the effective mode with no GLTheme call at all. Palette
    // colours are static hex, so without this the tab bar and web wrappers
    // stay built from the old variant while the page itself re-themes via CSS.
    [self.window registerForTraitChanges:@[UITraitUserInterfaceStyle.class]
                             withTarget:self
                                 action:@selector(gl_windowAppearanceDidChange)];

    [self installModules];

    NSUInteger navigationsBeforeRouting = [GLModuleRegistry explicitNavigationCount];

    // If the app isn’t already loaded, it’s launched and passes details of the shortcut item in through the connectionOptions parameter of the scene:willConnectToSession:options: function.

    if(connectionOptions.shortcutItem != nil) {
        NSLog(@"App launched. connectionOptions = %@", connectionOptions);
        [GLModuleRegistry routeShortcutItem:connectionOptions.shortcutItem];
    }

    // Cold-launch URL delivery: when a URL launches the app from scratch
    // (the normal lock-screen Control case), iOS does NOT call
    // -scene:openURLContexts: — the URL arrives here instead. Routed after
    // installModules so every module's view controller (and its notification
    // observers, registered in -init) already exists.
    UIOpenURLContext *urlContext = connectionOptions.URLContexts.anyObject;
    GLSceneDebugLog([NSString stringWithFormat:@"willConnect: URLContexts count=%lu URL=%@",
                     (unsigned long)connectionOptions.URLContexts.count,
                     urlContext.URL.absoluteString ?: @"(none)"]);
    if(urlContext != nil) {
        [GLModuleRegistry routeURL:urlContext.URL];
    }

    // Default tab, cold launch: only when no shortcut or URL above claimed
    // the launch. It used to run first and let the deep link override it,
    // but both then animated pushes onto the same More stack in one run-loop
    // turn, and the default could end up on top. UITEST_TAB in
    // -sceneDidBecomeActive runs later still and overrides either.
    UITabBarController *tabs = (UITabBarController *)self.window.rootViewController;
    if ([GLModuleRegistry explicitNavigationCount] != navigationsBeforeRouting) {
        NSLog(@"GLDefaultTab: cold launch -> explicit navigation wins");
        GLSceneDebugLog(@"GLDefaultTab: cold launch -> explicit navigation wins");
    } else if ([self.gl_defaultTabArbiter defaultShownRecently]) {
        // Inside the cooldown: leave whatever tab the tab bar starts on (the
        // first module by +moduleOrder; the storyboard sets no selectedIndex).
        [self gl_logDefaultTabSkip:GLDefaultTabDecisionRecentlyShownDefault inTabBarController:tabs context:@"cold launch"];
    } else {
        BOOL selected = [GLModuleRegistry selectDefaultTabInTabBarController:tabs];
        if (selected) [self.gl_defaultTabArbiter didSelectDefault];
        [self gl_logDefaultTabOutcome:selected inTabBarController:tabs context:@"cold launch"];
    }
}

- (void)windowScene:(UIWindowScene *)windowScene performActionForShortcutItem:(UIApplicationShortcutItem *)shortcutItem completionHandler:(void (^)(BOOL))completionHandler {
    // If your app is already loaded, the system calls the windowScene:performActionForShortcutItem:completionHandler: function of your scene delegate.
    NSLog(@"Quick Action requested when app already loaded");
    NSLog(@"shortcutItem = %@", shortcutItem);

    [GLModuleRegistry routeShortcutItem:shortcutItem];
}

@end
