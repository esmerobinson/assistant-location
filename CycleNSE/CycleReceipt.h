// Pure logic behind the Notification Service Extension's delivery receipt, kept free of
// UserNotifications so the host-less SharedTests bundle can compile and exercise it.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface CycleReceipt : NSObject
@property (nonatomic, copy, readonly) NSString *receiptId;
@property (nonatomic, copy, readonly) NSURL *url;

/// The push's `receipt` entry as {id, url}. Returns nil with no error when the push carries no
/// receipt (an ordinary push: deliver it untouched). Returns nil WITH an error when a receipt is
/// present but unusable (wrong shape, empty id, url that is not https), so the caller can log why
/// no receipt was sent instead of dropping it silently.
+ (nullable CycleReceipt *)receiptFromUserInfo:(NSDictionary *)userInfo error:(NSError **)error;

/// The POST the box expects: JSON {"id": ...}, 5 s timeout so the extension stays well inside the
/// ~30 s iOS gives it.
- (NSURLRequest *)request;
@end

/// Lets a block run once however many callers race for it. The extension's completion handler and
/// serviceExtensionTimeWillExpire can fire at the same moment on different threads, and calling
/// contentHandler twice is a crash.
@interface CycleOnce : NSObject
/// YES for exactly one caller, ever.
- (BOOL)claim;
@end

NS_ASSUME_NONNULL_END
