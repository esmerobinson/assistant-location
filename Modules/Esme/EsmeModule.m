#import "EsmeModule.h"

#import "EsmeViewController.h"
#import "GLEsmeReminderScheduling.h"
#import "GLModuleRegistry.h"
#import "TodosModule.h"
#import <UserNotifications/UserNotifications.h>

// How many days ahead +scheduleDailyReminder keeps topped up. Well clear of
// iOS's 64-pending-local-notification cap (a hard system-wide limit -- other
// modules may add their own pending requests too), so this stays a small,
// deliberately conservative slice of it rather than trying to fill the cap.
static NSUInteger const kEsmeReminderDaysAhead = 14;

// "YYYY-MM-DD" default: the latest day a reminder was ever scheduled for. See
// GLEsmeReminderScheduling.
static NSString *const kEsmeScheduledThroughKey = @"EsmeReminderScheduledThrough";

// Broadcast when the user taps the daily reminder notification. See
// EsmeViewController's -init, which observes this the same way
// AutoJournalViewController observes GLJournalStartCapture/
// GLJournalStartTextEntry (AutoJournalModule.m's +moduleHandleURL: doc
// comment on why a plain NSNotification, not a stored reference, is the
// right handoff: this delegate has no reference to any view controller
// instance, only AutoJournalViewController's own -init registration does).
static NSString *const kEsmeStartCheckinNotification = @"GLEsmeStartCheckin";

// UNUserNotificationCenter has exactly one delegate for the whole process,
// and this object is it. GLManager used to also assign itself at launch
// (after this module's hook, since the Tracker module launches later), which
// silently replaced this delegate and made reminder taps do nothing. Anything
// else that needs notification callbacks must coordinate through here, never
// by assigning .delegate itself.
@interface EsmeNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

@implementation EsmeNotificationDelegate

// Fires when the user TAPS the notification -- foreground, background, or a
// cold launch from a terminated state all route through this one method, so
// "tap to open the check-in" needs no separate cold-launch handling. Posts a
// plain NSNotificationCenter notification rather than reaching into a view
// controller directly, since this delegate (owned by EsmeModule, see
// +moduleDidFinishLaunchingWithOptions: below) has no reference to one.
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
 didReceiveNotificationResponse:(UNNotificationResponse *)response
          withCompletionHandler:(void (^)(void))completionHandler {
    if ([GLEsmeReminderScheduling isReminderIdentifier:response.notification.request.identifier]) {
        [[NSNotificationCenter defaultCenter] postNotificationName:kEsmeStartCheckinNotification object:nil];
    }
    // APNs custom key from the todo-sorter Portuguese-practice job. Handled here
    // because this is the process's single notification delegate (see above).
    id practiceEntry = response.notification.request.content.userInfo[@"todoPractice"];
    if ([practiceEntry isKindOfClass:[NSString class]]) {
        [TodosModule openPracticeEntry:practiceEntry];
    }
    completionHandler();
}

// Show every notification (Esme reminders, GLManager's local alerts, APNs
// pushes) as a banner while the app is in the foreground -- the behavior
// GLManager's delegate provided when it held this slot.
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions options))completionHandler {
    completionHandler(UNNotificationPresentationOptionList | UNNotificationPresentationOptionBanner);
}

@end

@implementation EsmeModule

// Registers this module with GLModuleRegistry as the runtime loads this
// class, before main() runs. See GLModuleRegistry.m and MODULES.md — every
// GLModule conformer needs this exact +load or it silently never gets a tab.
+ (void)load {
    [GLModuleRegistry registerModule:self];
}

+ (NSString *)moduleTitle { return @"Esme"; }

+ (UIImage *)moduleIcon { return [UIImage systemImageNamed:@"heart.text.square"]; }

// 650: Esme gave its visible-tab slot (50) to Growth and took Growth's old
// place in the More grid (see MODULES.md's order list and more.html's
// DEFAULT_ORDER). Visible tab bar is New Session | Events | Todos | Football.
+ (NSInteger)moduleOrder { return 650; }

+ (UIViewController *)makeViewController {
    return [[EsmeViewController alloc] init];
}

// UNUserNotificationCenter.delegate is a WEAK reference -- without a strong
// reference held somewhere for the life of the process, this object would be
// deallocated the instant +moduleDidFinishLaunchingWithOptions: returns,
// silently breaking notification-tap delivery (the delegate method would
// just never fire, with no error anywhere).
static EsmeNotificationDelegate *sNotificationDelegate;

// See GLModule.h / MODULES.md's "Optional hooks" section -- called once from
// application:didFinishLaunchingWithOptions:, before any tab is installed.
+ (void)moduleDidFinishLaunchingWithOptions:(nullable NSDictionary *)launchOptions {
    sNotificationDelegate = [EsmeNotificationDelegate new];
    [UNUserNotificationCenter currentNotificationCenter].delegate = sNotificationDelegate;

    // sim-test.yml writes this default before launch (same shape as its
    // other UITEST_*/GLPointsPerBatchDefaults hooks): unlike location,
    // `simctl privacy` has no real TCC service for notifications on this
    // simulator/Xcode, so a genuine -requestAuthorizationWithOptions: call
    // pops a system alert nothing in CI ever dismisses -- it sits on screen
    // for the rest of the run and silently breaks every screenshot/tap after
    // this module's first launch (measured: journal-tile-tap/events-tile-tap
    // both "barely differs from the More grid", both dusk palette reads came
    // back empty -- run 34361246296). Skipping the request also skips
    // scheduling the real reminder, which is correct for a CI run: there is
    // no reminder to verify here, only that the rest of the app still works.
    if ([[NSUserDefaults standardUserDefaults] boolForKey:@"UITestSkipNotificationPrompt"]) {
        return;
    }

    // Check current authorization before requesting: requestAuthorization
    // itself won't re-show a system prompt once the user has already
    // answered once, but calling it unconditionally would still fire a real
    // request (and run its completion handler) on every cold launch for no
    // reason once the answer is already known. Checking first makes "ask
    // once" an explicit part of this code instead of relying on
    // UNUserNotificationCenter's own internal dedup.
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *_Nonnull settings) {
        if (settings.authorizationStatus == UNAuthorizationStatusNotDetermined) {
            [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                                   completionHandler:^(BOOL granted, NSError *_Nullable error) {
                // Schedule regardless of THIS request's outcome: if denied,
                // +scheduleDailyReminder's -addNotificationRequest: below is
                // a harmless no-op (the system just never delivers it), and
                // if the user later enables notifications in Settings, the
                // very same call on the next cold launch schedules it for
                // real -- no separate re-check path is needed.
                dispatch_async(dispatch_get_main_queue(), ^{
                    [self scheduleDailyReminder];
                });
            }];
        } else {
            dispatch_async(dispatch_get_main_queue(), ^{
                [self scheduleDailyReminder];
            });
        }
    }];
}

// Tops up a rolling window of kEsmeReminderDaysAhead independently-random
// reminder times (see GLEsmeReminderScheduling.h for the window and the
// rationale: a fixed clock time samples Oliver's mood at the same point in
// the day every day, which is exactly the bias the daily check-in exists to
// avoid).
//
// A repeating UNCalendarNotificationTrigger fires at the same clock time
// forever by construction, so it cannot express "a new random time each
// day" -- this schedules a BATCH of non-repeating triggers, one per upcoming
// day, instead.
//
// Design choice: a day's time, once chosen and still pending, is NOT
// re-randomized on a later call (foreground, next launch, ...) -- this
// method only ADDS requests for days that don't already have a pending one
// (see the pending-identifier check below). A reminder that keeps moving its own
// time every time the app is opened would be worse than one fixed once
// per day: re-scheduling on every foreground is exactly what needs to
// happen often (to keep the 14-day window topped up), so the alternative
// (re-randomize every call) would re-roll today's or tomorrow's already-
// promised time on every single app open, which is not "an unpredictable
// time" so much as "a moving target."
//
// Stale identifiers (this module's own past-dated pending requests, plus the
// single old fixed-time identifier from before this scheme existed) are
// removed so the pending-request list never accumulates dead entries.
+ (void)scheduleDailyReminder {
    UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
    NSCalendar *calendar = [NSCalendar currentCalendar];
    NSDate *today = [calendar startOfDayForDate:[NSDate date]];

    NSArray<GLEsmeScheduleEntry *> *entries =
        [GLEsmeReminderScheduling upcomingScheduleEntriesFromDate:today
                                                               days:kEsmeReminderDaysAhead
                                                           calendar:calendar
                                                       randomSource:^NSUInteger(NSUInteger upperBound) {
                                                           return (NSUInteger)arc4random_uniform((uint32_t)upperBound);
                                                       }];

    [center getPendingNotificationRequestsWithCompletionHandler:^(NSArray<UNNotificationRequest *> *_Nonnull requests) {
        NSMutableSet<NSString *> *pendingEsmeIdentifiers = [NSMutableSet set];
        NSMutableArray<NSString *> *staleIdentifiers = [NSMutableArray array];
        NSSet<NSString *> *upcomingIdentifiers =
            [NSSet setWithArray:[entries valueForKey:@"identifier"]];

        for (UNNotificationRequest *request in requests) {
            BOOL isOldFixedTimeIdentifier = [request.identifier isEqualToString:@"EsmeDailyCheckinReminder"];
            BOOL isEsmeDatedIdentifier = [request.identifier hasPrefix:GLEsmeReminderIdentifierPrefix];
            if (!isOldFixedTimeIdentifier && !isEsmeDatedIdentifier) {
                continue;
            }
            if (isOldFixedTimeIdentifier || ![upcomingIdentifiers containsObject:request.identifier]) {
                // Either the pre-this-scheme fixed identifier, or one of
                // this module's own dated identifiers that has fallen out of
                // the rolling window (a past day, or -- if
                // kEsmeReminderDaysAhead were ever lowered -- a day that's
                // now beyond it).
                [staleIdentifiers addObject:request.identifier];
            } else {
                [pendingEsmeIdentifiers addObject:request.identifier];
            }
        }
        if (staleIdentifiers.count > 0) {
            [center removePendingNotificationRequestsWithIdentifiers:staleIdentifiers];
        }

        // A day already scheduled once is never scheduled again, even when its
        // reminder has since fired and left the pending list (re-adding it
        // then picked a new later time and nagged again). pendingEsmeIdentifiers
        // (all of them, not just in-window ones) migrates installs with no
        // stored value.
        NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
        NSString *through = [GLEsmeReminderScheduling
            scheduledThroughDayKeyWithStored:[defaults stringForKey:kEsmeScheduledThroughKey]
                          pendingIdentifiers:[pendingEsmeIdentifiers allObjects]];
        NSArray<GLEsmeScheduleEntry *> *toSchedule =
            [GLEsmeReminderScheduling entriesToScheduleFrom:entries
                                           scheduledThrough:through];
        if (toSchedule.count > 0) {
            NSString *last = [GLEsmeReminderScheduling dayKeyForIdentifier:toSchedule.lastObject.identifier];
            [defaults setObject:last forKey:kEsmeScheduledThroughKey];
        } else if (through) {
            [defaults setObject:through forKey:kEsmeScheduledThroughKey];
        }

        for (GLEsmeScheduleEntry *entry in toSchedule) {

            UNMutableNotificationContent *content = [UNMutableNotificationContent new];
            content.title = @"Daily check-in";
            content.body = @"How are you feeling today?";
            content.sound = [UNNotificationSound defaultSound];

            // repeats:NO -- this trigger is for ONE specific calendar date
            // (year/month/day are set on entry.dateComponents), unlike the
            // old fixed-21:00 version's hour/minute-only repeating trigger.
            UNCalendarNotificationTrigger *trigger =
                [UNCalendarNotificationTrigger triggerWithDateMatchingComponents:entry.dateComponents repeats:NO];

            UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:entry.identifier
                                                                                    content:content
                                                                                    trigger:trigger];

            // Errors are not surfaced anywhere further than this nil
            // handler; a failure here just means that one day's reminder
            // doesn't fire, which the next top-up call (launch or
            // foreground) self-heals since it re-checks pending state fresh
            // every time.
            [center addNotificationRequest:request withCompletionHandler:nil];
        }
    }];
}

// Clears only the delivered banner. A still-pending reminder stays: a check-in
// Oliver files on his own before the random time still gets the random one,
// whose submit then supersedes it as that day's daily entry.
+ (void)noteCheckinCompletedForDay:(NSString *)dayKey {
    NSArray<NSString *> *ids = @[[GLEsmeReminderIdentifierPrefix stringByAppendingString:dayKey]];
    [[UNUserNotificationCenter currentNotificationCenter] removeDeliveredNotificationsWithIdentifiers:ids];
}

// See MODULES.md's "Optional lifecycle hooks" section -- fired by
// GLModuleRegistry from UISceneWillEnterForegroundNotification. Re-runs the
// same top-up +scheduleDailyReminder does at launch so the rolling
// kEsmeReminderDaysAhead-day window never runs dry between cold launches
// (e.g. the app staying backgrounded for a week). Guarded by the same
// UITEST default as the launch path, for the same reason: a CI run under
// sim-test.yml should not schedule any real notification, foreground
// transitions included.
+ (void)moduleWillEnterForeground {
    if ([[NSUserDefaults standardUserDefaults] boolForKey:@"UITestSkipNotificationPrompt"]) {
        return;
    }
    [self scheduleDailyReminder];
}

// Cheap and static rather than an async pending-request lookup:
// -getPendingNotificationRequestsWithCompletionHandler: is the only way to
// confirm the schedule actually took, but it's async and this method must
// return synchronously -- see TrackerModule.m's moduleDiagnosticSummary for
// the shape a synchronous, state-reading summary takes when the state really
// is available synchronously (CLLocationManager's authorizationStatus).
// Esme's equivalent isn't, so this reports intent (the window and the
// rolling day count), rather than confirmed state, same as every other
// nil/no-op module's choice not to implement this hook at all.
+ (nullable NSString *)moduleDiagnosticSummary {
    return [NSString stringWithFormat:
            @"Esme: daily check-in reminder scheduled at a random time between %ld:00-%ld:00, "
            @"topped up %lu days ahead",
            (long)GLEsmeReminderWindowStartHour, (long)GLEsmeReminderWindowEndHour,
            (unsigned long)kEsmeReminderDaysAhead];
}

@end
