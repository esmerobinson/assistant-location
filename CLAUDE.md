# Overland-iOS — project instructions

## BLOCKING: Read the CI budget rules before touching CI or workflows

Before pushing to `main`, dispatching a workflow, or editing anything under
`.github/workflows/`, read the **CI budget** section in `MODULES.md`. macOS
runners bill at 10x and the free tier is small — CI spend has already blown
through the free tier once. `ota` auto-runs on push; `build` (TestFlight) and
`sim-test` are manual-only and must not be re-added to a push trigger without
a deliberate reason.

## MANDATORY: Probe framework behavior before asserting on it

CI is the only compiler, and each round costs ~10 minutes. Never write an
assertion that depends on an unverified guess about how an Apple framework
behaves (what types an `NSItemProvider` registers, what it names a vended
file, how it wraps errors, UIKit layout).

- **Probe first.** When tests depend on framework behavior, the first dispatch
  is a probe test that logs the real behavior for every input shape you plan
  to test and asserts nothing about it. Write the assertions from that output.
- **Failure messages name the cause.** Every error path reports the underlying
  `NSError`, the class it actually received, and which branch failed. A
  generic "could not read file" wastes a round.
- **One fix round per run.** Fix every failure from a run in one commit. Never
  add new premise-dependent tests to a fix round without probing them too.
- **Test declarative config in the OS's own shape.** An Info.plist value that
  decides whether a feature appears at all (an extension activation rule, a
  capability key) gets a test that loads the real file and evaluates it the
  way iOS does. Never pass substitution variables or a shape iOS doesn't use.
  Green code tests say nothing about it.

## MANDATORY: Screenshots of UI work get reviewed before reporting

After taking screenshots of any UI change, spawn the `ui-review` agent on them
(screenshot paths, app, screen, what changed) before reporting or sending a
demo link. Also spawn `gen-z-tastemaker` in parallel when copy or visual style
changed. Fix what they find and re-screenshot. The standard is
`~/coding/assistant/docs/ui-review-checklist.md` (in the parent assistant repo);
when Oliver corrects a visual or interaction detail, append it there the same turn.
