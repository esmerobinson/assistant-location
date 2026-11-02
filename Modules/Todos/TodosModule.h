// Todos micro app. See MODULES.md at the repo root.

#import <Foundation/Foundation.h>
#import "GLModule.h"

@interface TodosModule : NSObject <GLModule>
/// A tapped Portuguese-practice push (routed from EsmeNotificationDelegate, the
/// process's only notification delegate): shows Todos and opens that entry's
/// corrections sheet. Safe on a cold launch, before the tab bar exists.
+ (void)openPracticeEntry:(NSString *)entryId;
@end
