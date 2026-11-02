#import "AutoJournalModule.h"

#import "AutoJournalViewController.h"
#import "GLModuleRegistry.h"

@implementation AutoJournalModule

// Registers this module with GLModuleRegistry as the runtime loads this
// class, before main() runs. See GLModuleRegistry.m and MODULES.md — every
// GLModule conformer needs this exact +load or it silently never gets a tab.
+ (void)load {
    [GLModuleRegistry registerModule:self];
}

+ (NSString *)moduleTitle { return @"Journal"; }

+ (UIImage *)moduleIcon { return [UIImage systemImageNamed:@"mic.circle.fill"]; }

// 620 (was 250): fourth of the five More-grid overflow modules, landing
// Journal on the bottom row next to Events -- the two modules Oliver
// reaches for most, so they get the easiest one-handed thumb reach. See
// MODULES.md's order list and more.html's DEFAULT_ORDER for the full
// sequence this must stay in sync with.
+ (NSInteger)moduleOrder { return 620; }

// Recording continues with the phone locked (UIBackgroundModes audio), so
// coming back to Journal after a long absence must not jump to the default tab.
+ (BOOL)moduleHoldsTabOnResume { return YES; }

+ (UIViewController *)makeViewController {
    // Plain view controller, like every other module: Journal is a More
    // overflow module, so it is pushed onto the shared More stack, and its
    // "Recent" screen is pushed onto that same stack. Wrapping it in its own
    // UINavigationController makes UIKit move the wrapper's children onto the
    // More stack and leave the wrapper empty, which is what crashed reopening.
    return [[AutoJournalViewController alloc] init];
}

// Entry point for the lock-screen Controls, replacing the previous
// NotificationCenter handoff from JournalIntent.swift's perform().
//
// That old design assumed openAppWhenRun=true makes perform() run inside the
// APP's process, so a plain NSNotification would reach
// AutoJournalViewController. It does not: perform() runs in the WIDGET
// EXTENSION's process, so the notification was posted into the extension and
// the app never heard it. openAppWhenRun only launches the app — which is
// exactly the observed symptom (app opens to whatever tab it was on, nothing
// records). Proven by instrumenting the handler with a server-side log call
// (see AutoJournalViewController's journalDebugLog:) and confirming, against
// a binary verified to contain that code, that it never fired once.
//
// A URL is the cross-process channel that actually works here, with no App
// Group entitlement (deliberately dropped — see JournalIntent.swift): iOS
// delivers it to SceneDelegate's -scene:openURLContexts:, which is already
// wired to GLModuleRegistry routeURL: -> this method, all inside the app.
// Posting the notification from here means the existing observers in
// AutoJournalViewController -init run in the right process.
+ (BOOL)moduleHandleURL:(NSURL *)url {
    if (![url.scheme isEqualToString:@"overland"]) return NO;
    // Match on the full "journal/<mode>" shape rather than the path alone:
    // for overland://journal/voice the host is "journal" and the path is
    // "/voice", so testing only one of them silently misses.
    if (![url.host isEqualToString:@"journal"]) return NO;

    NSString *mode = [url.path stringByReplacingOccurrencesOfString:@"/" withString:@""];
    NSString *name = nil;
    if ([mode isEqualToString:@"voice"]) {
        name = @"GLJournalStartCapture";
    } else if ([mode isEqualToString:@"text"]) {
        name = @"GLJournalStartTextEntry";
    } else {
        return NO;
    }
    [[NSNotificationCenter defaultCenter] postNotificationName:name object:nil];
    return YES;
}

@end
