#import "CycleNotificationService.h"
#import "CycleReceipt.h"

@interface CycleNotificationService ()
@property (nonatomic, strong) CycleOnce *once;
@property (nonatomic, copy) void (^contentHandler)(UNNotificationContent *);
@property (nonatomic, strong) UNNotificationContent *original;
@property (nonatomic, strong) NSURLSessionDataTask *task;
@end

@implementation CycleNotificationService

// Every exit goes through here: the request's completion and serviceExtensionTimeWillExpire can race,
// and calling contentHandler twice crashes the extension. The content is always the original, so a
// receipt problem can never change what the user sees.
- (void)deliver {
    if (![self.once claim]) return;
    self.contentHandler(self.original);
}

- (void)didReceiveNotificationRequest:(UNNotificationRequest *)request
                   withContentHandler:(void (^)(UNNotificationContent *))contentHandler {
    self.once = [CycleOnce new];
    self.contentHandler = contentHandler;
    self.original = request.content;

    NSError *parseError = nil;
    CycleReceipt *receipt = [CycleReceipt receiptFromUserInfo:request.content.userInfo error:&parseError];
    if (!receipt) {
        if (parseError) NSLog(@"CycleNSE: unusable receipt, delivering without it: %@", parseError);
        [self deliver];
        return;
    }

    // Ephemeral: no cookies or cache written from the extension's sandbox. 5 s on both the request and the
    // session so a dead box delays the alert by seconds, not the ~30 s iOS allows.
    NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    config.timeoutIntervalForRequest = 5;
    config.timeoutIntervalForResource = 5;
    NSURLSession *session = [NSURLSession sessionWithConfiguration:config];
    // Strong self on purpose: the block must be able to deliver. The task releases it on completion.
    self.task = [session dataTaskWithRequest:receipt.request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (error) NSLog(@"CycleNSE: receipt POST failed: %@", error);
        else if ([(NSHTTPURLResponse *)response statusCode] != 200) NSLog(@"CycleNSE: receipt POST returned HTTP %ld", (long)[(NSHTTPURLResponse *)response statusCode]);
        [self deliver];
    }];
    [session finishTasksAndInvalidate];
    [self.task resume];
}

- (void)serviceExtensionTimeWillExpire {
    NSLog(@"CycleNSE: time expired before the receipt POST finished");
    [self.task cancel];
    [self deliver];
}

@end
