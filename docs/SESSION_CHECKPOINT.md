# ShowMe 재개 지점 — 2026-09-20

사용자가 Docker 오류 확인 후 `저장해`라고 요청하여 진행 상황을 저장했고, 이후 `docker 실행 완료`를 알려 실제 DB 검사를 재개했다. 이 문서는 최신 인계 기록이다. 원래 개발 계획의 목표나 완료 조건은 바꾸지 않는다. 아래 결과는 저장 시점의 관측이며 재개 시 최신 상태를 확인한다.

## 최신 구현 — 2026-09-20 수동 가림·비공개 처리본

가림 영역 추가/이동/크기/켜기/끄기/삭제를 기존 충돌 보호 자동 저장에 연결했다. 소유자·저장 revision·미디어 지문을 확인하는 새 비공개 API가 영역 픽셀을 원본과 무관한 불투명 타일로 바꾸고 전체 PNG/썸네일을 만든다. 실패 시 원본으로 대체하지 않는다. 로컬 합성 브라우저에서 편집·저장·복원, 실제 처리본, 320px/390px 배치, 처리 실패, 다른 창 충돌 때 입력 유지/미리보기 차단을 확인했다. 임시 서버·합성 저장 폴더는 정리했다. 상세는 `PRIVACY_MASK_PREVIEW.md`.

최종 일반 전체 테스트 **872개 통과**(이관 99 / 서버 682 / 클라이언트 91), 실패·취소·생략 0, 종료 코드 0. 서버/화면의 제품·테스트 타입 검사와 양쪽 빌드도 통과했다. 기존 소스맵·번들 크기 경고는 남는다. 이 단계는 로컬 코드·검증 결과이며 Replit pull/재시작/실환경 UI 검증은 아직 수행하지 않았다.

기존 개발 계획은 변경하지 않았다. D2/E2의 부분 구현이며 개인정보 확인 완료(E1)나 게시/공유 완료가 아니다. 원본은 비공개로 유지하고 처리본은 요청 시 메모리에서만 생성한다. 다음은 후보별 확인과 화면·문구 확인 지문(E1), 이후 처리 자산 저장·게시 확정(E2/E3)이다. 일반 AI off와 공개 차단을 유지했고 이번에는 Replit/Google 데이터·키·설정을 건드리지 않았다.

## 이전 완료 지점 — 2026-09-20 고정 합성 AI 실환경 검사

새 키 원문을 열지 않고 Replit 새 셸의 설정 존재를 확인했다. 기존 비공개 접근 검사도 다시 통과했다. 실제 Replit DB/Storage와 제품 bootstrap·loopback API를 사용한 고정 합성 두 화면의 계수 1회/생성 1회가 모두 HTTP 200이었다. 입력 2,771 / 출력 314 토큰의 생성 결과가 2단계 초안 revision 1로 저장됐고, 운영 승인 철회 후 새 실행 503을 확인했다. 개인 영상과 공개 공유는 사용하지 않았다.

최초 명령은 마지막 정리에서 실패했다. 같은 시험 가이드만 대상으로 하는 `--cleanup-only`를 보완해 AI 재호출 없이 정리를 완료했다. 최종 읽기 전용 확인은 review revoked/version 2, halted true, 시험 가이드 삭제, journal 제거, count/generation 각각 settled 1, 기존 API health 200이다. 최초 실패를 소급해 단일 명령 PASS라고 보고하지 않는다. 상세와 한계는 `ANALYSIS_LIVE_ACCEPTANCE.md`.

코드 `23d945e`, `30881de`, `a2aecd9`를 기존 브랜치와 Replit에 반영했다. 기본 서버의 AI off는 변경하지 않았고 서버 재시작/공개 배포도 하지 않았다. 원래 개발 계획은 변경하지 않았다.

최종 일반 전체 테스트 **854개 통과**(이관 99 / 서버 669 / 클라이언트 86), 실패·취소·생략 0, 종료 코드 0. 새 실행기 문법 및 diff 공백 검사도 통과했다. 앞선 서버 검사 1개 실패는 상세 원인을 보존하지 못했고 제품 코드 수정 없이 재실행이 통과했으므로 원인 해결로 표시하지 않는다. 자세한 실행 구분은 `ANALYSIS_LIVE_ACCEPTANCE.md`에 남겼다.

다음 제품 단계는 원래 계획에 따른 개인정보 영구 가림이며 공개 공유·일반 개인 영상 AI 전송 허용·출시 검증도 아직 별도다. 완료한 합성 실호출이나 DB 운영자 생성을 반복하지 않는다.

## 이전 재개 지점 — 2026-09-20 사용자 키 교체 완료 확인

사용자가 `replit , .env 전부 완료 기존의 키도 지웠음`이라고 확인했다. **Replit 설정과 사용자의 `.env` 키 교체, 기존 키 삭제는 사용자 완료 보고로 기록한다.** 이를 위해 새 키 상세를 다시 열거나 비밀값을 출력하지 않는다. 기존 키 삭제를 다시 시도하지 않는다. 새 키가 실행 중 프로세스에 반영됐거나 실제 호출이 성공했다는 뜻은 아니며, 해당 검증은 아직 남아 있다.

다음은 새 설정이 반영된 제한된 시험 환경을 확인하고, 기존에 승인된 고정 합성 두 화면의 AI 실환경 검사로 복귀하는 것이다. 새 키 원문을 대화/로그/명령 인수에 남기지 않으며 개인 영상은 사용하지 않는다. 이전 운영자 계정과 최소 권한은 유지하고, 기본 API의 AI off 설정을 임의로 바꾸지 않는다. 원래 개발 계획은 변경하지 않았다.

## 이전 중단 지점 — 2026-09-20 키 폐기 요청 후

사용자가 기존 키 폐기를 요청하고 `.env` 변경 여부를 물었다. SHOW ME 프로젝트 필터의 단일 키 행에서 삭제 확인을 제출했으나 AI Studio가 `API 키를 삭제할 수 없습니다. 다시 시도해 주세요.`를 표시했다. 새로고침 후 같은 프로젝트 목록에는 2026-09-20 생성된 `Gemini API Key`가 남아 있고, 직전 턴에서 노출된 기존 키의 이름/마스킹 식별과 다르다. **삭제 전에 기존 키와의 일치 확인이 부족했다. 삭제 성공을 확인한 것이 아니며 다른 키에 재시도하지 않는다.** 이전 키가 목록에 보이지 않는 이유나 사용자의 별도 교체/삭제 여부는 아직 확인하지 않았다. 사용자에게 이를 알리고 교체 여부를 확인한다. 키 원문은 이번에 출력하지 않았고 새 키 생성/설정 변경/AI 호출도 하지 않았다.

현재 서버 시작 코드는 `process.env.GEMINI_API_KEY`를 사용하며 표준 시작 경로에서 `.env`를 자동 로드하지 않는다. Replit에서는 Secrets의 같은 이름 값을 교체해야 하며, 별도로 사용하는 로컬 `.env`에 기존 키가 있으면 그 설정도 교체해야 한다. 키 폐기가 설정 파일이나 실행 중 프로세스의 값을 자동 교체하지는 않는다. 새 인증값 입력은 사용자가 직접 하며 채팅에 붙이지 않는다. AI off 상태를 유지한다.

## 직전 중단 지점 — 2026-09-20 08:46 UTC

사용자가 합성 AI 실환경 검사 진행에 `ㄱㄱ`로 답했다. SHOW ME AI Studio의 무료 등급/결제 미설정과 모델 한도(RPM 15 / 입력 TPM 250,000 / RPD 500)를 다시 읽었다. 28일 최대 사용량을 현재 잔여량으로 사용하지 않는다.

키의 프로젝트 소속을 재확인하는 중, 브라우저 키 상세의 출력 가리기가 예상과 다른 키 형식을 처리하지 못해 **키 원문이 이 대화의 도구 출력에 한 차례 표시됐다**. 사용자에게 즉시 알리고 상세를 닫았으며 작업 변수의 원문 참조를 해제했다. 이미 반환된 도구 기록 삭제나 메모리 완전 소거를 주장하지 않는다. 키 원문·끝자리·비교값은 이 문서/코드/명령에 복사하지 않았다. 공개 유출이나 악용을 확인한 것은 아니다.

이 때문에 실제 AI 요청을 보내기 전에 멈췄다. 이번 턴에는 AI 활성화, 운영 기록 작성, Replit DB/Storage 변경, 개인 영상 접근·전송, 새 키 생성/기존 키 삭제/Secrets 교체를 하지 않았다. 키 전체 값의 Replit 일치 확인도 이번에는 완료하지 못했다. 앞선 운영자 계정 검증/저장은 유지된다.

다음은 사용자와 키 교체 범위를 확인하는 것이다. Google 공식 지침은 새 키 생성 → 앱 설정 교체 및 확인 → 기존 키 비활성화/삭제 순서를 권고한다: https://ai.google.dev/gemini-api/docs/api-key#leak-response-checklist . 키 생성/권한과 기존 키 폐기는 새 보안 변경이므로 승인 없이 수행하지 않는다. 새 인증값 입력·변경은 사용자에게 넘긴다. 새 키를 채팅에 붙이도록 요청하지 않는다. 확인 시 전체 상세/AX를 출력한 뒤 특정 접두사만 지우는 방식은 다시 사용하지 않는다.

현재 Chrome의 SHOW ME 필터가 선택된 API 키 목록 탭은 교체 안내를 위해 남긴다. 실호출을 완료했다거나 새 키 연결이 검증됐다고 보고하지 않는다. 아래 내용은 그 이전까지 완료한 상태다.

## 이전 구현·검증 기록 (고정 합성 실환경 검사 전)

이 절부터는 이전 시점의 기록이다. 최신 상태와 다음 작업 판단은 문서 맨 위의 고정 합성 실환경 완료 기록을 우선한다. 아래의 활성화·실호출 예정 항목을 다시 실행하거나 계정을 재생성하지 않는다.

### 당시 위치

- 실제 작업 저장소: `C:/Users/fxxkm/Desktop/capcha/work/showme-replit`
- 브랜치: `codex/replit-migration-hardening`
- 최신 코드 커밋: `41d6585` (`feat(showme): provision bounded analysis operator and qualify storage evidence`). 아래 기록을 추가하는 후속 문서 커밋은 별도다.
- 코드 커밋을 기존 브랜치로 푸시하고 같은 Replit 개발 프로젝트에 fast-forward 반영했다. 운영자 생성 및 재연결까지 성공했다. Replit의 실행 중 API는 재시작하지 않았으므로 새 저장소 근거 코드가 API 번들에 로드됐다고 표시하지 않는다. 운영자 CLI는 새 소스를 직접 사용했다.
- 상위 `capcha` 저장소와 그곳의 기존 수정/문서는 별도다. 오래된 상위 소스에 이 변경을 덧붙이거나 기존 변경을 되돌리지 않는다.

## 방금 완료한 코드

합성 전용 시험의 저장소 확인 근거를 명시적으로 구분했다.

- Replit 공식 정책 + 정확한 버킷/접두사 + 앱 소유자/서명/무권한 접근 검사를 근거로 사용할 때는 `replit-policy-and-app-check`, `internalPermissionsVerified:false`로 기록한다.
- 내부 접근 권한을 직접 확인한 `direct-permission-review`와 구별한다. 이번 실환경을 직접 IAM 검증 완료로 표시하지 않는다.
- 근거 누락/혼합과 옛 근거 없는 승인은 거절한다. 해당 구분이 준비 상태와 AI 전송 전 검사에도 남으며, 근거 변경 시 이전 허가가 무효화되는지 검사했다.
- 고정 합성 입력만 허용, 무료 전용, 유료 fallback 금지, 개인 영상 차단, 기존 만료·철회 조건은 유지했다.
- 승인·중지 전용 최소 권한 계정 생성 스크립트 `provision-operator.mjs`와 `operator-role-setup.ts`를 추가했다. 실제 로그인/잘못된 비밀번호 거절/유효 열 권한 검사/실패 시 새 역할 정리/중복 생성 거절을 포함한다.

관련 로컬 변경:

- `artifacts/api-server/src/processor/analysis-operations-review.ts`
- `artifacts/api-server/tests/helpers/operations-review-fixture.ts`
- `artifacts/api-server/tests/analysis-operations-review.test.ts`
- `artifacts/api-server/tests/analysis-readiness.test.ts`
- `artifacts/api-server/integration/postgres.test.ts`
- `docs/ANALYSIS_LIVE_OPERATIONS_CHECK.md`
- 이 인계 문서

## 검증 결과

- 최종 일반 전체 850개 재실행 통과: 이관 95 / 서버 669 / 클라이언트 86. 실패·취소·생략 0.
- 관련 검사 58개 별도 통과.
- API 제품/테스트 타입 검사, 서버 빌드, diff 공백 검사 통과.
- 운영자 생성 절차 추가 후 PostgreSQL 16.15 통합 검사 **101개 통과**, 실패·취소·생략 0, 종료 코드 0. 두 종류 저장소 근거의 수명주기와 최소 권한 운영자 생성/운영 CLI/실패 정리를 검사했다.
- 최신 실행의 컨테이너 `showme-b5-00054c7e4cd840fea39c75f956bcf26d`와 일회용 데이터 정리 로그를 확인했다. 이 로컬 검사의 외부 AI/Storage는 모의 응답만 사용했다. 이어진 Replit 계정 생성은 아래 실환경 기록으로 구분한다.

## Docker: 검사 재개 성공 / 이전 오류 이력

- 설치된 Docker Desktop: `4.89.0.238018`.
- 시작 시 `C:/Users/fxxkm/AppData/Local/Docker/run/sailor-ingest.sock` → `.stale` 이름 변경이 `The file cannot be accessed by the system`으로 실패했다.
- 로컬 Linux 엔진 파이프가 없어 DB 검사에 접속하지 못했다. ShowMe 테스트 assertion 실패가 아니다.
- `docker desktop start --detach`는 시작 접수를 반환했지만 엔진 정상 기동은 확인되지 않았다. 이후 사용자가 오류 화면을 제공했다.
- 사용자에게 **Quit → 작업 저장 → Windows 다시 시작 → Docker Desktop 실행**을 안내한 뒤 `docker 실행 완료` 답변을 받았다. 실제 임시 DB 생성과 전체 DB 검사 성공으로 현재 엔진 연결을 확인했다. 사용자가 수행한 세부 복구 방법이나 근본 원인 해결까지 확인한 것은 아니다.
- 파일/폴더 삭제·이름 변경, 초기화, 재설치, ACL 변경, WSL 초기화, 진단 업로드는 하지 않았다. 무작정 반복 재시작하거나 데이터를 지우지 않는다.

## 다음 순서

1. 계정 생성은 완료했다. 사용자가 권한 범위를 설명받고 `진행해`로 승인했으며 실제 SHOW-ME 개발 DB에 1개를 생성했다. **동일 계정을 재생성하거나 권한 생성 승인을 다시 묻지 않는다.** 저장된 연결을 안전하게 읽어 사용한다. 상세는 `REPLIT_OPERATOR_SETUP.md`.
2. 다음은 최신 실제 운영 관측과 키/프로젝트 바인딩을 확보하고, 고정 합성 두 화면에만 짧은 활성화를 적용하는 것이다. 실제 외부 요청은 입력량 계산 1회 + 생성 1회, 재시도/유료 전환/개인 영상 전송 없이 범위를 명시한 뒤 진행한다. 필요한 시점에 새 소스로 API를 빌드/기동하되 무의미한 반복 재시작은 하지 않는다.
3. 실제 제품 경로의 실행 → 결과 저장 → 철회/중지 및 시험 데이터 정리를 검증한다. 독립 진단 호출이나 모의 응답 성공을 제품 실환경 완료로 보고하지 않는다.

### 로컬 DB 재검사 명령

아래 스크립트는 기존 로컬 `postgres:16` 이미지만 사용하며 앱 `.env`/Replit DB/개인 영상을 사용하지 않는다. 고유 이름의 loopback 전용 임시 컨테이너를 만들고 자기 시험 데이터만 정리한다. Docker 실행 파일 접근에 실행 환경의 별도 승인이 필요할 수 있다.

```powershell
Set-Location 'C:/Users/fxxkm/Desktop/capcha/work/showme-replit'
$env:SHOWME_TEST_DOCKER_HOST='npipe:////./pipe/dockerDesktopLinuxEngine'
$env:SHOWME_TEST_DOCKER_BIN='C:/Users/fxxkm/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe'
$env:SHOWME_TEST_FFMPEG_PATH='C:/Users/fxxkm/Desktop/capcha/node_modules/ffmpeg-static/ffmpeg.exe'
$env:SHOWME_TEST_FFPROBE_PATH='C:/Users/fxxkm/Desktop/capcha/node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe'
node artifacts/api-server/scripts/verify-postgres.mjs --local-docker
```

## 실환경의 마지막 확인 상태

- Replit: `companynumeo/SHOW-ME`, 프로젝트 `67fdf570-63d0-47d4-a842-742d022f2eb9`.
- 실행용 DB 로그인 분리와 verify-only migration 시작은 이전 단계에 적용/검증했다. 상세: `REPLIT_RUNTIME_ROLLOUT.md`.
- 생성 전 운영자 로그인 0개를 확인하고 `showme_analysis_operator_dev_d10d4afd09a33e52` 1개를 생성했다. 연결은 Git 제외 `.local/showme/operator-db.json`, kind `showme-development-operator-v1`에만 저장했다. 비밀번호/URL은 출력하지 않았다.
- 별도 프로세스에서 저장 파일을 안전하게 다시 읽어 접속·권한 검사에 성공했다. 가이드/단계/초안의 `SELECT * ... LIMIT 0` 세 쿼리가 모두 `42501`로 거절됐다. 내용은 조회하지 않았다. 승인/활성화 이력은 여전히 0개다.
- 운영 CLI `status` 성공: `state:missing`, `version:0`, `lastActivationVersion:0`, `authorizesAnalysis:false`. 전역 제어의 `halted:false`는 기존 값이며 이를 승인 완료나 활성화라고 해석하지 않는다. 이번에 운영 기록/제어 값을 쓰지 않았다.
- 실제 API 자식 1개의 환경 검사: AI off, AI 키/운영자 URL 없음, 기존 runtime 로그인 및 verify-only 유지. `/api/healthz` HTTP 200, `status:ok`. API 재시작·공개 배포는 하지 않았다.
- AI Studio `SHOW ME`: `gen-lang-client-0316998263`. 무료/결제 미설정, 시험 모델 한도 RPM 15 / 입력 TPM 250,000 / RPD 500을 9월 20일 UI에서 확인했다. 실제 승인 기록에는 새 관측 시각/근거가 필요하며, 인계 문서의 날짜를 대신 넣지 않는다.
- 사용자는 시험 중 이 AI 프로젝트를 다른 곳에서 사용하지 않는다고 답했다.
- 서버 키의 프로젝트 일치 근거는 9월 18일 기록이며 이번에 갱신하지 않았다. 다음 실제 활성화 전에 확인한다. 비밀값 원문을 문서·로그·명령 인수에 남기지 않는다.
- 이번 재개는 코드 반영과 승인된 DB 운영자 1개 생성까지 완료했다. 실제 Google 호출·실환경 AI 활성화·개인 영상 외부 전송·공개 배포·과금 변경은 하지 않았다.

추가 근거 및 한계: `ANALYSIS_LIVE_OPERATIONS_CHECK.md`, `ANALYSIS_EXPLICIT_ACTIVATION.md`, `ANALYSIS_REPLIT_BOOTSTRAP.md`, `REPLIT_RUNTIME_ROLLOUT.md`.
