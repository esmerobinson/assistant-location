#import "ListenAppDelegate.h"

#import "ListenViewController.h"

// No scene manifest: a single-window app, so the app delegate owns the window.
@implementation ListenAppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    self.window.rootViewController = [[ListenViewController alloc] init];
    [self.window makeKeyAndVisible];
    return YES;
}

// <bundle id>://practice, opened by the lock-screen Practice Control (ListenControl/PracticeIntent.swift). The scheme is
// the bundle id (Info.plist CFBundleURLSchemes) so the guest copy, a second app on the same phone, never answers the
// personal app's shortcut. With no scene manifest, a cold launch from the URL also arrives here after
// didFinishLaunching (which returned YES), so this is the one entry point.
- (BOOL)application:(UIApplication *)app openURL:(NSURL *)url options:(NSDictionary *)options {
    if (![url.host isEqual:@"practice"]) return NO;
    [(ListenViewController *)self.window.rootViewController openPracticeFromShortcut];
    return YES;
}

@end
