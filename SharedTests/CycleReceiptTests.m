// The delivery-receipt logic behind CycleNSE: which pushes carry a receipt, what is POSTed, and the
// exactly-once gate that keeps contentHandler from being called twice. The extension itself (iOS
// runs it, not a test) is covered by the declarative-config checks at the bottom.
#import <XCTest/XCTest.h>
#import "CycleReceipt.h"

@interface CycleReceiptTests : XCTestCase
@end

@implementation CycleReceiptTests

- (CycleReceipt *)parse:(NSDictionary *)userInfo error:(NSError **)error {
    return [CycleReceipt receiptFromUserInfo:userInfo error:error];
}

- (void)testNoReceiptIsNilWithoutAnError {
    NSError *error = nil;
    XCTAssertNil([self parse:@{@"route": @"todo"} error:&error]);
    XCTAssertNil(error, @"an ordinary push is not an error: %@", error);
}

- (void)testValidReceiptParses {
    NSError *error = nil;
    CycleReceipt *r = [self parse:@{@"route": @"todo", @"receipt": @{@"id": @"abc-123", @"url": @"https://box.example/cycle/push/delivered"}} error:&error];
    XCTAssertNotNil(r, @"%@", error);
    XCTAssertEqualObjects(r.receiptId, @"abc-123");
    XCTAssertEqualObjects(r.url.absoluteString, @"https://box.example/cycle/push/delivered");
}

- (void)testOnlyHttpsIsAccepted {
    for (NSString *bad in @[@"http://box.example/cycle/push/delivered", @"ftp://box.example/x", @"//box.example/x", @"box.example/x"]) {
        NSError *error = nil;
        XCTAssertNil([self parse:@{@"receipt": @{@"id": @"a", @"url": bad}} error:&error], @"accepted %@", bad);
        XCTAssertNotNil(error, @"a rejected url must say why (%@)", bad);
    }
    NSError *error = nil;
    XCTAssertNotNil([self parse:@{@"receipt": @{@"id": @"a", @"url": @"HTTPS://box.example/x"}} error:&error], @"scheme case must not matter: %@", error);
}

- (void)testMalformedReceiptsAreErrorsNotCrashes {
    NSArray *bad = @[
        @"not a dictionary",
        @{@"url": @"https://box.example/x"},
        @{@"id": @"", @"url": @"https://box.example/x"},
        @{@"id": @42, @"url": @"https://box.example/x"},
        @{@"id": [NSNull null], @"url": @"https://box.example/x"},
        @{@"id": @"a"},
        @{@"id": @"a", @"url": @7},
    ];
    for (id receipt in bad) {
        NSError *error = nil;
        XCTAssertNil([self parse:@{@"receipt": receipt} error:&error], @"accepted %@", receipt);
        XCTAssertNotNil(error, @"no error for %@", receipt);
    }
}

- (void)testRequestIsAJsonPostWithAFiveSecondTimeout {
    CycleReceipt *r = [self parse:@{@"receipt": @{@"id": @"abc-123", @"url": @"https://box.example/cycle/push/delivered"}} error:NULL];
    NSURLRequest *req = r.request;
    XCTAssertEqualObjects(req.HTTPMethod, @"POST");
    XCTAssertEqualObjects(req.URL.absoluteString, @"https://box.example/cycle/push/delivered");
    XCTAssertEqual(req.timeoutInterval, 5.0);
    XCTAssertEqualObjects([req valueForHTTPHeaderField:@"Content-Type"], @"application/json");
    id body = [NSJSONSerialization JSONObjectWithData:req.HTTPBody options:0 error:NULL];
    XCTAssertEqualObjects(body, (@{@"id": @"abc-123"}));
}

- (void)testOnceGrantsExactlyOneClaimUnderContention {
    CycleOnce *once = [CycleOnce new];
    __block int wins = 0;
    NSLock *lock = [NSLock new];
    dispatch_apply(2000, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^(size_t i) {
        if ([once claim]) { [lock lock]; wins++; [lock unlock]; }
    });
    XCTAssertEqual(wins, 1);
    XCTAssertFalse([once claim]);
}

#pragma mark - Declarative config, read from the checkout the way iOS reads it at install

- (NSString *)root {
    return [[[@(__FILE__) stringByDeletingLastPathComponent] stringByAppendingPathComponent:@".."] stringByStandardizingPath];
}

- (NSString *)text:(NSString *)rel {
    NSError *error = nil;
    NSString *s = [NSString stringWithContentsOfFile:[[self root] stringByAppendingPathComponent:rel] encoding:NSUTF8StringEncoding error:&error];
    XCTAssertNotNil(s, @"%@: %@", rel, error);
    return s;
}

- (void)testExtensionPlistDeclaresAServiceExtensionWhosePrincipalClassExists {
    NSDictionary *plist = [NSDictionary dictionaryWithContentsOfFile:[[self root] stringByAppendingPathComponent:@"CycleNSE/Info.plist"]];
    XCTAssertNotNil(plist);
    XCTAssertEqualObjects(plist[@"CFBundlePackageType"], @"XPC!");
    XCTAssertEqualObjects(plist[@"NSExtension"][@"NSExtensionPointIdentifier"], @"com.apple.usernotifications.service");
    NSString *cls = plist[@"NSExtension"][@"NSExtensionPrincipalClass"];
    // Objective-C: the bare class name, not the "$(PRODUCT_MODULE_NAME).X" Swift form.
    XCTAssertEqualObjects(cls, @"CycleNotificationService");
    XCTAssertTrue([[self text:@"CycleNSE/CycleNotificationService.m"] containsString:[NSString stringWithFormat:@"@implementation %@", cls]]);
    // iOS rejects an embedded extension whose version differs from the app's.
    NSDictionary *app = [NSDictionary dictionaryWithContentsOfFile:[[self root] stringByAppendingPathComponent:@"CycleApp/Info.plist"]];
    XCTAssertEqualObjects(plist[@"CFBundleShortVersionString"], app[@"CFBundleShortVersionString"]);
}

- (void)testExtensionIdentityAgreesAcrossProjectScriptAndFastfile {
    NSString *script = [self text:@"scripts/add_cycle_nse.rb"];
    NSString *fastfile = [self text:@"fastlane/Fastfile"];
    XCTAssertTrue([script containsString:@"NSE_ID = \"#{APP_ID}.nse\""]);
    XCTAssertTrue([script containsString:@"APP_ID = \"com.oliverullman.cycle\""]);
    XCTAssertTrue([fastfile containsString:@"CYCLE_NSE_ID = \"#{CYCLE_ID}.nse\""]);
    XCTAssertTrue([script containsString:@"NSE_PROFILE = \"Cycle NSE AdHoc\""]);
    XCTAssertTrue([fastfile containsString:@"CYCLE_NSE_ADHOC_PROFILE_NAME = \"Cycle NSE AdHoc\""]);
    // Both Cycle lanes must sign the extension, or the TestFlight build breaks while OTA works.
    for (NSString *lane in @[@"lane :cycle_adhoc do", @"lane :cycle_beta do"]) {
        NSRange start = [fastfile rangeOfString:lane];
        XCTAssertNotEqual(start.location, (NSUInteger)NSNotFound, @"%@", lane);
        NSString *rest = [fastfile substringFromIndex:start.location];
        NSRange next = [rest rangeOfString:@"\n  lane :" options:0 range:NSMakeRange(lane.length, rest.length - lane.length)];
        NSString *body = next.location == NSNotFound ? rest : [rest substringToIndex:next.location];
        XCTAssertTrue([body containsString:@"CYCLE_NSE_ID =>"], @"%@ does not export CycleNSE", lane);
        XCTAssertTrue([body containsString:@"\"CycleNSE\" =>"], @"%@ does not sign the CycleNSE target", lane);
    }
}

@end
