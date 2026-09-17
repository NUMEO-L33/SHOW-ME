# Private JPEG reader: bounded launch/decoding time

## Why this changes the previous deadline

On Replit with the pinned headless FFmpeg/FFprobe 8.1.2, the complete server run
still failed its first untraced synthetic JPEG read (493/494 passed). At 3.5s the
decoder had written no pixels, user CPU ticks were zero, and Linux reported
`D / folio_wait_bit_common`, with 36 major faults. The 4.5s reader deadline then
requested SIGKILL. An isolated run had passed. This supports an OS page-loading
delay, but does not identify the exact file, host cause, or worst-case latency.

This is an explicit application deadline policy change, not a test-only timeout
increase, a claim of faster decoding, or a fix to Replit's underlying storage.
The old promise to keep the entire read within 4.5s is superseded here.

## Policy

`analysis-image-policy.ts` supplies the reader and its internal caller:

| Work | Default / maximum |
| --- | --- |
| Repository, storage, hashes and validation, including final ownership read | 4.5s cumulative / 5s maximum |
| FFmpeg OS launch through decode and stream closure | 10s / 10s maximum |
| Entire reader | Sum of both budgets: default 14.5s, maximum 15s |
| Dispatcher image call | 15s maximum, shortened by parent cancellation/lease deadline |
| Other dispatcher I/O | Unchanged: 5s maximum |

The budgets are finite server-owned values, not environment/client settings.
The last ownership read receives only unused I/O time. Monotonic deadline checks
also reject late continuations when a busy event loop delays a timer callback.
No distinction between OS loading and actual decode readiness is inferred from
Node's `spawn` event. No extra `-version`, warm-up decode, retry, reordered test,
fallback binary or external decoder is introduced. These limits are a bounded
starting policy to validate on Replit, not a guarantee that every host stall fits.

Exactly one private JPEG decoder may be active per Node process. Contention fails
closed; there is no image retry queue. On timeout/abort, pipes are destroyed and
termination is requested. The slot remains occupied until actual child `close`,
not merely `kill()` success. An OS-stuck child therefore cannot accumulate more
decoders; it can make this capability unavailable until it exits or the host is
recovered. The application cannot guarantee immediate OS process termination.

The dispatcher gives image reads their own budget, while repository and other
I/O retain the old cap. A local image failure ends the unsent attempt rather than
implicitly retrying it after lease expiry. Existing terminal codes are retained:
caller deadline uses `AI_TIMEOUT`; other local image failures use the existing
generic `AI_PROVIDER_FAILED` category, without raw paths or error details.
Cancellation/lease loss still takes precedence and retains existing recovery
semantics. No provider call is authorized by this change.

## Validation and privacy

Approval scope, canonical object keys, manifest identity, 2MiB size limit,
content hashes, strict JPEG structure, native decoding, exact RGB output size,
and final approval/guide rechecks are unchanged. Late bytes cannot escape an
abort, expiry, revocation or guide deletion. Source and draft state are unchanged.

The original untraced real JPEG test remains first and mandatory. Added checks:

- Real native FFmpeg output/exit are preserved while its completion notification
  is held for 5.2s. A valid JPEG must still return the original approved bytes;
  corrupt Huffman data with an approved hash must still fail native decoding.
  This deterministically tests delayed completion, not a simulated Linux cold cache.
- Final repository lookup shares the original I/O allowance; short storage
  deadlines and late-stream closure remain tested.
- Revocation, expiry, deletion and abort during decoder completion discard bytes.
- A deliberately stalled child times out, closes its pipes and retains its slot
  until close, with no retry. A subsequent real decode works after release.
- The internal caller accepts image completion past 5s but rejects bounded
  stalls, observes late results, never sends them, and does not reclaim failed work.

Tests use synthetic fixtures and mocked provider/accounting adapters, not actual
videos, cloud PostgreSQL/Storage, credentials or live AI. The image reader and AI
dispatcher remain absent from production startup and HTTP registration. This
patch does not enable AI, sharing, or any non-Replit transfer.

## Replit acceptance

Local validation on Windows / Node 24.15.0: the normal runner passed 64 migration,
508 server and 57 client tests (629 total; zero failures/skips). API source/test
typechecks and the API build passed. The build initially hit the Windows sandbox
path-access restriction; the same isolated build passed with approved access.
No new dependency or binary was installed. These media fixtures used the existing
local FFmpeg/FFprobe binaries, not the Replit Nix build.

The first targeted run caught two regressions where the new terminal-image error
mapping also caught permission/day-rollover errors. The mapping was corrected
to preserve those existing error categories; the existing assertions were not
relaxed, and the subsequent complete suite passed. Replit OS cold-page behavior
and the proposed 10s decoder allowance are still subject to remote validation.

After this change is committed/pushed and the worktree is clean, pull the expected
commit and run the normal suite once, without the observer or prior media warm-up:

```sh
git pull --ff-only &&
node scripts/run-tests.mjs &&
PORT=20116 BASE_PATH=/ pnpm run build
```

Any failure remains a failure: stop and keep its log. Do not retry until green.
If accepted, follow `REPLIT_UPDATE.md` for existing workflow restart. Remote
acceptance, actual storage ACLs/backups and sensitive-media readiness are separate;
local synthetic test success does not certify them.
