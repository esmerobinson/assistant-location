#import "CycleReceipt.h"

NSString *const CycleReceiptErrorDomain = @"CycleReceipt";

@implementation CycleReceipt

- (instancetype)initWithId:(NSString *)receiptId url:(NSURL *)url {
    if ((self = [super init])) { _receiptId = [receiptId copy]; _url = [url copy]; }
    return self;
}

+ (CycleReceipt *)receiptFromUserInfo:(NSDictionary *)userInfo error:(NSError **)error {
    id raw = userInfo[@"receipt"];
    if (!raw) return nil;
    NSString *why = nil;
    NSDictionary *r = [raw isKindOfClass:NSDictionary.class] ? raw : nil;
    NSString *rid = [r[@"id"] isKindOfClass:NSString.class] ? r[@"id"] : nil;
    NSString *urlString = [r[@"url"] isKindOfClass:NSString.class] ? r[@"url"] : nil;
    NSURL *url = urlString ? [NSURL URLWithString:urlString] : nil;
    if (!r) why = [NSString stringWithFormat:@"receipt is %@, not a dictionary", NSStringFromClass([raw class])];
    else if (!rid.length) why = @"receipt.id missing or empty";
    else if (!url) why = [NSString stringWithFormat:@"receipt.url missing or unparseable: %@", urlString];
    // The id is the only credential the box checks; never send it over plain http.
    else if (![url.scheme.lowercaseString isEqualToString:@"https"] || !url.host.length) why = [NSString stringWithFormat:@"receipt.url is not an https url: %@", urlString];
    if (why) {
        if (error) *error = [NSError errorWithDomain:CycleReceiptErrorDomain code:1 userInfo:@{NSLocalizedDescriptionKey: why}];
        return nil;
    }
    return [[CycleReceipt alloc] initWithId:rid url:url];
}

- (NSURLRequest *)request {
    NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:self.url];
    req.HTTPMethod = @"POST";
    req.timeoutInterval = 5;
    [req setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    req.HTTPBody = [NSJSONSerialization dataWithJSONObject:@{@"id": self.receiptId} options:0 error:NULL];
    return req;
}

@end

@implementation CycleOnce {
    BOOL _claimed;
}
- (BOOL)claim {
    @synchronized (self) {
        if (_claimed) return NO;
        _claimed = YES;
        return YES;
    }
}
@end
