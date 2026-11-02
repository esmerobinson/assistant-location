#import "TodosModule.h"

#import <QuartzCore/QuartzCore.h>

#import "TodosViewController.h"
#import "GLModuleRegistry.h"
#import "GrowthModule.h"
#import "GLWebModuleViewController.h"
#import "GLTabBarButtonLocator.h"

// Native entry points into the Todos web app's `window.openAddTodo()` (a
// no-arg global the web app exposes exactly like the pre-existing
// window.openBlackBoxPanel/window.switchTab) that don't go through the page's
// own UI: double-tapping the Todos tab bar item, and a long-press context
// menu on it. Both funnel through -openAddTodo below, which is itself the
// same guarded evaluateJavaScript call GLWebModuleViewController already
// makes for its own native->page pushes (-callWebFunctionIfDefined:).
//
// Double-tap detection is delegate-based, not gesture-based: GLModuleRegistry
// installs one GLTabSelectionCoordinator as tabs.delegate (see
// GLModuleRegistry.m) and fans out every UITabBarControllerDelegate
// -didSelectViewController: call -- including re-taps of the already-
// selected tab, which is the whole point -- to
// +moduleTabWasSelectedForViewController:inTabBarController: below. That
// replaced an earlier UITapGestureRecognizer attached directly to the tab
// bar's private per-item button view: on iOS 26 ("Liquid Glass")
// UITabBarController rewrites its button hierarchy so the per-item controls
// are nested inside a container view rather than being direct children of
// the bar, and the one-level `tabBar.subviews` walk this module used to
// locate that view found nothing, silently wiring the gesture recognizer to
// nowhere.
//
// Long-press is still a UIContextMenuInteraction on the actual button view,
// which is still needed for that (there's no delegate-based long-press
// signal) -- now located via GLTabBarButtonLocator's recursive walk, which
// finds the button on both the pre-iOS-26 flat layout and the iOS 26 nested
// one.
//
// An instance, not class-side on TodosModule itself: UIContextMenuInteraction
// needs somewhere to hold the tab bar button view plus the specific view
// controller/tab bar controller instances involved, and it doesn't retain
// its delegate strongly. Kept alive for the process's lifetime via the same
// dispatch_once + static pattern GLModuleRegistry's own moreCoordinator uses
// (see GLModuleRegistry.m) and for the same reason — UIKit can rebuild the
// tab bar's button views later, but this handler must still be there to
// re-attach to.
// Retry budget for -openAddTodo while the Todos page is still booting.
static NSTimeInterval const kTodosOpenAddRetryInterval = 0.2;
static NSInteger const kTodosOpenAddMaxAttempts = 40;

@interface TodosTabBarInteractionHandler : NSObject <UIContextMenuInteractionDelegate>
@property(nonatomic, weak) UIViewController *todosViewController;
@property(nonatomic, weak) UITabBarController *tabBarController;
- (void)installOnTabBarButtonView:(UIView *)buttonView;
- (void)openAddTodo;
- (void)openPracticeEntry:(NSString *)entryId;
@end

@implementation TodosTabBarInteractionHandler

- (void)installOnTabBarButtonView:(UIView *)buttonView {
    [buttonView addInteraction:[[UIContextMenuInteraction alloc] initWithDelegate:self]];
}

- (UIContextMenuConfiguration *)contextMenuInteraction:(UIContextMenuInteraction *)interaction
                        configurationForMenuAtLocation:(CGPoint)location {
    __weak TodosTabBarInteractionHandler *weakSelf = self;
    UIMenu * (^actionProvider)(NSArray<UIMenuElement *> *) = ^UIMenu *(NSArray<UIMenuElement *> *suggestedActions) {
        UIAction *addTodo = [UIAction actionWithTitle:@"Add Todo"
                                                 image:[UIImage systemImageNamed:@"plus"]
                                            identifier:nil
                                               handler:^(__kindof UIAction *action) {
            [weakSelf openAddTodo];
        }];
        return [UIMenu menuWithTitle:@"" children:@[addTodo]];
    };
    return [UIContextMenuConfiguration configurationWithIdentifier:nil
                                                     previewProvider:nil
                                                      actionProvider:actionProvider];
}

// Single call site for both entry points above. A double-tap/long-press can
// fire from any tab (the Todos button is visible everywhere except when
// Todos itself is pushed into the More overflow — see
// +moduleDidInstallTabBarItemForViewController:inTabBarController: below),
// so this switches to the Todos tab first when it isn't already selected,
// then makes the guarded window.openAddTodo() call.
//
// The guard makes the call a silent no-op until the page has booted and
// defined window.openAddTodo. The Todos tab loads lazily, so on a double-tap
// from another tab (the first tap IS the tab switch that starts the load) the
// call used to land on a page that did not exist yet and vanish, which is why
// double-tap only worked once Todos had already been opened. So the call now
// reports whether it ran and retries until it does, bounded so a genuinely
// broken page (server down) gives up instead of polling forever. Together with
// the preload in +moduleDidInstallTabBarItemForViewController: the retry is
// usually not even needed; it covers a slow first load.
- (void)openAddTodo {
    UIViewController *todos = self.todosViewController;
    if (todos == nil) return;
    if (self.tabBarController.selectedViewController != todos) {
        [GLModuleRegistry showModuleWithIdentifier:todos.restorationIdentifier];
    }
    if (![todos isKindOfClass:[GLWebModuleViewController class]]) return;
    [self attemptOpenAddTodoOn:(GLWebModuleViewController *)todos attemptsLeft:kTodosOpenAddMaxAttempts];
}

// Same retry as -openAddTodo: a tap from a killed app reaches a page that is
// still booting, and the sheet must not silently fail to open. Pages older than
// the openPractice global use up the retries and stay on the todo list.
- (void)openPracticeEntry:(NSString *)entryId {
    UIViewController *todos = self.todosViewController;
    if (self.tabBarController.selectedViewController != todos) {
        [GLModuleRegistry showModuleWithIdentifier:todos.restorationIdentifier];
    }
    [self attemptOpenPractice:entryId on:(GLWebModuleViewController *)todos attemptsLeft:kTodosOpenAddMaxAttempts];
}

- (void)attemptOpenPractice:(NSString *)entryId on:(GLWebModuleViewController *)todos attemptsLeft:(NSInteger)attemptsLeft {
    __weak typeof(self) weakSelf = self;
    [todos callWebFunctionIfDefined:@"openPractice" withJSONArgument:@{@"id": entryId} completion:^(BOOL ran) {
        if (ran || attemptsLeft <= 1) return;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kTodosOpenAddRetryInterval * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            [weakSelf attemptOpenPractice:entryId on:todos attemptsLeft:attemptsLeft - 1];
        });
    }];
}

// Interval x attempts = ~8s of patience, measured against nothing: a guess
// sized to a cold WKWebView load over the tailnet.
- (void)attemptOpenAddTodoOn:(GLWebModuleViewController *)todos attemptsLeft:(NSInteger)attemptsLeft {
    __weak typeof(self) weakSelf = self;
    [todos callWebFunctionIfDefined:@"openAddTodo" completion:^(BOOL ran) {
        if (ran || attemptsLeft <= 1) return;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kTodosOpenAddRetryInterval * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            [weakSelf attemptOpenAddTodoOn:todos attemptsLeft:attemptsLeft - 1];
        });
    }];
}

@end

// Kept alive for the process's lifetime — see the class comment above.
static TodosTabBarInteractionHandler *todosTabBarHandler;

// A practice-push tap that arrived before the tab bar was installed. On a cold
// launch the notification delegate can fire first, so without this the tap would
// open the app but never the sheet. Drained in
// +moduleDidInstallTabBarItemForViewController:inTabBarController:.
static NSString *pendingPracticeEntryId;

// File-static rather than an ivar: +moduleTabWasSelectedForViewController:
// inTabBarController: is a CLASS method (see GLModule.h -- the registry
// never instantiates a module), so it has nowhere else to keep this between
// calls.
static NSTimeInterval lastTodosTabSelectionTime;

// A re-tap within this window counts as a double-tap. 0.4s matches
// UITapGestureRecognizer's own default double-tap timing window, which is
// what this replaced.
static NSTimeInterval const kTodosDoubleTapWindow = 0.4;

@implementation TodosModule

// Registers this module with GLModuleRegistry as the runtime loads this
// class, before main() runs. See GLModuleRegistry.m and MODULES.md — every
// GLModule conformer needs this exact +load or it silently never gets a tab.
+ (void)load {
    [GLModuleRegistry registerModule:self];
}

+ (NSString *)moduleTitle { return @"Todos"; }

+ (UIImage *)moduleIcon { return [UIImage systemImageNamed:@"checklist"]; }

+ (NSInteger)moduleOrder { return 150; }

+ (UIViewController *)makeViewController {
    return [[TodosViewController alloc] init];
}

+ (void)openPracticeEntry:(NSString *)entryId {
    if (todosTabBarHandler.todosViewController == nil) {
        pendingPracticeEntryId = entryId;
        return;
    }
    [todosTabBarHandler openPracticeEntry:entryId];
}

// Wires the long-press "Add Todo" context menu onto this module's own tab
// bar button — see TodosTabBarInteractionHandler above for what it calls.
// Double-tap is wired separately, via +moduleTabWasSelectedForViewController:
// inTabBarController: below.
+ (void)moduleDidInstallTabBarItemForViewController:(UIViewController *)viewController
                                  inTabBarController:(UITabBarController *)tabs {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        todosTabBarHandler = [[TodosTabBarInteractionHandler alloc] init];
    });
    todosTabBarHandler.todosViewController = viewController;
    todosTabBarHandler.tabBarController = tabs;

    // Load the Todos page at launch instead of on first selection, so
    // double-tap from any tab finds window.openAddTodo already defined.
    // Load-bearing: view controllers in a tab bar only get -viewDidLoad (and so
    // -loadPage) when first shown.
    [viewController loadViewIfNeeded];

    if (pendingPracticeEntryId != nil) {
        NSString *entryId = pendingPracticeEntryId;
        pendingPracticeEntryId = nil;
        // Next run-loop turn: the launch's own default-tab selection comes after
        // this install and would otherwise switch away from Todos again.
        dispatch_async(dispatch_get_main_queue(), ^{ [todosTabBarHandler openPracticeEntry:entryId]; });
    }

    NSUInteger itemIndex = [tabs.tabBar.items indexOfObject:viewController.tabBarItem];
    if (itemIndex == NSNotFound) {
        NSLog(@"TodosModule: tab bar item not found in tabs.tabBar.items -- Todos must be in the More overflow");
        return;
    }

    UIView *buttonView = [GLTabBarButtonLocator buttonViewInTabBar:tabs.tabBar atItemIndex:itemIndex];
    if (buttonView == nil) {
        NSLog(@"TodosModule: no tab bar button view found for long-press wiring");
        return;
    }
    NSLog(@"TodosModule: located tab bar button view for long-press wiring -- class=%@ frame=%@",
          NSStringFromClass(buttonView.class), NSStringFromCGRect(buttonView.frame));
    [todosTabBarHandler installOnTabBarButtonView:buttonView];
}

// Public-API double-tap detection: GLModuleRegistry's GLTabSelectionCoordinator
// calls this on EVERY tap of the Todos tab bar item, including re-taps of
// the already-selected tab (UITabBarControllerDelegate's
// -didSelectViewController: fires on those too). Two selections within
// kTodosDoubleTapWindow of each other count as a double-tap; the timestamp
// resets to 0 afterward so a third rapid tap doesn't chain into a second
// "double-tap" fire.
+ (void)moduleTabWasSelectedForViewController:(UIViewController *)viewController
                              inTabBarController:(UITabBarController *)tabs {
    NSTimeInterval now = CACurrentMediaTime();
    NSTimeInterval delta = now - lastTodosTabSelectionTime;
    NSLog(@"TodosModule: tab selected, delta since last selection = %.3fs", delta);
    if (delta <= kTodosDoubleTapWindow) {
        lastTodosTabSelectionTime = 0;
        [todosTabBarHandler openAddTodo];
        return;
    }
    lastTodosTabSelectionTime = now;
}

// overland://todo/add, opened by the Add Todo lock-screen widget/Control
// (JournalControl/). Goes through -openAddTodo, which retries until the page
// has booted, so a cold launch opens the sheet once the page is ready.
+ (BOOL)moduleHandleURL:(NSURL *)url {
    if (![url.scheme isEqualToString:@"overland"] || ![url.host isEqualToString:@"todo"]) return NO;
    if (![url.path isEqualToString:@"/add"]) return NO;
    [todosTabBarHandler openAddTodo];
    return YES;
}

// Default tab within the quiet window (growth-quiet-window brief): Growth
// (a More-grid module, order 660) is the default tab, except within 30
// minutes of a completed review, when Todos is.
// GLModuleRegistry's +selectDefaultTabInTabBarController: walks modules in
// +moduleOrder-then-class-name order and stops at the FIRST YES. Todos
// (order 150) is checked BEFORE Growth (order 660), so Todos says YES inside
// the quiet window, and NO outside it, which falls through to Growth's YES.
// The two answers are complementary by construction: Todos' is
// [GrowthModule isWithinQuietWindow].
+ (BOOL)moduleIsDefaultTab { return [GrowthModule isWithinQuietWindow]; }

@end
