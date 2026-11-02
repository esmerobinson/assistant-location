#import "GLCrashDiagnosticMapping.h"

NSString *const GLCrashDiagnosticKindCrash = @"MXCrashDiagnostic";
NSString *const GLCrashDiagnosticKindHang = @"MXHangDiagnostic";

@implementation GLCrashDiagnosticMapping

+ (NSArray<NSString *> *)symbolsFromCallStackTreeJSON:(NSData *)json {
    NSError *error = nil;
    NSDictionary *tree = [NSJSONSerialization JSONObjectWithData:json options:0 error:&error];
    NSAssert([tree isKindOfClass:[NSDictionary class]], @"call stack tree is not a JSON object: %@", error);
    NSArray *stacks = tree[@"callStacks"];
    NSAssert([stacks isKindOfClass:[NSArray class]], @"call stack tree has no callStacks array");
    NSDictionary *chosen = stacks.firstObject;
    for (NSDictionary *stack in stacks) {
        if ([stack[@"threadAttributed"] boolValue]) { chosen = stack; break; }
    }
    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    NSArray *frames = chosen[@"callStackRootFrames"];
    // Frames nest through subFrames; a crash or hang stack is a chain, so a
    // depth-first walk taking the first child yields it root to leaf.
    while ([frames isKindOfClass:[NSArray class]] && frames.count > 0) {
        NSDictionary *frame = frames.firstObject;
        [lines addObject:[NSString stringWithFormat:@"%@ 0x%llx +%@",
                          frame[@"binaryName"] ?: @"?",
                          (unsigned long long)[frame[@"address"] unsignedLongLongValue],
                          frame[@"offsetIntoBinaryTextSegment"] ?: @"?"]];
        frames = frame[@"subFrames"];
    }
    return lines;
}

+ (NSDictionary<NSString *, id> *)reportForKind:(NSString *)kind
                                    exceptionType:(NSNumber *)exceptionType
                                    exceptionCode:(NSNumber *)exceptionCode
                                           signal:(NSNumber *)signal
                                terminationReason:(NSString *)terminationReason
                              hangDurationSeconds:(NSNumber *)hangDurationSeconds
                                callStackTreeJSON:(NSData *)callStackTreeJSON
                                      identifying:(NSDictionary<NSString *, id> *)identifying
                                      breadcrumbs:(NSArray<NSString *> *)breadcrumbs {
    NSMutableDictionary *report = [identifying mutableCopy] ?: [NSMutableDictionary dictionary];
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    if (signal) [parts addObject:[NSString stringWithFormat:@"signal=%@", signal]];
    if (exceptionType) [parts addObject:[NSString stringWithFormat:@"exceptionType=%@", exceptionType]];
    if (exceptionCode) [parts addObject:[NSString stringWithFormat:@"exceptionCode=%@", exceptionCode]];
    if (terminationReason.length) [parts addObject:[NSString stringWithFormat:@"terminationReason=%@", terminationReason]];
    if (hangDurationSeconds) [parts addObject:[NSString stringWithFormat:@"hangDurationSeconds=%@", hangDurationSeconds]];
    report[@"name"] = kind;
    report[@"reason"] = [parts componentsJoinedByString:@" "];
    report[@"callStackSymbols"] = [self symbolsFromCallStackTreeJSON:callStackTreeJSON];
    report[@"callStackTree"] = [[NSString alloc] initWithData:callStackTreeJSON encoding:NSUTF8StringEncoding];
    report[@"breadcrumbs"] = breadcrumbs;
    // Breadcrumbs here come from the previous session's file (a MetricKit
    // payload describes a past run), not the live ring buffer.
    report[@"breadcrumbsSource"] = @"previous-session";
    report[@"source"] = @"MetricKit";
    if (signal) report[@"signal"] = signal;
    if (exceptionType) report[@"exceptionType"] = exceptionType;
    if (exceptionCode) report[@"exceptionCode"] = exceptionCode;
    if (terminationReason) report[@"terminationReason"] = terminationReason;
    if (hangDurationSeconds) report[@"hangDurationSeconds"] = hangDurationSeconds;
    return report;
}

@end
