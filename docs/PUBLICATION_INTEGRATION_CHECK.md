# 합성 DB + 저장소 통합 게시 검사

## 목적과 범위

저장소 단독 검사는 임시 JSON metadata를 사용한다. 이번 도구는 같은 게시/PNG/철회 검사를 **기존 Replit 개발 DB의 runtime 계정과 실제 Replit Storage를 함께 사용해** 실행하기 위한 별도 진입점이다. 도구 구현과 실환경 검사 통과는 구분한다.

- 새 UUID의 합성 가이드 한 개만 만든다. 기존 가이드/영상/초안/다른 게시 작업은 입력받지 않는다.
- 고정 합성 JPEG로만 시험한다. 영상 녹화·업로드·장면 추출·외부 AI 시험이 아니다.
- 기존 개발 runtime binding을 읽는다. 셸의 관리자 `DATABASE_URL`이나 별도 operator/migration URL로 대체하지 않는다. 프로젝트, 기존 최소 권한 역할, 정확한 migration 이력을 확인하고 쓰기를 시작한다. 새 migration/역할/권한을 만들지 않는다.
- 원격 객체는 `diagnostics/publication/<새 UUID>/`의 네 키로 제한한다. 게시 가이드 생성은 하나의 DB 트랜잭션으로 ready 상태까지 확정해, 기존 앱 처리기가 중간 queued 상태를 가져가지 못하게 한다.
- 진단 repository는 새 가이드 ID만 허용한다. 게시/만료 정리 검색도 SQL의 WHERE에서 같은 ID를 제한한 뒤 LIMIT를 적용한다. 허용하지 않은 메서드는 거절한다.
- 검사 HTTP listener는 loopback뿐이다. 앱 기본 공개 실행기나 AI를 켜거나 운영 Publish를 누르지 않는다. 다만 실제 개발 DB에 잠시 생성되는 합성 게시 기록을 완전히 독립된 DB처럼 표현하지 않는다. 인터넷 수신자/실제 휴대폰 검증은 별도다.

## 실행 전 조건

먼저 일회용 로컬 PostgreSQL 검사로 성공/렌더 실패 모두에서 새 가이드 정리와 다른 가이드 보존을 검증한다. 그 뒤 승인된 Replit 개발 작업본을 검증한 코드에 맞춰 반영한다. 기존 저장소 단독 실행 명령은 동작과 범위가 유지된다.

API 디렉터리에서, 확인한 개발 프로젝트에만 실행:

```sh
node --import tsx scripts/check-publication-integration.mjs --replit-development=<확인한 개발 프로젝트 UUID> --confirm-synthetic-storage --confirm-synthetic-database
```

`--confirm-synthetic-database`는 저장소 단독 명령과 구별하기 위한 명시적 인수다. 운영 deployment, 다른 프로젝트, AI 활성 상태에서는 거절한다. 실행기나 관리자 권한을 자동 활성화하지 않는다.

## 완료 조건

기존 저장소 검사의 원본 바이트 보존, 실제 가림 PNG/썸네일 일치, 인증 거부, 철회 후 JSON/이미지 404, 원격 객체 삭제 확인에 더해:

1. `POSTGRES_GUIDE_CREATED`: 새 합성 가이드가 실제 DB에 확정됨.
2. `POSTGRES_FIXTURE_REMOVED`: 시험 객체 삭제 확인 후 가이드와 연관 metadata가 사라짐. 조회는 생성한 가이드 ID 한 개로만 제한한다.
3. 최종 `PUBLICATION_INTEGRATION_CHECK PASS`, `databaseFixtureRemoved:true`, `remoteObjectsRemoved:true`, `localFixtureRemoved:true`, `pendingIO:false`, 종료 코드 0을 모두 확보함.

파일 렌더 실패도 시험 가이드와 파일만 정리한다. DB/저장소 I/O가 남거나 삭제 확인이 실패하면 PASS로 표시하지 않고, 자체 임시 `storage-check.jsonl`과 미완료 상태를 남긴다. DB 가이드 ID는 삽입 전에 기록하며 비밀번호·접속 문자열·소유자 토큰은 로그에 출력하지 않는다. 이미 시작된 쓰기를 타임아웃만으로 종료됐다고 간주하거나 새 시험으로 덮지 않는다.

## 검증 상태 — 2026-09-23

로컬 일반 검사 **1,056개**(이관 101 / 서버 839 / 화면 116), 실패·취소·생략 0을 확인했다. 서버는 최종 코드로 전체 재실행해 839개 통과를 확인했고, 새 범위/권한/정리 집중 6개도 별도 통과했다. API 제품/테스트 타입 검사와 서버 빌드, diff 공백 검사도 통과했다. 첫 새 테스트 두 개는 비교 기준을 개인정보 확인 저장 전으로 잡아 updatedAt가 달랐던 테스트 오류이며, 실제 시험 시작 직전 스냅샷으로 수정했다. 최초 빌드는 Windows 샌드박스의 경로 접근 거부로 실패했고 같은 명령의 권한 있는 실행에서 통과했다. 설치/의존성 변경은 없었다.

처음에는 Docker Linux 엔진 named pipe가 없어 실제 DB 검사를 실행하지 못했다. 사용자 재개 요청 후 엔진 29.7.2 연결을 확인하고 기존 일회용 DB runner를 실행했다. **실제 PostgreSQL 16.15 검사 137개 전부 통과**(새 성공/렌더 실패 두 검사 포함), 실패·취소·생략 0, 종료 코드 0이다. migration 0000–0017을 사용했고, 다른 가이드의 queued 작업 보존·자기 자료 삭제·SQL 범위 제한을 확인했다. 일반 검사 안의 JSON 대체 검사를 실제 SQL 검증으로 계산하거나 이전 135개 결과로 대체한 것이 아니다.

컨테이너 `showme-b5-5bbbb3ef35c443b48a0d15e20db29be1`은 이번 실행의 고유 소유권 label을 확인한 뒤 runner가 정리했다. `postgres_fixture_removed`와 `disposableDataRemoved:true`를 확인했다. 기존 이미지로만 실행했고 다운로드·영구 호스트 마운트·다른 컨테이너 삭제는 없었다.

위 137개는 실제 로컬 PostgreSQL과 임시 LocalStorage 결과다. 일반 1,056개/타입 검사/빌드는 그 이전 단계 결과이며 DB 재개 때 다시 실행했다고 표기하지 않는다. 원래 개발 MD 목표·완료 조건은 변경하지 않았다.

## 실제 Replit 결합 검사 — 2026-09-23

검증본 `b4efa09`를 기존 개발 브랜치에 푸시하고, 변경 없는 SHOW-ME 개발 작업본 `75774cf`에서 fast-forward했다. 확인한 프로젝트의 기존 runtime binding으로 위 명령을 한 번 실행했다. 새 역할·권한·migration·키를 만들거나 변경하지 않았다.

확보한 결과:

```text
PUBLICATION_INTEGRATION_CHECK RUNTIME_ROLE_AND_SCHEMA_OK
PUBLICATION_STORAGE_CHECK POSTGRES_GUIDE_CREATED
PUBLICATION_STORAGE_CHECK SOURCE_ROUNDTRIP_OK
PUBLICATION_STORAGE_CHECK PROCESSED_PIXELS_AND_SOURCE_PRESERVATION_OK
PUBLICATION_STORAGE_CHECK WITHDRAWAL_AND_PROCESSED_DELETION_OK
PUBLICATION_STORAGE_CHECK POSTGRES_FIXTURE_REMOVED
PUBLICATION_INTEGRATION_CHECK PASS
PUBLICATION_INTEGRATION_EXIT 0
```

최종 저장소 결과도 PASS이며 `applicationDatabaseUsed:true`, `database:"postgres"`, `databaseFixtureRemoved:true`, `remoteObjectsRemoved:true`, `localFixtureRemoved:true`, `pendingIO:false`다. 시험 가이드/연관 행과 전용 객체 네 개 및 임시 파일 정리를 확인했다. `externalAIUsed:false`, `publicListener:false`이며 개인 영상은 사용하지 않았다.

검사 후 기존 앱 health 200, 정확한 API 작업 폴더/entrypoint의 프로세스 한 개, AI off, migration verify-only, Replit 저장소, AI 키/별도 operator·migration DB URL 없음과 깨끗한 git 상태를 확인했다. 기존 서버의 재빌드·재시작·공개 실행기 활성화·운영 Publish는 하지 않았다. 최신 소스로 실행한 별도 진단의 결과이지 운영 공개/인터넷 수신자/실제 모바일 검증은 아니다. 저장소 전체 IAM/ACL 확인과 불확실 원격 쓰기 해소, 공개 활성화 승인/외부 수신 검증은 남는다.
