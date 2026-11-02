#import <UserNotifications/UserNotifications.h>

/// Tells the box a push reached this phone. Apple gives no delivery report, and APNs status 200 only
/// means Apple accepted it, so the box marks `mutable-content` pushes and this extension, which iOS
/// runs just before showing the alert, POSTs the receipt id back. The alert is never held back on it.
@interface CycleNotificationService : UNNotificationServiceExtension
@end
