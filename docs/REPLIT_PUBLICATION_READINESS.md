# Replit 개발환경 게시 기반 반영 기록 — 2026-09-22

## 후속 반영 완료 — 2026-09-22

사용자가 코드 커밋·푸시, 기존 Replit 개발환경 업데이트, migration 0013–0017, 기존 runtime 계정의 최소 테이블 권한 반영, API 재시작을 승인했다. 기능 작업을 `feb29ec`로 커밋·푸시하고 Replit을 fast-forward했다. 버전 혼합을 피하려고 기존 web/API workflow를 중지했으며 mockup workflow는 변경하지 않았다. 공개 활성화·운영 Publish·외부 AI 호출은 이 범위에 포함하지 않는다.

DB 변경 전 Replit 전체 검사에서 3건이 실패하여 migration/권한 반영을 보류했다. 무인수 DB 검사 CLI가 15초 내 시작하지 못했고, 비추적 실제 JPEG 읽기가 `ANALYSIS_IMAGE_UNAVAILABLE`로 실패했으며, 저장소 timeout 검사는 기대한 4개 대신 3개 read만 시작했다. JPEG 오류의 상세 원인을 이 출력만으로 단정하지 않는다. 실패한 검사를 생략하거나 추적 모드의 성공으로 대체하지 않는다.

CLI의 저장소 모듈 로딩은 명시적 실행 인수·대상 검증 이후로 옮겼다. 저장소 timeout 검사는 실제 4개 read의 시작 신호 후 모의 시각을 진행하도록 수정했다. 전체 test runner는 작은 호스트에서 TypeScript 시작과 미디어 자원 경쟁을 줄이도록 파일 단위 직렬 실행으로 변경했다. 개별 검사의 요청/worker 동시성, 제품 제한시간, 자격 검사와 환경 격리는 그대로다. 로컬 집중 64개와 일반 전체 1,044개(이관 100 / 서버 828 / 클라이언트 116), API 제품/테스트 타입 검사·빌드를 통과했다.

보완 커밋 `227a7ef`를 푸시하고 Replit에 fast-forward했다. Replit 전체 **1,044개 통과**, 실패·취소·생략 0, `REPLIT_RELEASE_TEST_EXIT 0`을 확인했다. `pnpm run build`의 workspace 타입 검사와 API/화면/mockup 빌드도 `REPLIT_BUILD_EXIT 0`이다. 기존 UI 라이브러리 sourcemap 및 600.81 kB 번들 크기 경고는 남아 있다.

명시적 프로젝트 UUID, 관리자와 기존 binding의 같은 DB 대상, API 포트 연결 거절(중지), 기존 이력 13개의 hash/시각을 검증했다. advisory lock을 잡고 Drizzle transaction으로 **0013–0017을 적용하여 이력 18개 전체가 소스와 일치**함을 확인했다. migration 전후 guides/guide_steps/guide_drafts는 각각 **1/1/1**로 동일하다. 기존 가이드·영상·초안 내용을 읽거나 수정하는 DML은 실행하지 않았다.

기존 runtime login만 대상으로 새 4개 테이블의 SELECT/INSERT/UPDATE/DELETE와 `guide_publications`의 SELECT/INSERT/DELETE를 부여했다. 실제 runtime 연결로 5개 테이블 권한을 재검증했고, immutable publication UPDATE 및 TRUNCATE/REFERENCES/TRIGGER 권한은 거절된다. 기존 `verifyAnalysisRuntimeRole` 전체 검사도 통과했다. 새 계정·비밀번호·키·기본 권한 정책은 만들거나 변경하지 않았다.

기존 API/web workflow를 다시 시작했다. UI 실행 상태가 불확실했던 구간에서 API 프로세스 0개가 관측되어 완료로 취급하지 않았다. 재실행 후 정확한 API 작업 폴더/entrypoint의 프로세스 **1개**, 기존 binding과 DB 연결 일치, `verify-only`, AI `off`, 실행 API에 Gemini 키와 별도 operator/migration DB URL 없음, loopback health **200**을 확인했다. Preview 새로고침 후 ShowMe 초기 화면과 외부 AI/공개 공유 비활성 안내가 정상 표시된다. mockup workflow는 중단하지 않았다.

**개발환경 코드·DB·권한 반영과 재시작까지 완료이며 공개 기능 활성화/운영 배포 완료는 아니다.** 기본 bootstrap은 여전히 게시 실행기를 주입하지 않는다. .env·키·원래 개발 MD의 목표와 완료 조건은 변경하지 않았다. 실제 외부 AI 호출이나 개인 영상 전송, 신규 합성 영상 업로드도 이번 반영에서는 하지 않았다. 후속은 별도 범위의 합성 자료로 Replit 저장소 쓰기·재읽기·정리 및 게시/철회 실환경 검증과 활성화 검토다. 전체 IAM/ACL 감사, 불확실 원격 쓰기의 운영 해소, 실제 수신자/모바일 검증은 여전히 남는다.

## 변경 전 읽기 전용 점검 기록

대상은 기존 `companynumeo/SHOW-ME` 개발 작업영역이다. 사용자의 진행 요청에 따라 현재 코드·DB·실행 계정·저장소 연결을 조회했다. 배포, 코드 업데이트, migration, 권한 변경, 서버 재시작, 공개 활성화는 실행하지 않았다. 원래 개발 MD의 목표·완료 조건은 변경하지 않는다.

## 확인 결과

| 항목 | 현재 관측 |
| --- | --- |
| Replit 체크아웃 | `codex/replit-migration-hardening`, `a2aecd9`, 변경 파일 없음. 로컬 tracking ref도 같은 커밋이며 원격 fetch는 하지 않았다. |
| 로컬 작업본 | 같은 브랜치의 HEAD `1896e79`. 후속 게시 API·실행기·UI 변경은 미커밋·미푸시 상태로 보존돼 있다. |
| 현재 DB 이력 | 13개, Replit 현재 소스의 migration 0000–0012와 hash/시각까지 정확히 일치. |
| 새 코드 필요 이력 | 로컬은 18개, 0000–0017. 추가 반영 대상은 0013–0017의 5개다. |
| 새 테이블 | `guide_assets`, `publication_jobs`, `publication_heads`, `guide_publications`, `private_media_cleanup` 모두 아직 없음. |
| 기존 앱 계정 | 비공개 runtime binding으로 실제 DB 연결 성공. 기존 `verifyAnalysisRuntimeRole` 전체 읽기 전용 검사 통과. |
| 기존 테이블 권한 | guides/guide_steps/guide_drafts의 SELECT/INSERT/UPDATE/DELETE 허용. 운영 승인/활성화 이력 및 migration 이력의 SELECT 허용, INSERT/UPDATE/DELETE 거부. |
| 실행 API | 정확한 API 작업 폴더와 `dist/index.mjs`로 식별한 프로세스 1개. DB 연결은 runtime binding과 일치하고 migration은 `verify-only`. |
| AI/관리자 환경 | 실행 API의 AI mode `off`, AI 키 없음, 별도 operator/migration DB URL 없음. 비밀값은 출력하지 않았다. |
| 건강 상태 | 기존 loopback `/api/healthz` HTTP 200, `status: ok`. |
| 저장소 | 실행 API는 `replit` 저장소와 명시적 bucket 설정을 사용하며 셸 설정과 일치. 같은 bucket에 대한 SDK 인증 목록 조회 성공. |

DB 확인 연결에는 `default_transaction_read_only=on`을 강제했다. 실제 가이드/영상/초안 내용은 조회하지 않았다. 기존 역할 검사도 읽기 전용 트랜잭션이다. 저장소는 앱 prefix 아래 임의의 존재하지 않는 진단 prefix만 조회했으며 결과가 비어 있음을 확인했다. 기존 객체 이름·내용은 출력하지 않았고 업로드/수정/삭제는 하지 않았다.

프로세스 식별 첫 명령은 숫자 정규식 escape 오류로 0개를 반환했다. 그 값을 서버 부재로 해석하지 않았으며 조건을 수정한 후 정확한 대상 1개와 위 설정을 확인했다.

## 이 점검이 보장하지 않는 것

- 저장소 인증 목록 조회 성공은 전체 IAM/공개 ACL 감사, 새 처리본 쓰기·재읽기·삭제 검증이 아니다.
- Replit 개발환경 점검이며 공개 배포용 비밀 전달/역할/실제 외부 수신자 검증이 아니다.
- 새 테이블이 없으므로 새 테이블의 runtime 권한은 아직 확인할 수 없다. 기존 역할 생성 스크립트를 다시 실행해 계정을 추가하는 것으로 대체하지 않는다.
- 기본 제품 bootstrap은 여전히 게시 실행기를 주입하지 않는다. 새 코드/DB를 반영하는 것만으로 공개 기능을 활성화했다고 표시하지 않는다.
- 기존 일반 1,043개 및 PostgreSQL 135개 통과는 앞선 로컬 검증 결과다. 이번에는 테스트 전체나 합성 업로드를 재실행하지 않았다.

## 다음 반영 범위

실제 변경 승인 후 검증한 작업본을 커밋·푸시하고, Replit 변경 없음/대상 커밋을 다시 확인한 뒤 개발환경에 반영한다. 기존 데이터 보존과 이전 버전 호환성을 확인하고, 정확한 migration 0013–0017 및 기존 runtime 역할에 필요한 최소 권한만 적용한다. 코드·DB 불일치 상태에서 앱을 실행하지 않도록 API 중지/재시작 순서를 정해야 한다.

그 후 migration 이력·최소 권한·health를 다시 확인하고, 별도로 승인한 합성 자료에 한해 새 기능의 실환경 검증을 진행한다. 공개 활성화, 일반 개인 영상 AI 전송, 운영 배포는 이 읽기 전용 점검의 승인을 확대 적용하지 않는다. 불확실 원격 쓰기의 운영 해소 절차와 저장소 권한 확인도 활성화 전에 남아 있다.
