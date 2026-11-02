// Declarative config of the Cycle shell, read from the real files in the checkout (the bundle
// is not available to a host-less logic test): what the OS reads from Info.plist and the asset
// catalog, and the identifiers that must agree between the project script and the Fastfile.
#import <XCTest/XCTest.h>

@interface CycleInfoPlistTests : XCTestCase
@property (nonatomic, copy) NSString *root;
@property (nonatomic, strong) NSDictionary *plist;
@end

@implementation CycleInfoPlistTests

- (void)setUp {
    self.root = [[[@(__FILE__) stringByDeletingLastPathComponent] stringByAppendingPathComponent:@".."] stringByStandardizingPath];
    NSString *path = [self.root stringByAppendingPathComponent:@"CycleApp/Info.plist"];
    self.plist = [NSDictionary dictionaryWithContentsOfFile:path];
    XCTAssertNotNil(self.plist, @"could not read %@", path);
}

- (NSString *)text:(NSString *)relativePath {
    NSError *error = nil;
    NSString *s = [NSString stringWithContentsOfFile:[self.root stringByAppendingPathComponent:relativePath] encoding:NSUTF8StringEncoding error:&error];
    XCTAssertNotNil(s, @"%@: %@", relativePath, error);
    return s;
}

- (void)testIdentityAndDisplay {
    XCTAssertEqualObjects(self.plist[@"CFBundleDisplayName"], @"Together");
    XCTAssertEqualObjects(self.plist[@"CFBundleIdentifier"], @"$(PRODUCT_BUNDLE_IDENTIFIER)");
    XCTAssertEqualObjects(self.plist[@"CFBundlePackageType"], @"APPL");
    XCTAssertEqualObjects(self.plist[@"UIUserInterfaceStyle"], @"Dark");
    XCTAssertEqualObjects(self.plist[@"UIStatusBarStyle"], @"UIStatusBarStyleLightContent");
    XCTAssertEqualObjects(self.plist[@"UISupportedInterfaceOrientations"], (@[@"UIInterfaceOrientationPortrait"]));
}

- (void)testShellVersionIsAPositiveInteger {
    // CycleViewController compares this against the downloaded web copy's shell.json minShell.
    XCTAssertTrue([self.plist[@"CycleShellVersion"] isKindOfClass:NSNumber.class]);
    XCTAssertGreaterThanOrEqual([self.plist[@"CycleShellVersion"] integerValue], 1);
    NSData *shell = [NSData dataWithContentsOfFile:[self.root stringByAppendingPathComponent:@"CycleApp/web/shell.json"]];
    NSDictionary *json = shell ? [NSJSONSerialization JSONObjectWithData:shell options:0 error:NULL] : nil;
    XCTAssertLessThanOrEqual([json[@"minShell"] integerValue], [self.plist[@"CycleShellVersion"] integerValue], @"the committed web must run on the shell it ships with");
}

- (void)testSpeechAndMicrophonePermissionsAreDescribed {
    // iOS kills the app the first time it asks for either permission without its usage string.
    for (NSString *key in @[@"NSSpeechRecognitionUsageDescription", @"NSMicrophoneUsageDescription"]) {
        XCTAssertTrue([self.plist[key] isKindOfClass:NSString.class] && [self.plist[key] length] > 0, @"%@ missing", key);
    }
    XCTAssertGreaterThanOrEqual([self.plist[@"CycleShellVersion"] integerValue], 2, @"the speech bridge commands arrived in shell 2; shell.json minShell gates the web that calls them");
}

- (void)testNoBackgroundModesNoUrlScheme {
    XCTAssertNil(self.plist[@"UIBackgroundModes"], @"push wakes only the CycleNSE extension, never the app");
    XCTAssertNil(self.plist[@"CFBundleURLTypes"]);
    XCTAssertNil(self.plist[@"NSLocationWhenInUseUsageDescription"]);
}

- (void)testLaunchScreenNamesABlackColorAsset {
    NSDictionary *launch = self.plist[@"UILaunchScreen"];
    NSString *name = launch[@"UIColorName"];
    XCTAssertEqualObjects(name, @"LaunchBackground");
    NSString *json = [self.root stringByAppendingPathComponent:[NSString stringWithFormat:@"CycleApp/Assets.xcassets/%@.colorset/Contents.json", name]];
    NSData *data = [NSData dataWithContentsOfFile:json];
    XCTAssertNotNil(data, @"colour asset %@ missing at %@", name, json);
    NSDictionary *contents = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    NSDictionary *components = contents[@"colors"][0][@"color"][@"components"];
    for (NSString *channel in @[@"red", @"green", @"blue"]) {
        XCTAssertEqual(strtol([components[channel] UTF8String], NULL, 0), 0L, @"launch %@ must be black: %@", channel, components);
    }
}

- (void)testAppIconIsA1024Png {
    NSString *dir = [self.root stringByAppendingPathComponent:@"CycleApp/Assets.xcassets/AppIcon.appiconset"];
    NSDictionary *contents = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:@"Contents.json"]] options:0 error:NULL];
    NSString *file = contents[@"images"][0][@"filename"];
    NSData *png = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:file]];
    XCTAssertGreaterThan(png.length, 24u, @"icon %@ missing", file);
    const uint8_t *b = png.bytes;
    XCTAssertEqual(memcmp(b, "\x89PNG\r\n\x1a\n", 8), 0, @"not a PNG");
    uint32_t w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
    uint32_t h = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
    XCTAssertEqual(w, 1024u);
    XCTAssertEqual(h, 1024u);
}

- (void)testBundleIdAndNamesAgreeAcrossProjectScriptAndFastfile {
    NSString *script = [self text:@"scripts/add_cycle_app.rb"];
    NSString *fastfile = [self text:@"fastlane/Fastfile"];
    XCTAssertTrue([script containsString:@"APP_ID = \"com.oliverullman.cycle\""]);
    XCTAssertTrue([fastfile containsString:@"CYCLE_ID = \"com.oliverullman.cycle\""]);
    XCTAssertTrue([script containsString:@"PROFILE = \"Cycle AdHoc\""]);
    XCTAssertTrue([fastfile containsString:@"CYCLE_ADHOC_PROFILE_NAME = \"Cycle AdHoc\""]);
    XCTAssertTrue([fastfile containsString:@"lane :cycle_adhoc do"]);
}

- (void)testGeneratedConfigIsIgnoredAndWorkflowFailsOnMissingSecrets {
    XCTAssertTrue([[self text:@".gitignore"] containsString:@"CycleApp/web/config.js"]);
    NSString *wf = [self text:@".github/workflows/ota-cycle.yml"];
    for (NSString *secret in @[@"CYCLE_SUPABASE_URL", @"CYCLE_SUPABASE_ANON_KEY", @"CYCLE_BOX_URL"]) {
        NSString *needle = [@"test -n \"$" stringByAppendingString:[secret stringByAppendingString:@"\""]];
        XCTAssertTrue([wf containsString:needle], @"%@ is not checked non-empty", secret);
    }
    XCTAssertFalse([wf containsString:@"push:"], @"ota-cycle is manual dispatch only");
}

@end
