# Replit 개발용 AI 운영자 연결

원래 개발 계획과 AI 활성화 조건은 변경하지 않는다. 앱 실행 계정과 별도로 승인·중지용 DB 로그인 1개를 생성하는 명시적 운영 단계다. HTTP나 앱 시작 시 자동 실행하지 않는다.

## 범위

- `analysis_operations_reviews`, `analysis_activation_events`: SELECT, INSERT.
- `analysis_accounting_controls`: SELECT, UPDATE(payload).
- `analysis_runs`, `analysis_count_attempts`, `analysis_request_attempts`: SELECT(status)만.
- 기존 영상/단계/초안 및 분석 내용 조회·변경, 이력 삭제·변조, 테이블 생성, 다른 역할 상속은 허용하지 않는다.
- 계정은 승인·중지 제어를 변경할 수 있는 보안상 중요한 자격 증명이다. 같은 OS 사용자에 대한 격리나 악의적 운영자의 직접 SQL까지 막는다는 뜻은 아니다.

## 생성

확인한 SHOW-ME 개발 프로젝트의 Shell에서, 별도 사용자 승인을 받은 뒤 실행한다. 운영 배포/다른 프로젝트/기존 운영자 역할/기존 연결 파일이 있으면 중단한다. 기존 연결 파일을 지워 재실행하지 않는다.

```sh
cd artifacts/api-server
node --import tsx scripts/provision-operator.mjs --replit-development=67fdf570-63d0-47d4-a842-742d022f2eb9 --confirm-create-operator
```

내부 개발 DB `helium` 전용 검증과 migration 검증 후 무작위 제한 역할을 만든다. 실제 새 로그인, 잘못된 비밀번호 거절, 테이블/열별 실제 유효 권한을 검사한다. 기존 영상/초안 내용은 읽지 않는다. 권한 검사나 자격 증명 저장이 실패하면 이번에 만든 역할만 정리한다. 권한을 넓혀 우회하지 않는다.

비밀번호는 명령 인수/로그에 출력하지 않고 Git에서 제외된 `.local/showme/operator-db.json`에만 보관한다. 폴더는 0700, 파일은 0600이며 기존 파일은 덮어쓰지 않는다. 앱 시작 스크립트는 이 파일을 사용하지 않는다. 실제 운영 비밀 관리 서비스나 별도 OS 계정의 대체재는 아니다.

운영 CLI `analysis-operations-admin.ts`에 이 별도 연결을 전달할 때도 파일을 안전하게 읽어 프로세스 내부에서만 전달한다. URL 전체를 Shell에 복사하거나 `cat`/환경 출력/문서에 남기지 않는다. `--action=status`는 읽기 전용이고, `put`/`activate`는 각각 별도 실제 운영 근거와 합성 입력 승인을 요구한다.

## 로컬 검증 — 2026-09-20

실제 PostgreSQL 16.15 통합 101개 통과, 실패·취소·생략 0. 생성된 계정으로 기존 운영 CLI의 저장/활성화/중지/철회, 잘못된 비밀번호 차단, 중복 생성 거절, 내용 접근 차단과 추가 열 권한 검출을 확인했다. 저장 실패 시 새 역할 정리도 확인했다. 임시 Docker 데이터는 검사 후 제거됐다. 외부 AI는 모의 응답만 사용했다.

API 제품/테스트 타입 검사와 서버 빌드도 통과했다. 실제 Replit 적용 결과는 아래 후속 기록에 별도로 남긴다. 생성 성공만으로 AI 실행 승인 또는 외부 전송을 완료했다고 보지 않는다.
