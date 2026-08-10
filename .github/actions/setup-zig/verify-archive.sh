#!/usr/bin/env bash
set -euo pipefail

EXPECTED_SHA256="${1:-}"
ARCHIVE="${2:-}"

if [[ ! "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Invalid expected SHA-256" >&2
  exit 2
fi
if [[ -z "$ARCHIVE" || ! -f "$ARCHIVE" ]]; then
  echo "Zig archive not found: ${ARCHIVE}" >&2
  exit 2
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256=$(sha256sum "$ARCHIVE" | awk '{ print $1 }')
else
  ACTUAL_SHA256=$(shasum -a 256 "$ARCHIVE" | awk '{ print $1 }')
fi

if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  echo "Zig archive checksum mismatch" >&2
  exit 1
fi
