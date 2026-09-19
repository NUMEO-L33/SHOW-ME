# SHOW-ME 개발환경 반영 — 2026-09-19

원래 개발 계획은 변경하지 않는다. `ANALYSIS_REPLIT_BOOTSTRAP.md` 이후 사용자가 승인한 코드 반영·앱 DB 계정 분리 기록이다. 공개 배포, 개인 영상 외부 전송, AI 활성화는 범위에 없다.

## 반영 절차

- 검증한 변경을 기존 `codex/replit-migration-hardening` 브랜치의 `1f7f2b3`으로 커밋·푸시했다.
- 기존 `companynumeo/SHOW-ME` 개발 프로젝트에서 fast-forward 업데이트 및 서버 빌드를 확인했다.
- DB migration `0011`, `0012`를 적용했다. 전체 이력 13개가 소스와 일치하며 기존 가이드 개수도 동일했다. 테이블/영상/가이드 삭제는 하지 않았다.

## 앱 시작 경로

Replit 개발환경의 `pnpm start`는 `scripts/start.mjs`를 거쳐 제한된 DB 연결로 서버를 실행한다. 별도 설정 파일이 없거나 불완전하면 관리자 계정으로 되돌아가지 않고 시작을 거절한다. 로컬 및 production 시작은 개발환경 파일을 소비하지 않는다. production의 역할·비밀 전달 설정은 별도로 검증해야 한다.

- 설정 파일은 워크스페이스의 `.local/showme/runtime-db.json`이다. `.local/`은 Git에서 제외돼 있으며 디렉터리 0700, 파일 0600으로 생성한다. 파일을 채팅·로그·Git에 출력하지 않는다.
- `node --import tsx scripts/provision-runtime.mjs --replit-development=<확인한 프로젝트 UUID> --confirm-create-runtime`은 같은 개발 DB에 임의의 새로운 `showme_runtime_dev_*` LOGIN을 만든다. 기존 역할이나 비밀번호는 변경하지 않는다.
- 권한은 기존 runtime 검사의 범위에 한정하며, 실제 로그인·잘못된 비밀번호 거절·읽기 전용 migration 일치를 검사한 후에만 연결 정보를 저장한다. 기존 설정 파일을 덮어쓰지 않는다. 저장 실패 시 이번에 만든 역할만 정리한다.
- 앱 자식 프로세스에서는 기존 `DATABASE_URL`, `PG*`, 별도 운영/migration URL과 `NODE_OPTIONS`를 제거하고 앱 계정 URL을 전달한다. `verify-only`를 강제하며 AI가 꺼져 있으면 AI 키도 전달하지 않는다.
- `verify-only` 시작은 AI 사용 여부와 관계없이 제한된 역할인지 확인한다. 앱 계정으로 schema 변경이나 승인 이력 쓰기가 가능하면 시작하지 않는다.

이는 **앱 DB 권한과 전달 환경의 분리**다. 같은 Replit 작업영역 소유자, 관리자 셸, 부모 프로세스, 플랫폼 통합까지 격리하는 sandbox는 아니다. 작업영역을 완전히 침해한 공격자로부터 관리자 자격 증명을 감추는 설계라고 주장하지 않는다. 개발 파일은 공개 배포용 비밀 관리 수단이 아니며, 파일이 사라지면 관리자 연결로 자동 복귀시키지 말고 운영자가 복구해야 한다.

## 로컬 검증

- 일반 전체 847개(이관 95 + 서버 666 + 클라이언트 86) 통과. 실패·취소·생략 0.
- 실제 임시 PostgreSQL 99개 통과. 역할 생성·잘못된 비밀번호 거절·저장 실패 정리 검사를 포함한다.
- API 제품/테스트 타입 검사 및 서버 빌드 통과.
- 외부 AI 호출 없이 검증했다. 임시 Docker DB/컨테이너는 정리했다.

## Replit 실환경 최종 확인 — 2026-09-20 (KST)

- 후속 구현 `7cf0b90`까지 같은 개발 프로젝트에 fast-forward 반영했다. Replit 서버 빌드와 전체 `scripts/run-tests.mjs`가 종료 코드 0으로 통과했다.
- 전용 앱 LOGIN을 새로 생성했다. 실제 인증 성공, 잘못된 비밀번호 거절, 제한된 역할 권한 검사를 통과한 뒤 비공개 개발 연결 파일을 저장했다. 비밀번호·DB URL은 출력하거나 Git에 넣지 않았다. 기존 관리자 LOGIN은 변경하지 않았다.
- 기존 API Server 워크플로만 중지 후 시작했다. `node ./scripts/start.mjs` 경유 실행과 `processor_started`를 확인했다.
- 실제 API 자식 프로세스 하나를 대상으로 연결 계정이 새 runtime 계정인지, `verify-only`인지, AI `off`인지 검사했다. AI 키·기존 PG 환경·별도 운영/migration URL이 전달되지 않았음을 값 대신 참/거짓으로 확인했다. `/api/healthz`는 HTTP 200 및 `status: ok`였다.
- 새 계정으로 실행 중인 API에 `node scripts/check-private-access.mjs --run-synthetic`를 실행해 아래 전체 결과를 확인했다. 이 검사는 자체 생성 합성 영상만 사용했고, 개인 영상이나 외부 AI 호출은 사용하지 않았다.

```text
PRIVATE_ACCESS_CHECK TARGET_LOOPBACK_API
PRIVATE_ACCESS_CHECK SERVER_READY
PRIVATE_ACCESS_CHECK SYNTHETIC_UPLOAD_ACCEPTED
PRIVATE_ACCESS_CHECK OWNER_GUIDE_AND_DRAFT_OK
PRIVATE_ACCESS_CHECK SIGNED_IMAGES_OK
PRIVATE_ACCESS_CHECK NO_KEY_AND_WRONG_KEY_DENIED
PRIVATE_ACCESS_CHECK TEST_GUIDE_DELETED
PRIVATE_ACCESS_CHECK PASS
```

이 실환경 검사는 초안 조회, 승인된 이미지 조회, 무권한/잘못된 키 차단, 테스트 가이드 삭제 및 기존 서명 이미지 접근 차단까지 확인한다. 편집 UI의 자동 저장을 다시 수동 검증한 결과로 확대 해석하지 않는다. 검사가 생성한 합성 영상·가이드만 정리했으며 기존 사용자의 영상·가이드는 삭제하지 않았다.

## 남은 범위

앱 DB 계정 분리와 AI가 꺼진 개발 서버 반영은 완료했다. AI 운영자 계정/별도 비밀 전달 경로, 실제 AI 프로젝트의 저장소·요금·한도 확인, 운영 승인 기록 및 고정 합성 입력 활성화는 아직 하지 않았다. 다음 단계에서 별도로 확인한 범위 안에서만 동의 → 실행 → 결과 저장 → 철회/중지를 검증한다. 개인 영상 AI 전송, 공개 배포, 개인정보 영구 가림·공개 공유 완료를 뜻하지 않는다.
