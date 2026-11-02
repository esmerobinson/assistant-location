#import "GLModuleRegistry.h"
#import "GLMoreStackRepair.h"
#import "GLTabDoubleTap.h"
#import "GLCrashReporter.h"
#import "GLTheme.h"
#import "GLWebModuleViewController.h"

#pragma mark - The More stack

// UITabBarController shows at most five tabs and pushes everything past the
// fourth into a "More" bucket: a navigation controller whose root is a plain
// table list UIKit builds and owns. That list was the worst-looking screen in
// the app — rows crammed against the tab bar with the last one clipped by it,
// two thirds of the screen empty above them, a surface-coloured slab against
// a differently-coloured page, and a stray "Edit" button for customising a
// tab order nothing else here honours. An earlier pass tried to restyle it
// from this file; it could not be made good, because UIKit rebuilds the
// table's cells on every appearance and the layout was never ours to choose.
// A second pass replaced it with GLMoreGridViewController, a native grid --
// still not restyling UIKit's list, but still a native screen.
//
// It is now a THIRD screen: a GLWebModuleViewController wrapping the bundled
// "more.html" page becomes the root of moreNavigationController, and neither
// the system list nor GLMoreGridViewController ever appears (that class'
// files stay in the tree, unused, for now). The tap/drag/reorder behaviour
// that used to live in GLMoreGridViewController now lives in more.html +
// GLWebBridge; this file's job shrinks to holding the ROOT in place across
// UIKit's own list-resets and to the identifier -> view-controller lookup
// +openOverflowModuleWithIdentifier: below runs for both the web page's
// `openModule` bridge call and the UITEST_MORE_TILE test hook.
//
// Replacing only the ROOT — rather than restructuring the tab bar so the
// grid is a fifth tab of its own — is deliberate. Every module keeps the tab
// INDEX it has today, so SceneDelegate's UITEST_TAB hook, sim-test's
// TAB_ENTRIES, AutoJournal's -selectJournalTab (which finds itself by index
// in tabs.viewControllers) and the module view controllers' own structure
// all keep working untouched. A tile "open" goes onto
// exactly the navigation controller UIKit would have pushed onto anyway.
// One-line snapshot of the More stack, logged as "GLMoreNavState <tag>: ..."
// so a simulator run (UITEST_STATE_LOG) can show what UIKit did to the stack.
static NSString *GLDescribeVCs(NSArray<UIViewController *> *vcs) {
    NSMutableArray *names = [NSMutableArray array];
    for (UIViewController *vc in vcs) {
        [names addObject:[NSString stringWithFormat:@"%@<%p>", NSStringFromClass(vc.class), vc]];
    }
    return [NSString stringWithFormat:@"[%@]", [names componentsJoinedByString:@", "]];
}

static void GLLogMoreNavState(NSString *tag, UINavigationController *moreNav) {
    UIViewController *selected = moreNav.tabBarController.selectedViewController;
    [GLModuleRegistry appendTestLog:[NSString stringWithFormat:
        @"GLMoreNavState %@: selected=%@<%p> moreNav.viewControllers=%@", tag,
        NSStringFromClass(selected.class), selected, GLDescribeVCs(moreNav.viewControllers)]];
}

@interface GLMoreStackCoordinator : NSObject <UINavigationControllerDelegate, UIGestureRecognizerDelegate>
@property (nonatomic, strong) GLWebModuleViewController *root;
@property (nonatomic, strong) NSArray<UIViewController *> *overflowModules;
@property (nonatomic, weak) UINavigationController *moreNav;
- (void)takeOverNavigationController:(UINavigationController *)navigationController;
@end

@implementation GLMoreStackCoordinator

- (void)takeOverNavigationController:(UINavigationController *)navigationController {
    self.moreNav = navigationController;
    navigationController.delegate = self;
    // Always hidden, on every screen in this stack. The web root draws its
    // own "More" heading, and a module reached from here must look exactly
    // like a module reached from a tab — which has no navigation controller
    // at all, and so no bar. The user, on the old behaviour: "there's an
    // extra header at the top with a back button. That shouldn't happen.
    // It's like with any of the other tabs."
    //
    // Two ways back to the root survive the hidden bar: tapping the
    // already-selected More tab pops this navigation controller to its root
    // (UITabBarController's standard behaviour for any nav controller in a
    // tab), and the left-edge swipe still works because we take over
    // interactivePopGestureRecognizer's delegate below — UIKit otherwise
    // disables that gesture whenever the bar is hidden.
    navigationController.navigationBarHidden = YES;
    navigationController.interactivePopGestureRecognizer.delegate = self;
    [self installRootIfNeeded];
}

// UIKit builds its own list lazily, and rebuilds it whenever it decides the
// More stack needs resetting — notably when someone sets `selectedIndex` to
// an index past the visible tabs, which replaces the whole stack with
// [systemList, targetModule]. So planting the root once at launch is not
// enough; this re-plants it as the root whenever UIKit has put its list
// back, and is called from both navigation callbacks below. Any module
// already pushed on top is preserved, so a reset mid-navigation does not
// throw the user back to the More page.
- (void)installRootIfNeeded {
    UINavigationController *nav = self.moreNav;
    if (nav == nil || self.root == nil) return;
    NSArray<UIViewController *> *stack = nav.viewControllers;
    // GLMoreStackWithRoot also drops a second copy of root -- see its header
    // for the [list, root, Journal] shape that used to crash here.
    NSArray<UIViewController *> *replacement = GLMoreStackWithRoot(stack, self.root);
    if ([replacement isEqualToArray:stack]) return;
    [GLCrashReporter addBreadcrumb:[NSString stringWithFormat:
        @"installRootIfNeeded: repaired More stack of %lu", (unsigned long)stack.count]];
    [nav setViewControllers:replacement animated:NO];
}

- (BOOL)gestureRecognizerShouldBegin:(UIGestureRecognizer *)gestureRecognizer {
    if (gestureRecognizer != self.moreNav.interactivePopGestureRecognizer) {
        return YES;
    }
    // Never YES on a single-controller stack — that is the classic way to
    // wedge a navigation controller into an unrecoverable state.
    return self.moreNav.viewControllers.count > 1;
}

- (void)navigationController:(UINavigationController *)navigationController
       willShowViewController:(UIViewController *)viewController
                     animated:(BOOL)animated {
    // Re-asserted rather than trusted: UIKit re-shows its own bar as part of
    // the same stack reset that re-inserts the system list.
    if (!navigationController.navigationBarHidden) {
        [navigationController setNavigationBarHidden:YES animated:animated];
    }
    // Re-asserted here for a different reason: at -takeOverNavigationController:
    // time this navigation controller's view has not loaded yet, and
    // `interactivePopGestureRecognizer` is nullable until it has — so the
    // assignment there lands on nil and the back-swipe stays dead. (The
    // deleted GLMoreListThemer re-asserted on every willShow, which is why
    // it worked before.) Assigning the same delegate repeatedly is a no-op.
    navigationController.interactivePopGestureRecognizer.delegate = self;
    // Deliberately NOT re-planting the root here: -installRootIfNeeded calls
    // -setViewControllers:, and mutating a navigation stack part-way through
    // its own push transition is how you get UIKit into an inconsistent
    // state. -didShow: below runs after the transition and is enough,
    // because the only thing that resets this stack (setting selectedIndex
    // past the visible tabs) always pushes a module on top — so UIKit's list
    // sits at index 0, off-screen, and is swapped out before it can ever be
    // seen.
}

- (void)navigationController:(UINavigationController *)navigationController
        didShowViewController:(UIViewController *)viewController
                      animated:(BOOL)animated {
    GLLogMoreNavState(@"didShow-before-repair", navigationController);
    [self installRootIfNeeded];
    GLLogMoreNavState(@"didShow-after-repair", navigationController);
}

@end

// File-scope rather than a static local inside +installIntoTabBarController:,
// so +openMoreTileWithIdentifier: below can reach the same instance. A
// UINavigationController's `delegate` is weak, so this reference is also
// what keeps the coordinator alive for the process's lifetime.
static GLMoreStackCoordinator *moreCoordinator;

// The tab bar +installIntoTabBarController: filled, so +showModuleWithIdentifier:
// needs no view-controller context from its caller. Weak: the window owns it.
static __weak UITabBarController *installedTabs;

// Bumped by every explicit navigation (see +explicitNavigationCount).
static NSUInteger explicitNavigationCount;

#pragma mark - Tab selection fan-out

// UITabBarControllerDelegate's -tabBarController:didSelectViewController:
// fires on every tap of a tab bar item, INCLUDING re-tapping the tab that
// is already selected (unlike KVO on `selectedViewController`, which only
// fires on an actual change) -- exactly the public-API signal a module
// needs to detect a double-tap without a private-view gesture recognizer.
// This coordinator is the one and only tabs.delegate in the app (see
// +installIntoTabBarController: below -- nothing else in this repo sets
// it), and fans each selection out to whichever module class owns the
// selected view controller.
@interface GLTabSelectionCoordinator : NSObject <UITabBarControllerDelegate>
@property (nonatomic, weak) UITabBarController *tabs;
// Both set together at install time, index-paired exactly like the
// `classes[i]`/`controllers[i]` pairing +installIntoTabBarController: below
// already relies on for the moduleDidInstallTabBarItemForViewController:
// fan-out -- `controllers[i]` is the view controller `classes[i]` owns.
@property (nonatomic, strong) NSArray<UIViewController *> *controllers;
@property (nonatomic, strong) NSArray *classes;
@property (nonatomic, strong) GLTabDoubleTap *doubleTap;
@end

@implementation GLTabSelectionCoordinator

- (void)tabBarController:(UITabBarController *)tabBarController
    didSelectViewController:(UIViewController *)viewController {
    NSUInteger index = [self.controllers indexOfObject:viewController];
    if (index == NSNotFound) return;
    Class module = self.classes[index];
    // A module that handles its own taps owns its double-tap too (Todos'
    // double-tap opens Add Todo); every other tab's double-tap goes home.
    if ([module respondsToSelector:@selector(moduleTabWasSelectedForViewController:inTabBarController:)]) {
        [module moduleTabWasSelectedForViewController:viewController inTabBarController:tabBarController];
        return;
    }
    if (!self.doubleTap) self.doubleTap = [[GLTabDoubleTap alloc] initWithWindow:0.4];
    if (![self.doubleTap registerTapOn:viewController atTime:CACurrentMediaTime()]) return;
    [self goHomeInViewController:viewController];
}

// Home is the tab's root screen showing its page's start URL: pop any pushed
// screens, then reload the root page.
- (void)goHomeInViewController:(UIViewController *)viewController {
    UIViewController *root = viewController;
    if ([viewController isKindOfClass:[UINavigationController class]]) {
        UINavigationController *nav = (UINavigationController *)viewController;
        [nav popToRootViewControllerAnimated:NO];
        root = nav.viewControllers.firstObject;
    }
    NSLog(@"GLTabSelectionCoordinator: double-tap on %@ -> home", NSStringFromClass(root.class));
    if ([root isKindOfClass:[GLWebModuleViewController class]]) {
        [(GLWebModuleViewController *)root goHome];
    }
}

@end

// Same file-scope-static-keeps-it-alive reasoning as moreCoordinator above --
// UITabBarController's `delegate` is weak too.
static GLTabSelectionCoordinator *tabSelectionCoordinator;


@interface GLModuleRegistry ()
+ (BOOL)gl_presentViewController:(UIViewController *)vc inTabBarController:(UITabBarController *)tabs;
@end

@implementation GLModuleRegistry

// Backing store for +registerModule:. A function-local static rather than a
// class-level static/ivar on purpose: +load runs during image loading, before
// main(), in an order that is undefined across classes — GLModuleRegistry's
// own +load (it has none) is not guaranteed to run before a module's +load
// fires +registerModule:. A function-local static inside a C function is
// created lazily on first call regardless of which class triggers it first,
// so there is no dependency on GLModuleRegistry having initialized anything.
static NSMutableArray *GLRegisteredModules(void) {
    static NSMutableArray *modules;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        modules = [NSMutableArray array];
    });
    return modules;
}

+ (void)registerModule:(Class)module {
    [GLRegisteredModules() addObject:module];
}

+ (NSArray *)moduleClasses {
    // Modules used to be found by walking every class in the process
    // (objc_copyClassList) and keeping the ones that conform to GLModule.
    // That walk *realizes* every class it touches — UIKit, Foundation,
    // AFNetworking, all of it — just to ask whether each one conforms to a
    // protocol, and profiling showed it was 1,443ms of a 3,255ms cold launch,
    // the single largest phase in the app. Modules now self-register from
    // their own +load instead (see +registerModule: and GLRegisteredModules
    // above), so this only ever sorts a small, already-known list.
    //
    // +load runs for every module class before main() runs, and the first
    // call to +moduleClasses happens from didFinishLaunchingWithOptions: (via
    // SceneDelegate/AppDelegate), which is always after main() — so by the
    // time this dispatch_once body runs, every module's +load has already
    // registered it. Caching here is still safe for the same reason it was
    // before: module membership can't change after launch.
    static NSArray *cachedModules;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSArray *registered = GLRegisteredModules();
        if (registered.count == 0) {
            [NSException raise:NSInternalInconsistencyException
                        format:@"GLModuleRegistry has no registered modules — "
                                "a GLModule conformer is likely missing its "
                                "+load self-registration (see MODULES.md)"];
        }

        // Order is part of the contract: two sessions that independently
        // pick the same +moduleOrder must still produce the same tab bar on
        // every launch, so class name is the tiebreak rather than +load
        // registration order (which, across classes, is undefined).
        NSArray *sorted = [registered sortedArrayUsingComparator:^NSComparisonResult(id a, id b) {
            NSInteger orderA = [(Class)a moduleOrder];
            NSInteger orderB = [(Class)b moduleOrder];
            if (orderA != orderB) {
                return orderA < orderB ? NSOrderedAscending : NSOrderedDescending;
            }
            return [NSStringFromClass((Class)a) compare:NSStringFromClass((Class)b)];
        }];
        cachedModules = [sorted copy];
    });
    return cachedModules;
}

+ (NSArray<UIViewController *> *)makeViewControllers {
    NSMutableArray<UIViewController *> *controllers = [NSMutableArray array];
    for (Class module in [self moduleClasses]) {
        UIViewController *vc = [module makeViewController];
        if (vc == nil) {
            [NSException raise:NSInternalInconsistencyException
                        format:@"%@ +makeViewController returned nil", module];
        }
        vc.title = [module moduleTitle];
        vc.tabBarItem = [[UITabBarItem alloc] initWithTitle:[module moduleTitle]
                                                      image:[module moduleIcon]
                                                        tag:0];
        // Index-independent identity, for anything that needs to find a tab.
        vc.restorationIdentifier =
            [NSString stringWithFormat:@"GLModule.%@", NSStringFromClass(module)];
        [controllers addObject:vc];
    }
    return controllers;
}

+ (void)installIntoTabBarController:(UITabBarController *)tabs {
    NSArray<UIViewController *> *controllers = [self makeViewControllers];
    tabs.viewControllers = controllers;
    installedTabs = tabs;

    // Anything past the fourth module is in UIKit's More bucket. Five is
    // UITabBarController's own limit on iPhone (four real tabs plus the
    // "More" item), so this is the split UIKit has already made by the time
    // the line above returns — not a preference of ours. With four modules
    // or fewer there is no bucket and nothing to replace.
    NSUInteger const visibleTabCount = 4;
    if (controllers.count > visibleTabCount + 1) {
        NSArray<UIViewController *> *overflow =
            [controllers subarrayWithRange:NSMakeRange(visibleTabCount,
                                                       controllers.count - visibleTabCount)];

        // A UINavigationController's `delegate` is weak, so a coordinator
        // created and dropped here would be deallocated before the user ever
        // taps More. Keep one alive for the process's lifetime, same
        // dispatch_once pattern as GLRegisteredModules above.
        static dispatch_once_t coordinatorOnceToken;
        dispatch_once(&coordinatorOnceToken, ^{
            moreCoordinator = [[GLMoreStackCoordinator alloc] init];
        });
        moreCoordinator.overflowModules = overflow;
        // Managed, not merely bundled, as of the web-page asset-update task:
        // the bundle copy is still the offline floor, but a server-side
        // edit to more.html/page.css/gl-bridge.js now reaches this tab
        // through the normal ~2-minute deploy instead of needing a full OTA
        // rebuild. See Shared/GLWebPageCache.h.
        moreCoordinator.root =
            [[GLWebModuleViewController alloc] initWithManagedPageNamed:@"more.html"];

        // UIKit is documented to supply its own tab bar item for the More
        // tab (title "More" plus a system-drawn icon) -- logged here rather
        // than assumed, because on iOS 26 that icon is coming through blank
        // (the title still renders). Whatever the cause, the fix is the same
        // as any other module's: give it a real UITabBarItem so the themed
        // tint (applied globally via UITabBar.appearance, see GLTheme.m)
        // picks it up exactly like the four visible tabs do.
        UITabBarItem *existingItem = tabs.moreNavigationController.tabBarItem;
        NSLog(@"Module registry: system More tabBarItem before fix -- "
              "title=%@ image=%@ same-object-as-root=%d",
              existingItem.title, existingItem.image,
              existingItem == moreCoordinator.root.tabBarItem);
        tabs.moreNavigationController.tabBarItem =
            [[UITabBarItem alloc] initWithTitle:@"More"
                                          image:[UIImage systemImageNamed:@"ellipsis"]
                                            tag:0];

        [moreCoordinator takeOverNavigationController:tabs.moreNavigationController];

        NSMutableArray<NSString *> *tileTitles = [NSMutableArray array];
        for (UIViewController *vc in overflow) [tileTitles addObject:vc.title];
        NSLog(@"Module registry: More page holds %lu tiles: %@",
              (unsigned long)overflow.count, [tileTitles componentsJoinedByString:@", "]);
    }

    NSMutableArray<NSString *> *titles = [NSMutableArray array];
    for (UIViewController *vc in controllers) {
        [titles addObject:vc.title];
    }
    NSLog(@"Module registry: installed %lu tabs: %@",
          (unsigned long)controllers.count, [titles componentsJoinedByString:@", "]);

    // Force the tab bar to build its button subviews now rather than on the
    // next layout pass — a module's optional hook below (Todos') needs to
    // walk `tabs.tabBar.subviews` to find its own button, and that array is
    // empty until the tab bar has laid out at least once after `items`
    // changes.
    [tabs.tabBar setNeedsLayout];
    [tabs.tabBar layoutIfNeeded];

    // Same +moduleClasses/+makeViewControllers pairing +selectDefaultTabInTabBarController:
    // below relies on: index N of `classes` made view controller N of
    // `controllers`, so this can hand each module back its OWN view
    // controller without the module having to re-derive which one is
    // "theirs" from the tab bar itself.
    NSArray *classes = [self moduleClasses];

    // Nothing else in this repo sets tabs.delegate -- this slot is free.
    // Installed here, alongside the per-module fan-out below, since both
    // need the same classes[i]/controllers[i] pairing.
    static dispatch_once_t tabSelectionOnceToken;
    dispatch_once(&tabSelectionOnceToken, ^{
        tabSelectionCoordinator = [[GLTabSelectionCoordinator alloc] init];
    });
    tabSelectionCoordinator.tabs = tabs;
    tabSelectionCoordinator.controllers = controllers;
    tabSelectionCoordinator.classes = classes;
    tabs.delegate = tabSelectionCoordinator;

    for (NSUInteger i = 0; i < classes.count; i++) {
        Class module = classes[i];
        if ([module respondsToSelector:@selector(moduleDidInstallTabBarItemForViewController:inTabBarController:)]) {
            [module moduleDidInstallTabBarItemForViewController:controllers[i] inTabBarController:tabs];
        }
    }
}

#pragma mark - Optional-hook fan-out
//
// All three of these walk the same +moduleClasses list makeViewControllers
// uses above — one discovery/sort implementation, several fan-outs over it.
// Every call is guarded with respondsToSelector: since the hooks are
// @optional in GLModule.h.

+ (void)notifyModulesDidFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    NSMutableArray<NSString *> *responded = [NSMutableArray array];
    for (Class module in [self moduleClasses]) {
        if ([module respondsToSelector:@selector(moduleDidFinishLaunchingWithOptions:)]) {
            [module moduleDidFinishLaunchingWithOptions:launchOptions];
            [responded addObject:NSStringFromClass(module)];
        }
    }
    // Liveness signal for the launch fan-out, mirroring the installed-tabs
    // log line below: if a module's hook were ever renamed out from under
    // this selector, launch setup, URL/activity/shortcut routing and the
    // diagnostic would all silently stop firing while the tab still
    // appeared. CI asserts on this line the same way it asserts on the
    // installed-tabs line.
    NSLog(@"Module registry: launch hooks fired for %lu modules: %@",
          (unsigned long)responded.count, [responded componentsJoinedByString:@", "]);
}

+ (BOOL)routeURL:(NSURL *)url {
    for (Class module in [self moduleClasses]) {
        if ([module respondsToSelector:@selector(moduleHandleURL:)] &&
            [module moduleHandleURL:url]) {
            explicitNavigationCount++;
            return YES;
        }
    }
    return NO;
}

+ (BOOL)routeUserActivity:(NSUserActivity *)activity {
    for (Class module in [self moduleClasses]) {
        if ([module respondsToSelector:@selector(moduleHandleUserActivity:)] &&
            [module moduleHandleUserActivity:activity]) {
            explicitNavigationCount++;
            return YES;
        }
    }
    return NO;
}

+ (BOOL)routeShortcutItem:(UIApplicationShortcutItem *)item {
    for (Class module in [self moduleClasses]) {
        if ([module respondsToSelector:@selector(moduleHandleShortcutItem:)] &&
            [module moduleHandleShortcutItem:item]) {
            explicitNavigationCount++;
            return YES;
        }
    }
    NSLog(@"Module registry: no module claimed shortcut item type=%@", item.type);
    return NO;
}

+ (NSString *)diagnosticSummary {
    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    for (Class module in [self moduleClasses]) {
        if ([module respondsToSelector:@selector(moduleDiagnosticSummary)]) {
            NSString *summary = [module moduleDiagnosticSummary];
            if (summary.length > 0) {
                [lines addObject:summary];
            }
        }
    }
    return [lines componentsJoinedByString:@"\n"];
}

#pragma mark - Default tab

+ (BOOL)selectDefaultTabInTabBarController:(UITabBarController *)tabs {
    NSArray *modules = [self moduleClasses];
    NSArray<UIViewController *> *controllers = tabs.viewControllers;
    NSUInteger index = 0;
    for (Class module in modules) {
        if ([module respondsToSelector:@selector(moduleIsDefaultTab)] &&
            [module moduleIsDefaultTab]) {
            // module index N == view-controller index N: +makeViewControllers
            // builds exactly one controller per entry of +moduleClasses, in
            // the same order (see its implementation above). Guarded rather
            // than trusted blindly, so a future refactor that breaks that
            // invariant fails loudly here instead of indexing out of bounds.
            if (index >= controllers.count) {
                [NSException raise:NSInternalInconsistencyException
                            format:@"%@ opted into +moduleIsDefaultTab at module "
                                    "index %lu, but tabs.viewControllers only has "
                                    "%lu entries",
                                    module, (unsigned long)index,
                                    (unsigned long)controllers.count];
            }
            // A module in the More overflow has no tab of its own, and
            // selectedIndex past the visible tabs would show UIKit's More
            // bucket rather than the module. Open it the same way a More tile
            // tap does: select More, push the module onto its stack. This is
            // what lets a More-bucket module be the default tab.
            // Not +showModuleWithIdentifier: -- the default tab is the one
            // navigation that must NOT count as explicit.
            [self gl_presentViewController:controllers[index] inTabBarController:tabs];
            NSLog(@"Module registry: default tab -> %@ (index %lu)",
                  [module moduleTitle], (unsigned long)index);
            return YES;
        }
        index++;
    }
    return NO;
}

#pragma mark - App-lifecycle fan-out

+ (void)startObservingAppLifecycle {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];

        [nc addObserverForName:UISceneDidEnterBackgroundNotification
                         object:nil
                          queue:nil
                     usingBlock:^(NSNotification *note) {
            for (Class module in [self moduleClasses]) {
                if ([module respondsToSelector:@selector(moduleDidEnterBackground)]) {
                    [module moduleDidEnterBackground];
                }
            }
        }];

        [nc addObserverForName:UISceneWillEnterForegroundNotification
                         object:nil
                          queue:nil
                     usingBlock:^(NSNotification *note) {
            for (Class module in [self moduleClasses]) {
                if ([module respondsToSelector:@selector(moduleWillEnterForeground)]) {
                    [module moduleWillEnterForeground];
                }
            }
        }];

        [nc addObserverForName:UISceneWillDeactivateNotification
                         object:nil
                          queue:nil
                     usingBlock:^(NSNotification *note) {
            for (Class module in [self moduleClasses]) {
                if ([module respondsToSelector:@selector(moduleWillResignActive)]) {
                    [module moduleWillResignActive];
                }
            }
        }];
    });
}


#pragma mark - The More overflow: shared identifier lookup + open logic

// The exact logic GLMoreGridViewController's own -openModuleViewController:
// used to run for a tile tap, moved here now that the More screen's root is
// a web page rather than that grid, and defined FIRST in this section (ahead
// of its only caller, +openOverflowModuleWithIdentifier: below) purely so
// this file never needs a forward declaration for it -- Objective-C
// resolves an undeclared selector against implementations already parsed
// earlier in the same @implementation, not ones still to come.
// +openOverflowModuleWithIdentifier: is itself reached from TWO places --
// GLWebBridge's `openModule` handler and +openMoreTileWithIdentifier: below
// -- which is exactly why the select-vs-push decision lives here as one
// paragraph instead of being copied into both.
//
// Every overflow module is a plain view controller pushed on the More stack
// (a module must never wrap itself in a UINavigationController: UIKit moves a
// More-overflow nav controller's children onto the More stack and leaves the
// wrapper empty; scripts/check_module_nav_wrappers.sh enforces this).
+ (BOOL)openModuleViewController:(nullable UIViewController *)module
         ontoNavigationController:(nullable UINavigationController *)navigationController {
    if (module == nil) {
        [GLCrashReporter addBreadcrumb:@"openModuleViewController: module is nil"];
        return NO;
    }
    if (navigationController == nil) {
        [GLCrashReporter addBreadcrumb:[NSString stringWithFormat:
            @"openModuleViewController: push branch, module=%@, but navigationController is nil",
            NSStringFromClass(module.class)]];
        return NO;
    }
    // Idempotent open: "open module X" means X ends up on top of this
    // navigation stack, not "push a new instance of X". Pushing an instance
    // already in navigationController.viewControllers raises
    // NSInvalidArgumentException ("is pushing the same view controller
    // instance ... more than once"), which is exactly what happened when a
    // single real finger tap produced two openModule dispatches (see
    // more.html's touchend/click double-fire fix) and the second dispatch
    // hit this method while the first one's push was still the top view
    // controller.
    if (navigationController.topViewController == module) {
        [GLCrashReporter addBreadcrumb:[NSString stringWithFormat:
            @"openModuleViewController: push branch, module=%@, already on top -- no-op",
            NSStringFromClass(module.class)]];
        return YES;
    }
    if ([navigationController.viewControllers containsObject:module]) {
        [GLCrashReporter addBreadcrumb:[NSString stringWithFormat:
            @"openModuleViewController: push branch, module=%@, already in stack -- popping to it",
            NSStringFromClass(module.class)]];
        [navigationController popToViewController:module animated:YES];
        return YES;
    }
    [GLCrashReporter addBreadcrumb:[NSString stringWithFormat:
        @"openModuleViewController: push branch, module=%@", NSStringFromClass(module.class)]];
    [navigationController pushViewController:module animated:YES];
    return YES;
}

+ (NSArray<NSDictionary<NSString *, NSString *> *> *)overflowModuleDescriptors {
    NSMutableArray<NSDictionary<NSString *, NSString *> *> *descriptors = [NSMutableArray array];
    for (UIViewController *vc in moreCoordinator.overflowModules) {
        [descriptors addObject:@{
            @"identifier": vc.restorationIdentifier ?: @"",
            @"title": vc.title ?: @"",
        }];
    }
    return descriptors;
}

+ (BOOL)openOverflowModuleWithIdentifier:(NSString *)identifier {
    // Entry/exit breadcrumbs (see GLCrashReporter.h): this is the method
    // both GLWebBridge's `openModule` handler and the UITEST_MORE_TILE test
    // hook call, so an entry with no matching exit in a crash report's
    // breadcrumb trail means the crash happened somewhere INSIDE this call
    // -- most likely inside +openModuleViewController:ontoNavigationController:,
    // which logs its own branch separately below.
    [GLCrashReporter addBreadcrumb:[NSString stringWithFormat:
        @"openOverflowModuleWithIdentifier enter id=%@", identifier ?: @"(nil)"]];
    if (identifier.length == 0) {
        [GLCrashReporter addBreadcrumb:@"openOverflowModuleWithIdentifier exit: empty identifier"];
        return NO;
    }
    UIViewController *target = nil;
    for (UIViewController *vc in moreCoordinator.overflowModules) {
        if ([vc.restorationIdentifier isEqualToString:identifier]) {
            target = vc;
            break;
        }
    }
    // A push onto the More stack is invisible unless the More tab is the one
    // showing. The More page's own tiles always satisfy that, but a deep link
    // (overland://session/...) can arrive while another tab is selected --
    // sim-test run 34772337791 caught Sessions pushed behind the Growth tab.
    UITabBarController *tabs = moreCoordinator.moreNav.tabBarController;
    if (target != nil && tabs != nil && tabs.selectedViewController != tabs.moreNavigationController) {
        tabs.selectedViewController = tabs.moreNavigationController;
    }
    BOOL opened = [self openModuleViewController:target ontoNavigationController:moreCoordinator.moreNav];
    [GLCrashReporter addBreadcrumb:[NSString stringWithFormat:
        @"openOverflowModuleWithIdentifier exit id=%@ opened=%@", identifier, opened ? @"YES" : @"NO"]];
    return opened;
}

#pragma mark - Navigation

// The one place a module gets brought on screen. Visible tabs are selected;
// More-overflow modules go through +openOverflowModuleWithIdentifier:, which
// knows the select-vs-push split. Callers never touch selectedIndex /
// selectedViewController themselves: per-module copies of this logic are
// what broke when Journal moved into More (its -selectJournalTab looked for
// its navigation controller in tabs.viewControllers and found the More
// stack instead), and scripts/check_tab_selection.sh fails the build on a
// new one.
+ (BOOL)gl_presentViewController:(UIViewController *)vc inTabBarController:(UITabBarController *)tabs {
    if ([moreCoordinator.overflowModules containsObject:vc]) {
        return [self openOverflowModuleWithIdentifier:vc.restorationIdentifier];
    }
    tabs.selectedViewController = vc;
    return YES;
}

+ (BOOL)showModuleWithIdentifier:(NSString *)identifier {
    explicitNavigationCount++;
    UITabBarController *tabs = installedTabs;
    UIViewController *target = nil;
    for (UIViewController *vc in tabs.viewControllers) {
        if ([vc.restorationIdentifier isEqualToString:identifier]) {
            target = vc;
            break;
        }
    }
    // A modal left open over the tabs (e.g. the Clips player) would hide the
    // module this call just selected, so a deep link closes it first.
    if (target != nil && tabs.presentedViewController != nil) {
        [tabs dismissViewControllerAnimated:NO completion:nil];
    }
    BOOL shown = target != nil && [self gl_presentViewController:target inTabBarController:tabs];
    NSLog(@"Module registry: show %@ -> %@", identifier, shown ? @"shown" : @"NOT FOUND");
    [GLCrashReporter addBreadcrumb:[NSString stringWithFormat:
        @"showModuleWithIdentifier id=%@ shown=%@", identifier, shown ? @"YES" : @"NO"]];
    return shown;
}

+ (NSUInteger)explicitNavigationCount {
    return explicitNavigationCount;
}

+ (BOOL)currentScreenHoldsTabOnResumeInTabBarController:(UITabBarController *)tabs {
    UIViewController *onScreen = tabs.selectedViewController;
    // More selected: the module is the topmost overflow module on the More
    // stack. A screen a module pushed itself (Journal's Recent) sits above it
    // and still belongs to that module.
    if (onScreen == tabs.moreNavigationController) {
        onScreen = nil;
        for (UIViewController *vc in tabs.moreNavigationController.viewControllers.reverseObjectEnumerator) {
            if ([tabs.viewControllers containsObject:vc]) { onScreen = vc; break; }
        }
    }
    // Same classes[i]/controllers[i] pairing as +selectDefaultTabInTabBarController:.
    NSArray *classes = [self moduleClasses];
    NSArray<UIViewController *> *controllers = tabs.viewControllers;
    for (NSUInteger i = 0; i < classes.count && i < controllers.count; i++) {
        if (controllers[i] != onScreen) continue;
        Class module = classes[i];
        return [module respondsToSelector:@selector(moduleHoldsTabOnResume)] &&
               [module moduleHoldsTabOnResume];
    }
    return NO;
}

#pragma mark - Test hooks

+ (void)appendTestLog:(NSString *)line {
    NSLog(@"%@", line);
    NSString *path = [[NSProcessInfo processInfo] environment][@"UITEST_STATE_LOG"];
    if (path.length == 0) return;
    NSFileHandle *h = [NSFileHandle fileHandleForWritingAtPath:path];
    if (h == nil) {
        [[NSFileManager defaultManager] createFileAtPath:path contents:nil attributes:nil];
        h = [NSFileHandle fileHandleForWritingAtPath:path];
    }
    [h seekToEndOfFile];
    [h writeData:[[line stringByAppendingString:@"\n"] dataUsingEncoding:NSUTF8StringEncoding]];
    [h closeFile];
}

+ (BOOL)openMoreTileWithIdentifier:(NSString *)identifier {
    // Thin wrapper: this identifier -> open-module path is no longer
    // test-only (GLWebBridge's `openModule` handler runs through the exact
    // same +openOverflowModuleWithIdentifier: above), but the name stays for
    // SceneDelegate's UITEST_MORE_TILE hook and sim-test.yml's tile loop,
    // which already call it by this name.
    return [self openOverflowModuleWithIdentifier:identifier];
}

// Escapes for embedding inside a double-quoted attribute value within the
// (single-quoted) querySelector string below -- matches more.html's own
// data-id-selector convention (its cssEscape()). Restoration identifiers are
// always our own "GLModule.ClassName" format, but this refuses to trust that
// blindly.
static NSString *GLWebBridgeJSQuote(NSString *s) {
    NSMutableString *out = [s mutableCopy];
    [out replaceOccurrencesOfString:@"\\" withString:@"\\\\" options:0 range:NSMakeRange(0, out.length)];
    [out replaceOccurrencesOfString:@"\"" withString:@"\\\"" options:0 range:NSMakeRange(0, out.length)];
    return out;
}

// Recursive helper behind +tapMoreGridTileWithIdentifier:completionHandler:
// below -- defined FIRST in this pair, same reason as
// +openModuleViewController:ontoNavigationController: earlier in this file:
// Objective-C resolves an undeclared selector against implementations already
// parsed earlier in the same @implementation, and this one calls itself
// recursively as well as being called by the public entry point below it.
+ (void)tapMoreGridTileWithIdentifier:(NSString *)identifier
                              deadline:(NSDate *)deadline
                     completionHandler:(void (^)(BOOL tapped))completionHandler {
    GLWebModuleViewController *root = moreCoordinator.root;
    if (root == nil) {
        completionHandler(NO);
        return;
    }
    // Fire the same event SEQUENCE a real finger tap produces -- touchstart,
    // then a touchend -- rather than a bare synthetic 'click'. A bare click
    // only ever exercised more.html's non-touch/mouse fallback listener and
    // never caught the Events-tile crash: the real bug was a real touch's
    // touchend AND WebKit's own post-touch synthetic click both reaching
    // openTapped() for one tap. Mirroring WebKit's own suppression rule
    // (no synthetic click when the touchend was preventDefault()'d) is what
    // makes this hook able to fail the way the device failed: only dispatch
    // the follow-up click when the page's touchend handler did NOT cancel
    // it, exactly as a genuine touch does.
    NSString *script = [NSString stringWithFormat:
        @"(function(){"
         "var el = document.querySelector('.gl-tile[data-id=\"%@\"]');"
         "if (!el) return false;"
         "var r = el.getBoundingClientRect();"
         "var x = r.left + r.width / 2, y = r.top + r.height / 2;"
         "var touch = new Touch({identifier: 1, target: el, clientX: x, clientY: y});"
         "el.dispatchEvent(new TouchEvent('touchstart', {touches: [touch], targetTouches: [touch], changedTouches: [touch], bubbles: true, cancelable: true}));"
         "var endEvent = new TouchEvent('touchend', {touches: [], targetTouches: [], changedTouches: [touch], bubbles: true, cancelable: true});"
         "el.dispatchEvent(endEvent);"
         "if (!endEvent.defaultPrevented) {"
         "  el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));"
         "}"
         "return true;"
         "})();",
        GLWebBridgeJSQuote(identifier)];
    [root evaluateTestJavaScript:script completionHandler:^(id result, NSError *error) {
        BOOL tapped = [result isKindOfClass:[NSNumber class]] && [(NSNumber *)result boolValue];
        if (tapped) {
            NSLog(@"tapMoreGridTileWithIdentifier %@: dispatched click", identifier);
            completionHandler(YES);
            return;
        }
        if ([[NSDate date] compare:deadline] != NSOrderedAscending) {
            NSLog(@"tapMoreGridTileWithIdentifier %@: tile never appeared in DOM within deadline (last JS error: %@)",
                  identifier, error ?: @"none -- querySelector just kept returning no match");
            completionHandler(NO);
            return;
        }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [self tapMoreGridTileWithIdentifier:identifier deadline:deadline completionHandler:completionHandler];
        });
    }];
}

+ (void)tapMoreGridTileWithIdentifier:(NSString *)identifier
                      completionHandler:(void (^)(BOOL tapped))completionHandler {
    // A fixed delay before calling this (SceneDelegate.m's
    // UITEST_MORE_TILE_TAP) raced the page's own async load on a cold
    // launch -- more.html's `load()` awaits a bridge round-trip
    // (GLBridge.call('listModules', ...)) before it ever renders a tile, and
    // that took noticeably longer than 1.5s the one time this was measured
    // in CI (run 33441445404: "NO SUCH TILE IN DOM" every time, both tiles).
    //
    // The first fix here tried polling INSIDE the evaluated script via a
    // returned Promise, on the assumption -evaluateJavaScript:completionHandler:
    // awaits one (true of the newer -callAsyncJavaScript:... API). Measured
    // wrong in run 33443356330: it doesn't, on this WebKit -- the completion
    // handler fired immediately with WKErrorDomain code 5 "JavaScript
    // execution returned a result of an unsupported type" (a live Promise
    // object isn't a value this method can convert), before the poll inside
    // it ever got a chance to resolve. Polling from the NATIVE side instead
    // -- one synchronous, non-Promise evaluateJavaScript per attempt,
    // recursing (above) on dispatch_after until it returns true or a
    // deadline passes -- sidesteps that entirely.
    [self tapMoreGridTileWithIdentifier:identifier
                                deadline:[NSDate dateWithTimeIntervalSinceNow:8.0]
                       completionHandler:completionHandler];
}

// Recursive helper behind +logPaletteKeysReceivedByMoreScreen below --
// defined FIRST in this pair, same reason as
// +tapMoreGridTileWithIdentifier:deadline:completionHandler: earlier in this
// file: Objective-C resolves an undeclared selector against implementations
// already parsed earlier in the same @implementation, and this one calls
// itself recursively as well as being called by the public entry point
// below it.
//
// Same poll-until-ready pattern as that method, for the same reason: a
// single fixed-delay eval (SceneDelegate.m's 2.0s wait before calling the
// public method below) raced more.html's own async listModules bridge
// round-trip. Run 33538866789 measured this directly -- the dusk-LIGHT
// launch's read came back with all 10 injected keys, but the dusk-DARK
// launch immediately after it (same fixed delay, same page) came back with
// `UITEST_PALETTE_KEYS:` followed by nothing at all: an empty
// Object.keys(), i.e. window.GL_BOOT.palette hadn't been populated in the
// page's own JS yet when the eval ran, not a genuine missing key (a real
// missing key still leaves the OTHER keys in the joined list; the read that
// actually failed lost every key at once). Retries on the same 0.2s cadence
// as the tile-tap poll until the page reports at least one key or the
// deadline passes, at which point it logs whatever the last read was (empty
// string included) so a genuine regression -- the page never populating the
// palette at all -- still shows up as the empty-keys line sim-test.yml
// already greps for.
+ (void)logPaletteKeysReceivedByMoreScreenWithDeadline:(NSDate *)deadline {
    GLWebModuleViewController *root = moreCoordinator.root;
    if (root == nil) {
        NSLog(@"UITEST_PALETTE_KEYS: (more screen not installed)");
        return;
    }
    // window.GL_BOOT is injected as a WKUserScript at document-start (see
    // GLWebModuleViewController's -installBootUserScript /
    // -bootScriptSource) -- reading it back here proves the exact same
    // object more.html's own JS sees, not a native-side reconstruction of
    // what SHOULD have been sent.
    NSString *script = @"(function(){"
        "var p = (window.GL_BOOT && window.GL_BOOT.palette) || {};"
        "return Object.keys(p).sort().join(',');"
        "})();";
    [root evaluateTestJavaScript:script completionHandler:^(id result, NSError *error) {
        NSString *keys = [result isKindOfClass:[NSString class]] ? (NSString *)result : nil;
        if (keys.length > 0) {
            NSLog(@"UITEST_PALETTE_KEYS: %@", keys);
            return;
        }
        if ([[NSDate date] compare:deadline] != NSOrderedAscending) {
            NSLog(@"UITEST_PALETTE_KEYS: %@", keys ?: [NSString stringWithFormat:@"(eval failed: %@)", error ?: @"unknown -- result was not a string"]);
            return;
        }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [self logPaletteKeysReceivedByMoreScreenWithDeadline:deadline];
        });
    }];
}

+ (void)logPaletteKeysReceivedByMoreScreen {
    [self logPaletteKeysReceivedByMoreScreenWithDeadline:[NSDate dateWithTimeIntervalSinceNow:8.0]];
}

@end
