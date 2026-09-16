# Replit 안전 보완본 반영 순서

대상 저장소: `NUMEO-L33/SHOW-ME`.
기준 보관본: `codex/replit-migration-checkpoint` / `f8844eb`.
반영할 별도 브랜치: `codex/replit-migration-hardening`.

main 병합·강제 덮어쓰기·Publish·실제 AI 전송은 이 절차에 포함되지 않는다. 원래 보관 브랜치는 유지한다.

## 1. 현재 상태 먼저 확인

Replit Shell에서 실행한다. 비밀값은 출력하지 않는다.

```sh
git status --short --branch
git log -1 --oneline
```

변경 파일이나 예상하지 않은 커밋이 있으면 여기서 멈추고 비교한다. `reset --hard`, 강제 checkout, 일괄 파일 삭제를 사용하지 않는다. 자동 stash도 하지 않는다.

## 2. 변경 없음과 원격 업로드 확인 후

Workflows에서 실행 중인 ShowMe/API 작업을 중지한다. 이후 원격을 가져오고, 새 브랜치를 만드는 명령은 해당 로컬 브랜치가 없을 때만 사용한다.

```sh
git fetch origin codex/replit-migration-hardening
git switch --create codex/replit-migration-hardening --track origin/codex/replit-migration-hardening
git status --short --branch
git log -1 --oneline
```

로컬 브랜치가 이미 있으면 새로 만들거나 강제로 맞추지 말고 커밋/변경 상태부터 확인한다. 새 HEAD는 GitHub에서 확인한 보완본 커밋과 같아야 한다.

## 3. 서버 재시작 전 검사

```sh
pnpm install --frozen-lockfile --ignore-scripts
node scripts/run-tests.mjs
PORT=20116 BASE_PATH=/ pnpm run build
```

- 각 명령이 성공한 뒤 다음 명령을 실행한다. 실패를 무시하고 계속하지 않는다.
- 기본 검사는 운영 환경변수를 제외하고 임시 파일·모의 AI·로컬 HTTP를 사용한다. 실제 PostgreSQL 통합 검사는 별도이며 여기서는 실행하지 않는다.
- Replit 호스트 FFmpeg/FFprobe 8.1.2가 필요하다. 테스트를 생략하거나 운영 미디어 검사를 끄지 않는다.
- `--ignore-scripts`로 설치 후처리를 막는다. 바이너리/의존성 문제가 나면 원인부터 확인하고 전체 후처리 허용으로 해결하지 않는다.

## 4. 결과 확인 후 실환경 검증

실제 DB/Storage를 사용하는 서버 시작은 위 정적/합성 검증과 별개다. 결과를 확인한 뒤 기존 Workflows로만 시작하며, Shell에서 같은 서버를 중복 실행하지 않는다. 준비 상태와 화면을 확인한 다음 개인정보 없는 합성 영상의 업로드·추출·삭제를 한 단계씩 진행한다.

기본 검사 통과는 실제 DB 통합, 브라우저 녹화, AI 준비 연결, 편집·가림·게시 또는 운영 배포 완료를 뜻하지 않는다. Gemini 호출에는 현재 자료와 범위에 맞는 별도 승인이 필요하다.
