// The Live Activity and widget-location switches live only in Info.plist and fail silently when missing: without
// NSSupportsLiveActivities Activity.request throws, without NSWidgetWantsLocation the widget never gets a fix.
// Read from the real files in the checkout, in the shape iOS reads them.
#import <XCTest/XCTest.h>

@interface SubwayInfoPlistTests : XCTestCase
@end

@implementation SubwayInfoPlistTests

- (NSDictionary *)plistAt:(NSString *)relativePath {
    NSString *root = [[[@(__FILE__) stringByDeletingLastPathComponent] stringByAppendingPathComponent:@".."] stringByStandardizingPath];
    NSDictionary *plist = [NSDictionary dictionaryWithContentsOfFile:[root stringByAppendingPathComponent:relativePath]];
    XCTAssertNotNil(plist, @"could not read %@", relativePath);
    return plist;
}

- (void)testAppAllowsLiveActivitiesWithFrequentUpdates {
    NSDictionary *plist = [self plistAt:@"App/Info.plist"];
    XCTAssertEqualObjects(plist[@"NSSupportsLiveActivities"], @YES);
    XCTAssertEqualObjects(plist[@"NSSupportsLiveActivitiesFrequentUpdates"], @YES);
}

- (void)testWidgetExtensionWantsLocation {
    NSDictionary *plist = [self plistAt:@"JournalControl/Info.plist"];
    XCTAssertEqualObjects(plist[@"NSWidgetWantsLocation"], @YES);
    XCTAssertTrue([plist[@"NSLocationWhenInUseUsageDescription"] length] > 0);
}

@end
