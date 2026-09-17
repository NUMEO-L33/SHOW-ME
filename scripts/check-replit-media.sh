#!/usr/bin/env bash
set -euo pipefail

# One isolated application test run, not a production server or an AI probe.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ $# -eq 0 ]]; then
  command -v nix-shell >/dev/null || { printf 'NIX_SHELL_REQUIRED\n'; exit 2; }
  printf 'HEADLESS_MEDIA_PREPARE: Nix may download the pinned dependencies.\n'
  exec nix-shell -E 'let pkgs = import <nixpkgs> {}; in pkgs.mkShell { buildInputs = (import ./replit.nix { inherit pkgs; }).deps; }' \
    --run 'bash scripts/check-replit-media.sh --inside'
fi
if [[ $# -ne 1 || $1 != --inside ]]; then
  printf 'Use bash scripts/check-replit-media.sh without arguments.\n'
  exit 2
fi

# Resolve without executing FFmpeg: no version probe or decode warm-up.
showme_test_ffmpeg=$(command -v ffmpeg) || { printf 'FFMPEG_COMMAND_MISSING\n'; exit 2; }
showme_test_ffprobe=$(command -v ffprobe) || { printf 'FFPROBE_COMMAND_MISSING\n'; exit 2; }
printf 'MEDIA_SELECTED: %s\n' "$showme_test_ffmpeg" "$showme_test_ffprobe"
case "$showme_test_ffmpeg:$showme_test_ffprobe" in
  /nix/store/*-ffmpeg-headless-8.1.2-bin/bin/ffmpeg:/nix/store/*-ffmpeg-headless-8.1.2-bin/bin/ffprobe) ;;
  *) printf 'HEADLESS_MEDIA_NOT_SELECTED\n'; exit 2 ;;
esac
if [[ ${showme_test_ffmpeg%/ffmpeg} != "${showme_test_ffprobe%/ffprobe}" ]]; then
  printf 'MEDIA_PAIR_MISMATCH\n'
  exit 2
fi
export SHOWME_TEST_FFMPEG_PATH="$showme_test_ffmpeg"
export SHOWME_TEST_FFPROBE_PATH="$showme_test_ffprobe"
# The runner excludes application credentials and preserves every test failure.
exec node scripts/run-tests.mjs images
