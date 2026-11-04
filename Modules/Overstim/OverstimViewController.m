#import "OverstimViewController.h"

#import "BakedConfig.h"

// HTTPS on 9308 (tailscale serve proxy to todo-sorter), same as Todos: the
// offline shell cache needs a secure context. See TodosViewController.m.
static NSInteger const kOverstimPort = 9308;

@implementation OverstimViewController

- (instancetype)init {
    NSString *urlString = [NSString stringWithFormat:@"https://%@:%ld/overstim", GL_BAKED_HOST, (long)kOverstimPort];
    return [self initWithURL:[NSURL URLWithString:urlString]
                  displayName:@"overstim"];
}

@end
