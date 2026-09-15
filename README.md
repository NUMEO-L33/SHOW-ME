# ShowMe

화면 녹화 영상을 올리면 단계별 대표 화면으로 바꾸는 한국어 안내서 제작기입니다.

개발은 [전체 개발 계획 v1.9](docs/DEVELOPMENT_PLAN.md)을 기준으로 순서대로 진행합니다. 각 묶음의 선행 조건·완료 기준·현재 상태, 사용자 확정 정책과 웹 완성 후 모바일 보완까지 정리되어 있습니다.

현재 사용자 화면은 Phase 0–2까지 구현되어 있으며, AI 계약·저장 기반, Gemini 가상 화면 연결 시험, 분석 HTTP API 경계를 추가했습니다. 제품의 자동 AI 분석은 아직 꺼져 있습니다.

- Sites 앱: 업로드 UI, 처리 상태 폴링, 실제 추출 프레임 검토
- Node 프로세서: 스트리밍 업로드, edit token, 상태 복구, ffprobe/ffmpeg 장면 감지와 회전 안전 프레임 추출
- 영속 계층: 로컬 개발용 JSON/파일 어댑터, 배포용 PostgreSQL/Drizzle + Replit App Storage 어댑터
- Gate 3A: 검증된 AI 제안·초안 revision·분석 소유권 저장과 내부 실행기. [검증 범위](docs/GATE_3A_CHECKPOINT.md)
- Gate 3B-1: Gemini 3.5 Flash-Lite로 가상 화면 2장의 실제 분석·검증·결과 저장 성공. 사용자 영상 자동 전송은 하지 않습니다. [Gemini 시험](docs/GEMINI_SETUP.md)
- Gate 3B-2A: 인증된 분석 요청·조회·취소 API. 작업 큐·운영 예산 접수기가 준비되기 전에는 새 요청을 503으로 거절합니다. [현재 계약과 미구현 범위](docs/ANALYSIS_API.md)
- 전체 계획 B2-A/B: 초안·작업·묶음·예산 원자 저장과 요청별 사용량 정산, 중복 반영 방지·상한 위반 중단 기반. [저장·정산 체크포인트](docs/ANALYSIS_EXECUTION_DESIGN.md)
- 전체 계획 B3: 요청을 예산 저장에 연결하는 접수기와 저장 직전 준비 조건 재확인. 실제 준비 조건 검증기·운영 실행 연결이 없어 기본 설정의 새 요청은 계속 503입니다. [현재 접수 계약](docs/ANALYSIS_API.md)
- 전체 계획 B4-A: 대기 작업 조회, 단일 작업 소유권, 만료 후 인계와 불확실 요청 보존. [인계 저장과 남은 작업](docs/ANALYSIS_EXECUTION_DESIGN.md)
- 전체 계획 B4-B1: 묶음 결과·사용량 정산을 함께 저장하고 마지막 묶음에서만 전체 초안을 반영합니다. 수정한 초안은 유지하고 완료한 묶음을 인계 후 재사용할 수 있습니다. 자동 실행은 아직 꺼져 있습니다.
- 전체 계획 B4-B2: 명시적 내부 자동 처리 루프, 완료 묶음 재사용, 취소·시간 초과 감시와 한정 재시도. 모의 응답으로 검증했으며 실제 운영 검증기·서버 시작에는 연결하지 않았습니다.
- 전체 계획 B4-B3: 종료 후 미사용 예산 반환, 전날 대기 작업 안전 종료, 저장된 오류 근거에 따른 한 번의 재시도, 대기 목록 순환 조회. 취소와 실제 전송 시작도 같은 잠금 아래에서 순서를 정합니다. 로컬/모의 검증이며 운영 개방은 아닙니다.
- B5-A 검증: 격리된 실제 PostgreSQL 16.15에서 동시성·정산·취소·SQL 제약·migration·롤백 17개 시험 통과. 배포 DB/실제 AI 검증은 아닙니다. [DB 검증 기록](docs/B5_POSTGRES_VERIFICATION.md)
- 아직 다음 단계: B5 운영 DB·저장소·무료 전송 조건 검증, 동의 화면 연결, StepCanvas 편집, 비가역 개인정보 가림, 서버 기반 공개 링크

웹 UI는 `npm run dev`, 미디어 서비스 개발 모드는 `npm run processor:dev`로 각각 실행합니다. 컴파일된 프로세서는 `npm run processor:build` 후 `npm run processor:start`로 실행합니다. 로컬 UI는 기본적으로 `http://127.0.0.1:8788`의 프로세서를 찾습니다. 전체 검증은 `npm run check`입니다. 단계별 완료 조건은 [`docs/IMPLEMENTATION_PHASES.md`](docs/IMPLEMENTATION_PHASES.md), 배포 구조와 환경 변수는 [`processor/README.md`](processor/README.md)를 참고하세요.

# vinext-starter

A clean full-stack starter running on [vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`
- Portable: Windows, macOS, or Linux; no Bash required
- Managed Linux: managed Linux runtime with Bash, `flock`, `curl`, `sha256sum`, and GNU `timeout`
- Git is required only for publishing

## Sites Lifecycle

The Sites initializer copies the shared starter and selects managed-linux only when `SITES_MANAGED_LINUX_CONTAINER=1`; otherwise it selects portable. It saves the selection only in ignored `.sites-runtime/execution-profile.json`. Both profiles copy/configure first, then use the plugin's separate `install-dependencies.mjs` step to measure installation independently. Edit source under `app/` and follow the Sites skill for installation, preview, builds, and publishing.

Whenever reopening or moving a checkout, run `node <plugin-root>/scripts/configure-execution-profile.mjs` before project commands. Profile changes do not alter tracked source or require reinstalling otherwise-valid dependencies; restart an existing preview to use the new selection. Do not commit or upload `.sites-runtime/`.

This starter does not use `wrangler.jsonc`.

`install:ci` runs `npm ci` once against the shared lockfile, disables parent-workspace discovery, and includes required dev/optional dependencies despite production/omit settings. Sharp defaults to prebuilt binaries unless explicitly configured otherwise. Do not overlap installers.

- **Portable:** Preserve host HOME, npm cache, registry, proxy, temporary paths, retry/concurrency settings, and lifecycle-script policy. Use `--prefer-offline --no-audit --no-fund`.
- **Managed Linux:** Use the existing project-local HOME/cache/tmp setup and Linux install lock, tarball preflight, and timeout. Restore the image-seeded npm cache only when its lockfile hash matches; retain network fallback. Builds keep their existing timeout. These helpers are not invoked by the portable profile.

`scripts/sites-env.mjs` preserves the caller's HOME, npm cache, proxy, XDG, and temporary-directory configuration while defaulting Wrangler and Miniflare state to the checkout. If npm reports an unwritable cache, select a writable path with `npm_config_cache` for that install. The `dev` and `start` scripts also keep Wrangler logs inside the checkout. Generated `.sites-runtime/` and `.wrangler/` directories are disposable and ignored by Git.

On portable, `npm run dev` uses `vinext dev` with HMR, starting at port 5173. Vinext records the running server in ignored `.vinext/` state, rejects an ordinary duplicate launch, and recovers stale state after a stopped process; exactly simultaneous starts can race. Pass `--port <port>` or `--hostname <host>` after `npm run dev --` when needed; keep portable previews on loopback.

On managed Linux, use `sites-preview start` only for requested browser QA. The project's dev script runs Vite and accepts the supervisor's `--host 0.0.0.0 --port 4173 --strictPort` arguments. The internal browser uses `http://terminal.local:4173/`; it is not a user-facing URL. The supervisor owns the preview lifecycle. The ignored local profile survives the supervisor's cleared process environment.

The portable profile simulates ChatGPT sign-in only for loopback development requests. Visit `/signin-with-chatgpt?return_to=/` to sign in as `local_seedy` (`seedy@sites.test`, display name `Seedy`) and `/signout-with-chatgpt?return_to=/` to sign out. The development cookie preserves that identity across server restarts. Mock auth is disabled in the managed-linux profile and is not included in production builds; hosted authentication remains dispatch-owned.

The Worker uses `vinext/server/fetch-handler`, including Vinext's config-aware image handling. After building, `npm start` runs that Worker locally through Wrangler on `127.0.0.1`, sharing `.wrangler/state` with dev preview and local D1 migrations; it does not deploy the site or simulate sign-in. Use the URL printed by the server. Pass `npm start -- --port <port>` to select a different built-preview port.

Local previews use Miniflare's placeholder `Request.cf` metadata without a network lookup. Set `CLOUDFLARE_CF_FETCH_ENABLED=true` to opt into fetching preview metadata; this setting does not change hosted request metadata.

Local tool usage metrics are disabled by default. Set `WRANGLER_SEND_METRICS=true` to opt in.

## Included Shape

- edit site code under `app/`
- `app/chatgpt-auth.ts` provides optional dispatch-owned ChatGPT sign-in helpers
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` starts intentionally empty
- `@cloudflare/workers-types` provides Worker types; `cloudflare-env.d.ts` declares optional `DB`/`BUCKET` bindings—update these declarations if binding names change
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Use it as the durable user key; use email and name for display or contact purposes.

SIWC-authenticated workspace sites may also receive `oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty `name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by `oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use the returned `userId` as the stable user key for user-owned records; do not use email as a durable identifier.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send anonymous visitors through Sign in with ChatGPT.
- In a Server Component, start sign-in with `<a href={chatGPTSignInPath(returnTo)} target="_top">`. The auth helper module is server-only; do not import it into a Client Component.
- Do not use `fetch`, XHR, a client-side router, or a framework link that can prefetch the sign-in route. SIWC must start as a top-level navigation.
- Never request the AuthAPI authorization endpoint directly. The dispatch-owned `/signin-with-chatgpt` route must start the SIWC flow.
- Use `chatGPTSignOutPath(returnTo)` for browser sign-out links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the OAuth cookies, and identity header injection. Do not implement app routes for those reserved paths. Routes that do not import and call the helper remain anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the Sites hosting platform's access policy controls for workspace-wide restrictions, or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write actions tied to the current ChatGPT user. Leave public content anonymous.

## Local D1 migrations

For a D1-backed local preview, generate SQL with `npm run db:generate`. Build once through the Sites skill's build entrypoint (or `npm run build` for standalone use) to generate `dist/server/wrangler.json`, rebuilding if bindings change. From the project root, apply each pending migration in order:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_example.sql
```

Replace the filename with the pending migration and `DB` with your D1 binding name if different. Use `.wrangler/state`, not `.wrangler/state/v3`; Wrangler adds the versioned directories. Do not replay migrations already applied locally. This updates only the preview database; publishing applies production migrations separately.

## Diagnostic Commands

- `npm run install:ci`: perform the one locked dependency install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build the deployable Sites artifact
- `npm run start`: preview the built Worker locally with D1/R2 support
- `npm run db:generate`: generate Drizzle migrations after schema changes

When using the Sites plugin, follow its skill instructions for installation, builds, and publishing. These npm commands remain available for standalone use.

The portable build runs Vinext directly without a host `timeout` command. The managed-linux build uses `scripts/build-verified.sh` and its existing `SITES_BUILD_TIMEOUT` setting.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
