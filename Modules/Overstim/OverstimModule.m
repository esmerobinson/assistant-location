#import "OverstimModule.h"

#import "OverstimViewController.h"
#import "GLModuleRegistry.h"

@implementation OverstimModule

// Registers this module with GLModuleRegistry as the runtime loads this
// class, before main() runs. See GLModuleRegistry.m and MODULES.md — every
// GLModule conformer needs this exact +load or it silently never gets a tab.
+ (void)load {
    [GLModuleRegistry registerModule:self];
}

+ (NSString *)moduleTitle { return @"Overstim"; }

+ (UIImage *)moduleIcon { return [UIImage systemImageNamed:@"bolt.heart"]; }

+ (NSInteger)moduleOrder { return 310; }

+ (UIViewController *)makeViewController {
    return [[OverstimViewController alloc] init];
}

@end
