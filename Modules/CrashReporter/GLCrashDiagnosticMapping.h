// Pure mapping from MetricKit diagnostics (crash, hang) to the JSON shape
// /api/crash-report already takes from the uncaught-exception path
// (GLCrashReporter.m): the same top-level keys "name", "reason",
// "callStackSymbols", "breadcrumbs" plus the GLAppStateReporter identifying
// fields. Takes plain values, never MetricKit types, so SharedTests can run it
// without a device crash.

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

extern NSString *const GLCrashDiagnosticKindCrash;  // "MXCrashDiagnostic"
extern NSString *const GLCrashDiagnosticKindHang;   // "MXHangDiagnostic"

@interface GLCrashDiagnosticMapping : NSObject

/// Report dictionary for one diagnostic. `identifying` is
/// +[GLAppStateReporter currentIdentifyingFields] (may be nil). Crash-only
/// values (exceptionType, exceptionCode, signal, terminationReason) and
/// hang-only `hangDurationSeconds` are nil when the other kind. Nothing is
/// defaulted: absent MetricKit values are absent from the report.
+ (NSDictionary<NSString *, id> *)reportForKind:(NSString *)kind
                                    exceptionType:(nullable NSNumber *)exceptionType
                                    exceptionCode:(nullable NSNumber *)exceptionCode
                                           signal:(nullable NSNumber *)signal
                                terminationReason:(nullable NSString *)terminationReason
                              hangDurationSeconds:(nullable NSNumber *)hangDurationSeconds
                                callStackTreeJSON:(NSData *)callStackTreeJSON
                                      identifying:(nullable NSDictionary<NSString *, id> *)identifying
                                      breadcrumbs:(NSArray<NSString *> *)breadcrumbs;

/// One "binaryName 0xaddress +offset" line per frame of the thread-attributed
/// call stack (or the first stack when none is attributed), root first.
/// Raises on JSON that is not a MetricKit call stack tree.
+ (NSArray<NSString *> *)symbolsFromCallStackTreeJSON:(NSData *)json;

@end

NS_ASSUME_NONNULL_END
