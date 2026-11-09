#import "CookingModule.h"

#import "CookingViewController.h"
#import "GLModuleRegistry.h"

@implementation CookingModule

// Registers this module with GLModuleRegistry as the runtime loads this
// class, before main() runs. See GLModuleRegistry.m and MODULES.md — every
// GLModule conformer needs this exact +load or it silently never gets a tab.
+ (void)load {
    [GLModuleRegistry registerModule:self];
}

+ (NSString *)moduleTitle { return @"Cooking"; }

// "fork.knife" exists from iOS 14; the app target's deployment target is 18.0.
+ (UIImage *)moduleIcon { return [UIImage systemImageNamed:@"fork.knife"]; }

// Lands in the More grid.
+ (NSInteger)moduleOrder { return 720; }

+ (UIViewController *)makeViewController {
    return [[CookingViewController alloc] init];
}

@end
