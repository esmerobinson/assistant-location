// MetricKit diagnostic -> /api/crash-report payload mapping (pure; no MetricKit).
#import <XCTest/XCTest.h>
#import "GLCrashDiagnosticMapping.h"

@interface GLCrashDiagnosticMappingTests : XCTestCase
@end

@implementation GLCrashDiagnosticMappingTests

// Shape MetricKit's MXCallStackTree.JSONRepresentation produces: two stacks,
// the attributed one second, frames nested through subFrames.
static NSData *Tree(void) {
    NSDictionary *tree = @{@"callStackPerThread": @YES, @"callStacks": @[
        @{@"threadAttributed": @NO, @"callStackRootFrames": @[
            @{@"binaryName": @"other", @"address": @1, @"offsetIntoBinaryTextSegment": @1, @"subFrames": @[]}]},
        @{@"threadAttributed": @YES, @"callStackRootFrames": @[
            @{@"binaryName": @"Overland", @"address": @(0x1000), @"offsetIntoBinaryTextSegment": @(16),
              @"subFrames": @[@{@"binaryName": @"UIKitCore", @"address": @(0x2000),
                                @"offsetIntoBinaryTextSegment": @(32), @"subFrames": @[]}]}]}]};
    return [NSJSONSerialization dataWithJSONObject:tree options:0 error:nil];
}

- (void)testSymbolsComeFromTheAttributedThreadRootFirst {
    XCTAssertEqualObjects([GLCrashDiagnosticMapping symbolsFromCallStackTreeJSON:Tree()],
                          (@[@"Overland 0x1000 +16", @"UIKitCore 0x2000 +32"]));
}

- (void)testCrashReportKeepsExistingServerFieldsAndAddsMetricKitOnes {
    NSDictionary *r = [GLCrashDiagnosticMapping reportForKind:GLCrashDiagnosticKindCrash
        exceptionType:@1 exceptionCode:@2 signal:@11 terminationReason:@"Namespace SIGNAL, Code 11"
        hangDurationSeconds:nil callStackTreeJSON:Tree()
        identifying:@{@"appVersion": @"9.9", @"device": @"iPhone14,8"} breadcrumbs:@[@"a", @"b"]];
    XCTAssertEqualObjects(r[@"name"], @"MXCrashDiagnostic");
    XCTAssertEqualObjects(r[@"reason"], @"signal=11 exceptionType=1 exceptionCode=2 terminationReason=Namespace SIGNAL, Code 11");
    XCTAssertEqualObjects(r[@"callStackSymbols"], (@[@"Overland 0x1000 +16", @"UIKitCore 0x2000 +32"]));
    XCTAssertEqualObjects(r[@"breadcrumbs"], (@[@"a", @"b"]));
    XCTAssertEqualObjects(r[@"appVersion"], @"9.9");
    XCTAssertEqualObjects(r[@"device"], @"iPhone14,8");
    XCTAssertEqualObjects(r[@"signal"], @11);
    XCTAssertNil(r[@"hangDurationSeconds"]);
    XCTAssertTrue([r[@"callStackTree"] isKindOfClass:[NSString class]]);
    XCTAssertTrue([NSJSONSerialization isValidJSONObject:r]);
}

- (void)testHangReportCarriesDurationAndNoCrashFields {
    NSDictionary *r = [GLCrashDiagnosticMapping reportForKind:GLCrashDiagnosticKindHang
        exceptionType:nil exceptionCode:nil signal:nil terminationReason:nil
        hangDurationSeconds:@2.5 callStackTreeJSON:Tree() identifying:nil breadcrumbs:@[]];
    XCTAssertEqualObjects(r[@"name"], @"MXHangDiagnostic");
    XCTAssertEqualObjects(r[@"reason"], @"hangDurationSeconds=2.5");
    XCTAssertNil(r[@"signal"]);
    XCTAssertNil(r[@"terminationReason"]);
}

@end
