#!/usr/bin/env bash
# Fails when a module's +makeViewController builds a UINavigationController.
#
# A module reached from More is pushed onto the shared More stack. A module
# that wraps itself in its own UINavigationController makes UIKit move the
# wrapper's children onto the More stack and leave the wrapper empty, which
# made reopening Journal crash ("All view controllers in a navigation
# controller must be distinct") or strand the screen. Modules return a plain
# view controller and push their own sub-screens onto self.navigationController.
set -euo pipefail
cd "$(dirname "$0")/.."

hits=$(grep -rnE 'UINavigationController[[:space:]]+alloc|\[UINavigationController[[:space:]]+new\]|UINavigationController\(' \
         --include='*Module.m' --include='*Module.swift' Modules || true)

if [ -n "$hits" ]; then
  echo "A Module constructs a UINavigationController (return a plain view controller instead):"
  echo "$hits"
  exit 1
fi
echo "OK: no module wraps its view controller in a UINavigationController"
