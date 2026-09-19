# Replit 서버 시작 연결과 DB 계정 분리 — 2026-09-19

## 완료 범위

`ANALYSIS_EXPLICIT_ACTIVATION.md` 다음 단계의 구현·검증 기록이다. 원래 개발 계획의 목표와 완료 조건은 수정하지 않았다. 이 문서의 완료는 로컬 코드 검증이며, Replit 반영 완료나 개인 영상 외부 전송 허가가 아니다.

- 실제 서버 진입점이 `startConfiguredProcessor`를 사용한다. 기본값은 AI 꺼짐이며, 키가 존재한다고 켜지지 않는다.
- `fixed-synthetic` 모드는 기존 API와 동일한 PostgreSQL pool/repository 및 Replit storage 객체를 사용한다.
- 환경 설정은 기존 활성화 ID와 대상 참조만 선택한다. 승인 grant, 입력, 사용량 한도는 환경 변수나 브라우저가 아니라 현재 DB의 운영 확인·활성화 이력에서 가져온다.
- 시작 시 DB 로그인 권한과 정확한 migration 이력을 읽기 전용으로 검증한다. 별도 운영자 기록, 현재 활성화, 입력 해시, 저장소/프로젝트/자격 증명 참조, 유효기간이 일치해야 연결된다.
- 시작 준비 자체는 이미지 읽기·외부 AI 호출·승인 기록 작성·중지 해제를 하지 않는다. 기존 동의/소유권/전송 직전 검사와 고정 합성 JPEG 바이트 검증도 유지한다.
- 승인 없이 켠 설정, 오래된 활성화, 잘못된 대상 또는 과도한 DB 권한은 시작 실패로 처리한다. 실행 중 만료·철회는 이후 준비/전송 검사에서 차단한다.

## 설정

실환경에는 아직 적용하지 않았다. 아래 이름은 설정 설명이며 비밀 값을 담은 실행 명령이 아니다.

| 설정 | 의미 |
| --- | --- |
| `SHOWME_ANALYSIS_MODE` | 미설정/`off`이면 AI 꺼짐. 명시적인 `fixed-synthetic`만 지원 |
| `SHOWME_DATABASE_MIGRATIONS` | 기존 기본값 `automatic`. 합성 AI 연결에는 반드시 `verify-only` |
| `DATABASE_URL` | 제한된 `showme_runtime_<이름>` 직접 LOGIN 연결 |
| `SHOWME_ANALYSIS_ACTIVATION_ID` | 운영자가 별도로 기록한 현재 활성화 UUID |
| `SHOWME_ANALYSIS_DEPLOYMENT_REF` | 운영 확인 기록과 동일한 배포 참조 |
| `SHOWME_ANALYSIS_PROJECT_REF` | 운영 확인 기록과 동일한 AI 프로젝트 참조 |
| `SHOWME_ANALYSIS_CREDENTIAL_REF` | 비밀 키 자체가 아닌, 확인된 키 버전 참조 |
| `SHOWME_STORAGE` | `replit` |
| `REPLIT_OBJECT_STORAGE_BUCKET_ID`, `REPLIT_OBJECT_STORAGE_PREFIX` | 승인된 정확한 저장 대상 |
| `GEMINI_API_KEY` | 기존 승인된 비밀 전달 경로로만 공급. 로그·명령 인수·문서에 기록하지 않음 |

`verify-only`는 DDL이나 자동 복구를 하지 않는다. 별도 migration 계정이 먼저 체크인된 전체 migration을 적용해야 한다. 누락·변조·추가된 migration 이력이 있으면 시작되지 않는다. 미설정 `automatic`의 기존 시작 동작은 유지한다.

앱 프로세스에 `SHOWME_OPERATOR_DATABASE_URL` 또는 `SHOWME_MIGRATION_DATABASE_URL`이 함께 있으면 합성 AI 연결을 거절한다. 별도 계정의 비밀번호가 앱에 전달되면 SQL 권한 분리의 의미가 약해지므로, 운영/migration 연결은 독립된 관리 실행 환경에만 공급해야 한다. 앱이 상속하는 공통 Replit Secrets에 관리자 연결을 추가하는 방식은 이 분리를 충족하지 않는다. 다른 이름으로 숨긴 비밀이나 외부 인증 시스템까지 이 검사가 탐지한다는 뜻은 아니다.

## 검증한 앱 계정 권한

임시 PostgreSQL 16에서 직접 로그인한 별도 앱 계정으로 검사했다. 실환경 계정 생성·비밀번호 입력·권한 변경은 하지 않았다.

- superuser, CREATE ROLE/DB, replication, BYPASSRLS, 다른 역할 membership을 허용하지 않는다.
- 해당 DB 및 public/drizzle schema/객체의 소유자이거나 schema CREATE 권한이 있으면 거절한다.
- 운영 확인·활성화 이력 및 migration 이력은 SELECT만 허용한다. 테이블 권한뿐 아니라 컬럼 INSERT/UPDATE도 검사한다.
- 제품의 일반 테이블 11개는 기존 repository/readiness가 요구하는 SELECT/INSERT/UPDATE/DELETE를 사용한다.

검증에 사용한 GRANT 범위는 다음과 같다. 실제 DB 이름·계정·승인 범위를 확인하기 전 실행하지 않는다.

```sql
GRANT USAGE ON SCHEMA public, drizzle TO "<제한된 앱 계정>";
GRANT SELECT ON drizzle.__drizzle_migrations,
  analysis_operations_reviews, analysis_activation_events TO "<제한된 앱 계정>";
GRANT SELECT, INSERT, UPDATE, DELETE ON
  guides, guide_steps, guide_drafts, analysis_runs, analysis_budget_windows,
  analysis_reservations, analysis_batches, analysis_accounting_controls,
  analysis_request_attempts, analysis_provider_quota_charges, analysis_count_attempts
  TO "<제한된 앱 계정>";
```

이는 앱이 승인 이력을 쓰거나 schema를 바꾸지 못하도록 하는 분리다. 앱은 일반 데이터·회계 제어 테이블에 필요한 쓰기 권한이 있으므로, DB 자격 증명이 탈취되거나 임의 SQL/관리자 함수가 악용되는 상황까지 완전히 방어한다는 주장은 하지 않는다. 앱 권한 검사도 원격 저장소 IAM 검증이나 과금 0 보장을 대신하지 않는다.

## 기존 SHOW-ME 개발환경에서 읽기 전용으로 확인한 사실

브라우저 확인은 기존 `companynumeo/SHOW-ME` 프로젝트 탭에 한정했다. 비밀 값·개인 영상·가이드 내용은 읽거나 출력하지 않았다.

- 개발 프로젝트 ID: `67fdf570-63d0-47d4-a842-742d022f2eb9`. production 플래그 꺼짐.
- 브랜치 `codex/replit-migration-hardening`, HEAD `1da3188`, 작업 트리 깨끗함.
- 앱 DB, AI 키, Replit bucket 설정은 존재한다. 전용 운영자 연결 및 활성화 ID 설정은 없었다.
- 현재 앱 DB 연결은 DB 소유자·superuser이며 CREATE ROLE/DB 및 BYPASSRLS가 켜져 있다. 새 제한된 시작 조건을 충족하지 않는다.
- migration 이력은 11개였다. 새 `analysis_operations_reviews`, `analysis_activation_events` 테이블은 없다.

위 확인은 DB 카탈로그/이력 개수에 대한 읽기 전용 transaction이다. 배포·migration·설정·권한 변경은 하지 않았다.

## 검증 결과

- 일반 전체 843개: 이관 91 + 서버 666 + 클라이언트 86, 실패·취소·생략 0.
- 실제 일회용 PostgreSQL 97개, 실패·취소·생략 0. 제한된 앱 LOGIN, 컬럼 권한 확대 거절, migration 변조/누락 시 무수정 실패, 저장된 승인으로 시작, 합성 화면 처리/결과 저장, 철회 및 이전 활성화 재생 차단을 포함한다.
- 외부 HTTP와 Replit 저장소는 테스트 대역을 사용했다. 실제 PostgreSQL과 동결 합성 JPEG를 사용했으며, 개인 영상이나 실제 AI 호출은 없다.
- 처음 DB 검사 준비 실패는 Docker가 꺼져 있었기 때문이다. 설치된 Docker를 실행한 뒤 검사를 완료했다. 임시 컨테이너와 임시 DB는 정리했으며 Docker Desktop 자체는 실행 상태로 남겼다.
- API 제품/테스트 타입 검사와 실제 서버 번들 빌드 통과.

## 남은 두 단계와 적용 순서

1. 검증한 로컬 변경을 검토·반영한 뒤 기존 SHOW-ME **개발환경**에 업데이트한다. 앱/운영/migration 로그인과 비밀 전달을 분리하고, AI를 끈 상태에서 migration 적용 → 제한된 앱 계정 및 `verify-only`로 시작 → 기존 업로드/편집/삭제 확인 순서로 진행한다. 기존 가이드/영상 삭제나 공개 배포는 포함하지 않는다. 계정/권한 변경은 범위를 확인한 후 진행한다.
2. 실제 프로젝트의 저장소 접근·요금/한도·다른 전송 경로를 재확인해 운영 기록을 만들고, 승인된 고정 합성 화면만 활성화한다. 동의 → 실행 → 결과 저장 → 철회/중지의 실환경 검증이 남아 있다. 실제 외부 호출 범위를 확인하기 전 활성화하지 않는다.

설정 오류나 승인 만료로 enabled 모드 시작이 실패하면 `SHOWME_ANALYSIS_MODE=off`로 AI를 끈다. `verify-only`와 제한된 DB 계정은 유지하며, 이전 관리자 연결로 조용히 되돌리거나 승인 기한을 자동 연장하지 않는다. 이 조치는 기존 비공개 영상/편집 기능을 위한 복구 경로이고 AI 재개 허가가 아니다.

개인정보 영구 가림·공개 공유 등 제품 전체의 미완료 항목은 별도로 남아 있다. 이번 단계에서는 커밋/푸시·Replit 반영·실환경 권한 변경·실제 AI 호출을 하지 않았다.
