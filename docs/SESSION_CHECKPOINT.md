# ShowMe 재개 지점 — 2026-09-20

사용자가 Docker 오류 확인 후 `저장해`라고 요청하여 진행 상황을 저장했고, 이후 `docker 실행 완료`를 알려 실제 DB 검사를 재개했다. 이 문서는 최신 인계 기록이다. 원래 개발 계획의 목표나 완료 조건은 바꾸지 않는다. 아래 결과는 저장 시점의 관측이며 재개 시 최신 상태를 확인한다.

## 현재 위치

- 실제 작업 저장소: `C:/Users/fxxkm/Desktop/capcha/work/showme-replit`
- 브랜치: `codex/replit-migration-hardening`
- 로컬 HEAD: `ec16ac3` (`docs(showme): record verified Replit runtime database rollout`)
- 마지막 Replit 조회도 clean `ec16ac3`였다. 이번 변경은 로컬 파일에만 저장되어 있으며 아직 커밋·푸시·Replit 반영하지 않았다.
- 상위 `capcha` 저장소와 그곳의 기존 수정/문서는 별도다. 오래된 상위 소스에 이 변경을 덧붙이거나 기존 변경을 되돌리지 않는다.

## 방금 완료한 코드

합성 전용 시험의 저장소 확인 근거를 명시적으로 구분했다.

- Replit 공식 정책 + 정확한 버킷/접두사 + 앱 소유자/서명/무권한 접근 검사를 근거로 사용할 때는 `replit-policy-and-app-check`, `internalPermissionsVerified:false`로 기록한다.
- 내부 접근 권한을 직접 확인한 `direct-permission-review`와 구별한다. 이번 실환경을 직접 IAM 검증 완료로 표시하지 않는다.
- 근거 누락/혼합과 옛 근거 없는 승인은 거절한다. 해당 구분이 준비 상태와 AI 전송 전 검사에도 남으며, 근거 변경 시 이전 허가가 무효화되는지 검사했다.
- 고정 합성 입력만 허용, 무료 전용, 유료 fallback 금지, 개인 영상 차단, 기존 만료·철회 조건은 유지했다.

관련 로컬 변경:

- `artifacts/api-server/src/processor/analysis-operations-review.ts`
- `artifacts/api-server/tests/helpers/operations-review-fixture.ts`
- `artifacts/api-server/tests/analysis-operations-review.test.ts`
- `artifacts/api-server/tests/analysis-readiness.test.ts`
- `artifacts/api-server/integration/postgres.test.ts`
- `docs/ANALYSIS_LIVE_OPERATIONS_CHECK.md`
- 이 인계 문서

## 검증 결과

- 최종 일반 전체 850개 통과: 이관 95 / 서버 669 / 클라이언트 86. 실패·취소·생략 0.
- 관련 검사 58개 별도 통과.
- API 제품/테스트 타입 검사, 서버 빌드, diff 공백 검사 통과.
- Docker 실행 완료 후 실제 PostgreSQL 16.15 통합 검사 **100개 통과**, 실패·취소·생략 0, 종료 코드 0. 새 두 종류의 저장소 근거 모두에서 인증된 bootstrap→합성 실행→결과 저장→철회를 검사했다. 일반 850개는 앞선 실행 결과이며 이번에 다시 실행한 수치가 아니다.
- 이 실행의 컨테이너 `showme-b5-96cab1e2e90c43f8aeede547296e4a65`와 일회용 데이터 정리 로그를 확인했다. 외부 AI/Storage는 모의 응답만 사용했으며 Replit DB나 개인 영상에 접속하지 않았다.

## Docker: 검사 재개 성공 / 이전 오류 이력

- 설치된 Docker Desktop: `4.89.0.238018`.
- 시작 시 `C:/Users/fxxkm/AppData/Local/Docker/run/sailor-ingest.sock` → `.stale` 이름 변경이 `The file cannot be accessed by the system`으로 실패했다.
- 로컬 Linux 엔진 파이프가 없어 DB 검사에 접속하지 못했다. ShowMe 테스트 assertion 실패가 아니다.
- `docker desktop start --detach`는 시작 접수를 반환했지만 엔진 정상 기동은 확인되지 않았다. 이후 사용자가 오류 화면을 제공했다.
- 사용자에게 **Quit → 작업 저장 → Windows 다시 시작 → Docker Desktop 실행**을 안내한 뒤 `docker 실행 완료` 답변을 받았다. 실제 임시 DB 생성과 전체 DB 검사 성공으로 현재 엔진 연결을 확인했다. 사용자가 수행한 세부 복구 방법이나 근본 원인 해결까지 확인한 것은 아니다.
- 파일/폴더 삭제·이름 변경, 초기화, 재설치, ACL 변경, WSL 초기화, 진단 업로드는 하지 않았다. 무작정 반복 재시작하거나 데이터를 지우지 않는다.

## 다음 순서

1. 로컬 변경은 일반 검사와 실제 DB 검사까지 통과했다. 원격 반영 전 로컬/원격 작업 상태를 확인한다. 실패를 해결하기 위한 제품 코드 변경이나 재시험 조건 완화는 하지 않았다.
2. 사용자가 권한 범위를 설명받은 뒤 `진행해`로 **SHOW-ME 개발 DB의 승인·중지 전용 계정 1개 생성에 동의했다**. 이전 Docker/저장 답변이 아니라 이 후속 답변을 근거로 한다. `provision-operator.mjs`에 생성/인증/권한 검증/실패 정리를 구현했고 실제 PostgreSQL 101개 검사까지 통과했다. Replit 적용 전 상태를 다시 확인했으며 운영자 0개, 관련 이력 0개, AI off, 기존 runtime 연결 존재를 확인했다. 실환경 생성 결과는 적용 후 추가한다.
3. 운영자 연결 이후 최신 실제 운영 관측과 키/프로젝트 바인딩을 확보하고, 고정 합성 두 화면에만 짧은 활성화를 적용한다. 실제 외부 요청은 입력량 계산 1회 + 생성 1회, 재시도/유료 전환/개인 영상 전송 없이 범위를 명시한 뒤 진행한다.
4. 실제 제품 경로의 실행 → 결과 저장 → 철회/중지 및 시험 데이터 정리를 검증한다. 독립 진단 호출이나 모의 응답 성공을 제품 실환경 완료로 보고하지 않는다.

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
- 최근 읽기 전용 조회: runtime 연결 파일 존재, 운영자 로그인 0개, 운영 확인 이력 0개, 활성화 이력 0개. Shell AI 모드 off. 이번에 DB/Storage 데이터를 바꾸지 않았다.
- AI Studio `SHOW ME`: `gen-lang-client-0316998263`. 무료/결제 미설정, 시험 모델 한도 RPM 15 / 입력 TPM 250,000 / RPD 500을 9월 20일 UI에서 확인했다. 실제 승인 기록에는 새 관측 시각/근거가 필요하며, 인계 문서의 날짜를 대신 넣지 않는다.
- 사용자는 시험 중 이 AI 프로젝트를 다른 곳에서 사용하지 않는다고 답했다.
- 서버 키의 프로젝트 일치 근거는 9월 18일 기록이며 이번에 갱신하지 않았다. 다음 실제 활성화 전에 확인한다. 비밀값 원문을 문서·로그·명령 인수에 남기지 않는다.
- 이번 재개에서는 로컬 임시 DB 검사와 문서 갱신만 했다. Replit DB 로그인 생성·실제 Google 호출·실환경 AI 활성화·개인 영상 외부 전송·공개 배포·과금 변경을 하지 않았다.

추가 근거 및 한계: `ANALYSIS_LIVE_OPERATIONS_CHECK.md`, `ANALYSIS_EXPLICIT_ACTIVATION.md`, `ANALYSIS_REPLIT_BOOTSTRAP.md`, `REPLIT_RUNTIME_ROLLOUT.md`.
