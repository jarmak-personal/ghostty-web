#!/bin/bash
set -euo pipefail

git submodule update --init ghostty
cd ghostty
git apply --check ../patches/ghostty-wasm-api.patch
git apply ../patches/ghostty-wasm-api.patch
trap 'git apply -R ../patches/ghostty-wasm-api.patch' EXIT
zig build test-lib-vt -Dretained-fixture-only=true -Dsimd=false --summary all
