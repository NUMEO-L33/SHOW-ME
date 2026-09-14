# ShowMe 미디어 프로세서

이 디렉터리는 화면 녹화 업로드와 ffmpeg 기반 미디어 처리를 담당하는 별도 Node.js 서비스입니다. 사용자 화면은 루트의 Sites 앱이 계속 담당하고, 이 서비스는 Replit Reserved VM에서 실행하는 구성을 기준으로 합니다.

## 왜 서비스를 나누는가

Sites 앱은 Vinext/Next.js를 Cloudflare Worker에서 실행하므로 공개 가이드, 메타데이터 조회, 가벼운 API에는 잘 맞습니다. 반면 ShowMe의 처리 과정에는 최대 500MB 영상, 임시 파일, `ffprobe`/`ffmpeg` 자식 프로세스, 수 분짜리 작업이 필요합니다. Worker에는 일반 서버처럼 ffmpeg 바이너리를 실행할 수 있는 프로세스 환경이나 영속 로컬 디스크가 없습니다.

따라서 역할을 다음처럼 나눕니다.

1. **Sites/Cloudflare Worker:** 제작·검토 UI, 공개 뷰어, 카카오톡 링크와 OG 응답
2. **Replit Reserved VM:** 스트리밍 업로드, 작업 상태, ffprobe/ffmpeg, 프레임 추출, 개인정보가 구워진 게시 이미지 생성
3. **PostgreSQL:** 가이드와 작업 상태의 기준 데이터
4. **Replit App Storage:** 원본 영상과 생성된 프레임의 영속 저장소

`DATA_DIR`은 처리 중인 파일을 두는 작업 공간일 뿐입니다. Replit에서 다시 배포하면 파일 시스템이 바뀔 수 있으므로, 원본이나 결과물을 로컬 디스크에만 보관하면 안 됩니다.

## 중앙 설정

`src/config.ts`가 모든 환경 변수를 한 번에 읽고 검증합니다. 잘못된 설정은 서버가 요청을 받기 전에 `ConfigurationError`로 종료됩니다.

| 변수 | 기본값 | 설명 |
|---|---:|---|
| `NODE_ENV` | `development` | `development`, `test`, `production` 중 하나 |
| `PORT` | `8788` | 프로세서 HTTP 포트(1–65535) |
| `CORS_ORIGINS` | `http://localhost:5173` | 쉼표로 구분한 정확한 Sites origin. 배포에서는 필수이며 `*` 금지 |
| `DATA_DIR` | `./processor/.data` | 업로드·ffmpeg 임시 파일과 로컬 어댑터의 기준 디렉터리 |
| `FFMPEG_PATH` | `ffmpeg-static` 바이너리 | 필요할 때 덮어쓸 ffmpeg 절대 경로 |
| `FFPROBE_PATH` | `ffprobe-static` 바이너리 | 필요할 때 덮어쓸 ffprobe 절대 경로 |
| `EXPECTED_MEDIA_VERSION` | 없음 | 배포에서 허용할 정확한 ffmpeg/ffprobe `major.minor.patch`. Replit 배포에서는 필수 |
| `DATABASE_URL` | 없음 | PostgreSQL 연결 문자열. Replit 배포에서는 필수 |
| `SHOWME_STORAGE` | `local` | `local` 또는 `replit`. Replit 배포에서는 반드시 `replit` |
| `REPLIT_OBJECT_STORAGE_BUCKET_ID` | 기본 버킷 | 명시할 때 사용할 App Storage 버킷 ID |
| `REPLIT_OBJECT_STORAGE_PREFIX` | `showme` | 버킷 안에서 ShowMe가 소유하는 상대 경로 prefix |
| `ASSET_TICKET_SECRET` | 로컬 임시값 | 프레임용 단기 서명 키. 32바이트 이상 base64url이며 Replit 배포에서는 필수 |
| `SCENE_THRESHOLD` | `0.30` | ffmpeg scene score 임계값(0.01–1.0) |
| `MAX_STEPS` | `24` | 한 가이드의 최대 단계 수(1–100) |
| `PORTRAIT_FRAME_WIDTH` | `720` | 세로 영상 대표 프레임 너비(짝수, 320–4096) |
| `LANDSCAPE_FRAME_WIDTH` | `1280` | 가로 영상 대표 프레임 너비(짝수, 320–4096) |
| `REQUEST_TIMEOUT_MS` | `900000` | 업로드/API 요청 시간 제한 |
| `FFPROBE_TIMEOUT_MS` | `30000` | 메타데이터 판독 시간 제한 |
| `FFMPEG_TIMEOUT_MS` | `600000` | 단일 ffmpeg 실행 시간 제한 |
| `JOB_TIMEOUT_MS` | `900000` | 전체 미디어 작업 시간 제한 |
| `MAX_VIDEO_DURATION_MS` | `1200000` | 영상 최대 길이(기본 20분) |
| `MAX_VIDEO_DIMENSION` | `4096` | 원본 한 변의 최대 픽셀 수 |
| `MAX_VIDEO_PIXELS` | `9000000` | 원본 한 프레임의 최대 총 픽셀 수 |
| `MAX_VIDEO_FRAME_RATE` | `60` | 허용 최대 FPS |
| `MAX_PROCESSING_ATTEMPTS` | `3` | 자동 복구·재시도를 포함한 최대 처리 횟수 |
| `QUEUE_CAPACITY` | `25` | 실행 중 작업을 포함한 인메모리 대기열 상한 |

업로드 한도는 코드에서 **500 MiB**로 고정되어 있습니다. 기본 조합은 `.mp4` + `video/mp4`, `.mov` + `video/quicktime`, `.webm` + `video/webm`입니다. 일부 브라우저가 파일 MIME을 비워 두거나 `application/octet-stream`으로 보내는 경우에는 확장자를 우선 허용한 뒤 ffprobe로 실제 영상 스트림을 검증합니다.

`CORS_ORIGIN`도 이전 설정과의 호환을 위해 읽지만, 새 환경에서는 `CORS_ORIGINS`를 사용하세요.

## 저장소 인터페이스

`src/storage.ts`의 두 어댑터는 같은 네 작업을 제공합니다.

- `putFile(key, sourcePath)`: 로컬 파일을 영속 저장
- `materialize(key, destinationPath)`: ffmpeg가 읽을 수 있도록 object를 로컬 작업 경로에 복원
- `openRead(key)`: 전체 파일을 메모리에 올리지 않고 읽기 stream 열기
- `delete(key)`: object 삭제(이미 없으면 성공으로 처리)

`LocalStorage`는 개발 전용이며 `DATA_DIR/objects` 아래만 접근하도록 경로 이탈을 차단합니다. `ReplitObjectStorage`는 공식 `@replit/object-storage` 클라이언트를 사용하고 모든 key 앞에 `REPLIT_OBJECT_STORAGE_PREFIX`를 붙입니다. 미디어는 SDK의 자동 gzip을 끄고 저장합니다.

`materialize`는 선택적으로 `AbortSignal`을 받으며, 중단된 다운로드는 staging 파일을 최종 경로로 옮기지 않습니다. 호출자는 작업 제한 시간에 반환하고 SDK가 나중에 끝내는 로컬 복사도 다시 정리합니다. 삭제는 동일 key의 진행 중 요청을 합치며 기본 30초 전체 제한을 적용합니다. 시간 초과를 삭제 성공으로 처리하지 않습니다.

ffprobe와 ffmpeg의 업로드 입력에는 `file` 프로토콜 및 MP4/MOV/WebM 컨테이너 allowlist를 적용합니다. 파일 확장자만 바꾼 재생목록을 실제 영상으로 받아들이지 않습니다.

## 로컬에서 순서대로 실행

필수 조건은 Node.js 22 이상과 PostgreSQL입니다. ffmpeg와 ffprobe는 설치된 `ffmpeg-static`/`ffprobe-static` 패키지를 기본으로 사용하므로 별도 시스템 설치가 없어도 됩니다.

1. 저장소 루트에서 의존성을 설치합니다.

   ```powershell
   npm install
   ```

2. 환경 파일을 준비하고 실제 값으로 바꿉니다.

   ```powershell
   Copy-Item processor/.env.example processor/.env
   ```

3. 설정을 포함해 프로세서를 실행합니다. 루트의 `processor:start` 스크립트는 Replit Secrets처럼 이미 주입된 환경 변수를 사용합니다. 로컬 `.env` 파일을 직접 읽을 때는 Node의 `--env-file`을 사용합니다.

   ```powershell
   node --env-file=processor/.env --import tsx processor/src/index.ts
   ```

4. 별도 터미널에서 검증합니다.

   ```powershell
   npm run processor:typecheck
   npm run processor:test
   ```

5. DB 스키마가 추가되거나 변경됐다면 migration을 생성하고 실제 DB에 적용한 뒤 서버를 다시 시작합니다.

   ```powershell
   npm run processor:db:generate
   npm run processor:db:migrate
   ```

배포와 같은 컴파일 산출물을 로컬에서 확인하려면 `npm run processor:build` 후 `npm run processor:start`를 실행합니다.

개발 중 파일 감시가 필요하고 환경 변수를 셸이나 IDE에서 이미 주입했다면 `npm run processor:dev`를 사용합니다.

## Replit Reserved VM 배포 순서

1. Replit Database와 App Storage 버킷을 프로젝트에 연결합니다.
2. Replit Shell에서 `ffmpeg -version`과 `ffprobe -version`의 첫 줄이 같은 정확한 버전인지 확인합니다. 현재 코드가 검토한 분기는 8.0.3 이상, 8.1.2 이상, 9.0.1 이상이며 다른 분기는 코드 검토 전까지 거부됩니다.
3. Secrets에 `DATABASE_URL`, `SHOWME_STORAGE=replit`, `CORS_ORIGINS=https://<게시된-Sites-도메인>`, `ASSET_TICKET_SECRET`, `EXPECTED_MEDIA_VERSION=<방금 확인한 정확한 버전>`과 필요한 pipeline 값을 등록합니다. 기본 버킷이 아닌 경우에만 `REPLIT_OBJECT_STORAGE_BUCKET_ID`를 넣습니다. `ASSET_TICKET_SECRET`은 `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`로 생성할 수 있습니다.
4. 저장소의 `.replit`은 Node 22, `stable-26_05` Nix channel, `ffmpeg-full`, 빌드·실행 명령을 고정합니다. HTTP listener가 먼저 열리고 준비 전에는 503을 반환한 상태에서 migration과 의존성 검사를 수행합니다. 운영 시작 시 ffmpeg와 ffprobe가 같은 release family이고 `EXPECTED_MEDIA_VERSION`과 정확히 일치하는지 확인합니다. Replit 미리보기도 시스템 바이너리에 동일한 보안 분기 검사를 적용하므로 오래된 npm 번들을 공개 입력에 사용하지 않습니다.
5. Replit의 Build command는 `npm run processor:deploy-build`, Run command는 `npm run processor:deploy-start`로 설정합니다. `.replit`에서 자동으로 읽히는 경우에도 Publishing 화면에서 동일한지 확인합니다.
6. 시작 시 DB 연결과 App Storage read/write/delete probe를 통과한 뒤 `/health`가 200을 반환하는지 확인합니다. `/health`는 시작 검사 결과와 큐 상태를 보여 주며 매 요청마다 저장소를 다시 검사하지 않습니다. 큰 자산 정리 작업은 준비 완료 후 백그라운드에서 실행합니다.
7. Sites 빌드 환경에 `NEXT_PUBLIC_SHOWME_PROCESSOR_URL=https://<프로세서-도메인>`을 넣고 다시 게시합니다. 로컬 주소나 HTTP 주소는 공개 HTTPS 페이지에서 의도적으로 거부됩니다. 브라우저에서 허용된 Sites origin 외 요청이 CORS로 차단되는지도 확인합니다.
8. 작은 샘플부터 시작해 mp4, mov, webm과 iPhone 회전 메타데이터 fixture를 차례로 검증한 뒤 500MB 경계 테스트를 수행합니다.

Replit은 배포 시 `REPLIT_DEPLOYMENT=1`을 자동으로 설정합니다. 이 상태에서 `SHOWME_STORAGE=local`이거나 `DATABASE_URL`이 없거나 정확한 `CORS_ORIGINS`가 없으면 중앙 설정이 즉시 종료합니다. 이는 업로드 성공처럼 보인 뒤 파일이나 상태가 사라지는 배포를 막기 위한 의도적인 fail-fast 동작입니다.

## 분석 저장 호환성 — B2-A/B

`0003_analysis_funding.sql`은 분석 묶음·예산 구간·예약, `0004_analysis_accounting.sql`은 요청별 원장과 전체 중단 제어 행을 추가합니다. PostgreSQL에서 새 저장소 코드를 사용하기 전에 `0004`까지 적용해야 합니다. 전체 제어 행은 migration에서 한 번만 생성하며 시작/접수 때 재생성하지 않습니다. 누락·손상은 실패 처리합니다. 기존 시작 절차도 migration 성공 뒤에만 준비 상태가 됩니다. 예약 생성 이후에는 새 예산·정산·삭제 계약을 모르는 이전 코드로 되돌리지 말고 호환 버전만 사용해야 합니다. 이번 개발에서는 실제 DB에 적용하지 않았고, 실제 PostgreSQL 경합·롤백·삭제 cascade 검증은 후속 B5에 남아 있습니다.

로컬 JSON은 형식 v3를 사용합니다. 정상 v1/v2 자료는 읽을 수 있고 다음 저장 때 기존 가이드·초안·실행·최대 예약을 보존하며 v3로 승격합니다. 누락되거나 손상된 v3 요청/정산/제어 기록은 초기화하지 않고 실패 처리합니다. **v1/v2 전용 예전 프로그램으로 돌아갈 수 없으므로 먼저 백업하고, 버전 숫자를 강제로 낮추거나 예산·요청 필드를 지우지 마세요.** 기존 실행에 예산을 소급하지 않습니다. JSON 동시 쓰기 보장은 단일 저장소 인스턴스에 한정합니다.

예약 정책과 요청 기록은 계산 전용이며 무료 사용 가능 여부나 전송·과금 허용을 증명하지 않습니다. B2-B는 확인된 사용량을 한 번만 정산하고, 불확실 사용량은 최대 예약을 유지합니다. 상한 초과는 원장과 전체 중단 상태를 함께 저장하며 날짜 변경/재시작/삭제로 자동 해제하지 않습니다. 아직 배정하지 않은 재시도 몫은 계속 보유하고, 이미 배정된 미전송 요청은 작업 종료 확인 후에만 명시적으로 해제할 수 있습니다. 삭제는 예약 상세와 묶음을 제거하되 식별자·날짜·수치 사용 기록과 집계를 남깁니다. 삭제 뒤 늦은 정산은 거절합니다. API/dispatcher에는 연결하지 않아 신규 분석 503은 유지됩니다. [정산 계약과 남은 범위](../docs/ANALYSIS_EXECUTION_DESIGN.md)를 참고하세요.

## 개인정보 경계

App Storage의 원본 object key를 공개 URL로 직접 노출하지 마세요. 공개 단계에서는 가림 영역을 sharp/ffmpeg로 파생 이미지에 영구 적용한 뒤 그 파생 object만 Sites 뷰어에 전달해야 합니다. 원본 영상은 제작자가 명시적으로 선택한 경우에만 별도 권한 확인을 거쳐 제공해야 합니다.

현재 단계에서는 실제 영상의 공개를 허용하지 않습니다. 검토 화면의 설명과 중앙 클릭 위치는 임시 표시이며 AI 분석 결과가 아닙니다. 편집 변경은 아직 서버에 저장되지 않습니다.

Gate 3A에서 별도 AI 계약·초안 저장·분석 실행 기반과 `0002_analysis_foundation.sql`을 추가했습니다. 기존 미디어 단계와 사용자 화면에는 아직 연결하지 않았습니다. [Gate 3A 체크포인트](../docs/GATE_3A_CHECKPOINT.md)에 해당 단계의 검증 범위를 기록합니다.

후속 Gate 3B-1에서 별도 Gemini 가상 화면 시험을 추가했고, 2026-09-14에 3.5 Flash-Lite 실제 분석을 확인했습니다. 서버 시작·업로드가 Google 호출을 발생시키지는 않습니다. [시험과 개인정보 조건](../docs/GEMINI_SETUP.md)을 참고하세요.

Gate 3B-2A의 분석 요청·조회·취소 API는 이 Node 서버에 등록되어 있습니다. **시작 코드에 AI 작업 접수기를 연결하지 않았으므로 유효한 새 요청도 `503 ANALYSIS_UNAVAILABLE`을 반환하며 대기 작업을 만들지 않습니다.** 기존 실행 조회·취소만 인증 후 처리할 수 있습니다. 키나 시험용 `.env` 값으로 자동 활성화되지 않습니다. 운영 예산·내구성 있는 큐·제품 내 동의·실제 PostgreSQL 검증은 다음 단계입니다. [분석 API 계약](../docs/ANALYSIS_API.md)을 참고하세요.

미공개 ready/failed 초안은 마지막 상태 갱신으로부터 7일 후 자동 삭제 대상이 됩니다. 전체 삭제는 원본과 모든 이전 처리 시도의 프레임을 함께 정리합니다. 취소 요청이 업로드보다 먼저 도착한 경우에는 24시간 취소 기록을 보관합니다. 저장소 장애가 있으면 즉시 삭제를 보장할 수 없으므로 기록을 유지한 채 재시도합니다.

정리 루프는 1분마다 실행하며 클래스별 최대 20개 행, 저장소 작업 예산 20초, 가이드당 저장소 대기 5초를 적용합니다. DB 요청에는 별도의 15초 제한이 있으므로 전체 루프의 실제 시간은 DB 지연에 따라 더 길어질 수 있습니다. 살아 있는 업로드/저장 heartbeat가 갱신되면 이전 snapshot의 정리는 취소됩니다.
