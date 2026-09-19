# B5 후속: 운영자 명령과 서버 시작·종료 연결

2026-09-19. [합성 입력 실행 구성](ANALYSIS_SYNTHETIC_RUNTIME.md)의 후속이다. 원본 개발 계획은 수정하지 않았다. 이번 완료 범위는 **운영자 기록 관리 진입점과 서버 수명주기의 로컬 구현·검증**이다. 실제 운영 권한 부여나 AI 활성화가 아니다.

## 진행 현황과 남은 범위

| 구분 | 상태 |
| --- | --- |
| 합성 입력 승인·이미지 검증·DB 확인·계수/생성/결과 저장 내부 연결 | 완료, 합성/모의 외부 응답으로 검증 |
| 운영 확인 기록의 저장·조회·철회와 전용 로그인 관리 명령 | 이번 단계 코드/임시 DB 검증 완료 |
| 실제 API의 DB/Storage 공유와 시작 실패·종료 연동 | 이번 단계 코드/로컬 서버 검증 완료 |
| 명시적 활성화 절차 및 실제 실행 대상 설정 | 남음 |
| Replit 권한·현재 운영 확인 적용과 승인된 합성 자료 최종 시험 | 남음 |
| 전체 제품의 개인정보 영구 가림·공개 공유 | 이 파트 이후 별도 남음 |

남은 양을 테스트 개수나 근거 없는 퍼센트로 환산하지 않는다. 현재 AI 연결 파트는 **활성화 절차 1단계 + 실환경 적용/최종 검사 1단계**가 남는다. 실제 계정 설정/플랫폼 지원 여부에 따라 실환경 단계의 작업량은 달라질 수 있다.

## 운영자 진입점

공개 웹 관리자 API를 추가하지 않고 `admin:analysis-operations`라는 명시적 셸 명령을 추가했다. 별도 `SHOWME_OPERATOR_DATABASE_URL`로 PostgreSQL에 인증하며 로그인 이름은 `showme_analysis_operator_<개별이름>` 형식이어야 한다. 일반 앱 `DATABASE_URL`, 상속된 `PG*`, JSON 속 역할 주장은 사용하지 않는다.

DB 이름과 배포 참조를 명령에 명시한다. 원격 DB는 기존 검증된 TLS 설정을 재사용하며 Replit 내부 개발 DB 예외는 기존 프로젝트 UUID 확인/DNS 고정 경로로만 선택한다. 대상 검사 실패 시 연결하지 않는다.

```sh
pnpm --filter @workspace/api-server admin:analysis-operations --help
pnpm --filter @workspace/api-server admin:analysis-operations --action=status --deployment=CONFIRMED_DEPLOYMENT --database=CONFIRMED_DATABASE
pnpm --filter @workspace/api-server admin:analysis-operations --action=put --deployment=CONFIRMED_DEPLOYMENT --database=CONFIRMED_DATABASE --confirm-stop < operator-command.json
```

실제 대상과 권한을 먼저 확인해야 하는 사용 예시이며 이번에 실서비스에서 실행하지 않았다. 승인된 Replit 개발 DB에는 `--replit-development=CONFIRMED_PROJECT_UUID`를 추가한다. 연결 문자열/비밀번호를 명령 인수나 JSON에 넣지 않는다.

- 쓰기 명령 JSON은 표준 입력으로 최대 32 KiB만 받는다. `put`/`revoke`와 대상 배포가 CLI 선택과 일치해야 하며 `--confirm-stop`이 필수다.
- `put`의 `review`는 기존 운영 확인 스키마에서 `reviewerRef`만 뺀 내용이다. 작성자 참조는 인증 연결의 역할에서 부여하고 DB transaction이 `session_user=current_user`와 허용 역할을 다시 확인한다. 입력의 `reviewerRef`는 거절한다.
- 확인 시각·만료·다섯 운영 확인 항목·정책·기대 버전·명령 UUID는 여전히 필요하다. 과거 확인을 현재 시각으로 자동 갱신하거나 미확인을 승인으로 채우지 않는다.
- 신규 저장/갱신/철회는 기존 공통 잠금 아래 AI 실행을 중지한다. 출력은 항상 `authorizesAnalysis:false`다. 재개/중지 해제 기능은 없다.
- 응답이 불명확한 쓰기는 `writeOutcome:unknown`으로 보고한다. 새 UUID로 재시도하지 말고 같은 명령 UUID/내용으로 상태를 확인한다. 과거 명령의 재생 영수증은 현재 상태가 아니므로 `status`로 최신 버전/철회 상태를 조회해야 한다.
- 원문 DB 오류·연결 문자열·비밀번호·명령 본문은 출력하지 않는다. CLI만의 대기 제한과 종료 신호 처리가 있으며 앱 서버나 공유 pool을 종료하지 않는다.

## 최소 권한: 검증한 구성과 운영 적용의 구분

임시 DB에서 별도 로그인 역할에 다음 권한만 주어 실제 관리 명령을 검증했다. 기본 스키마 접근/DB CONNECT가 필요하며 역할은 superuser, role 생성, DB 생성, replication, RLS 우회 권한을 갖지 않는다.

```sql
-- 예시일 뿐: 대상 DB/개별 로그인/비밀 관리 방식을 확정한 뒤 관리자 권한으로 적용한다.
CREATE ROLE showme_analysis_operator_alice LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO showme_analysis_operator_alice;
GRANT SELECT, INSERT ON public.analysis_operations_reviews TO showme_analysis_operator_alice;
GRANT SELECT, UPDATE(payload) ON public.analysis_accounting_controls TO showme_analysis_operator_alice;
```

비밀번호는 별도 비밀 관리 절차로 설정해야 한다. SQL 파일에 실제 비밀번호를 넣지 않는다. 이 예시는 역할을 생성하는 자동 migration이 아니다. 운영 DB에는 적용하지 않았다.

해당 역할이 가이드/단계 데이터를 읽거나 운영 이력을 수정/삭제하거나 제어 행을 삭제할 수 없음을 검사했다. 제어 payload UPDATE 권한 자체는 직접 SQL로도 사용할 수 있는 관리 권한이다. CLI가 중지만 제공한다고 DB 역할까지 임의 SQL을 실행할 수 없다고 주장하지 않는다. 신뢰하는 운영자 전용 로그인과 접근 관리가 필요하다.

앱 실행 로그인과 migration/관리 로그인을 실제로 분리하고 앱의 운영 이력 쓰기 권한을 제거하는 작업은 **실환경 적용에서 남아 있다**. 현재 앱이 사용하는 로그인 권한을 조회/변경하지 않았다. 공유 DB 로그인은 개별 사람의 신원 증명이 아니므로 계정 공유를 피해야 한다.

## 서버 수명주기

`startProcessor`에 서버 내부에서만 주입하는 `createAnalysis` 연결부를 추가했다. 기본 실행에는 공급자가 없으므로 기존처럼 AI를 켜지 않는다. 환경 변수 하나나 브라우저 요청으로 구성 함수를 주입할 수 없다.

`attachFixedSyntheticAnalysisRuntime`은 API가 이미 만든 PostgreSQL repository의 실제 pool과 동일한 Replit storage 객체를 사용한다. 다른 DB 객체, 로컬 저장소, 다른 버킷/접두사를 연결하면 거절한다. 버킷 대상 일치는 원격 IAM 확인을 대신하지 않는다.

- 기존 DB migration·DB/Storage 시작 점검·미디어 실행 파일 확인을 마친 뒤 AI 실행기를 시작한다.
- 시작 완료 전 또는 종료 시작 후 새 분석 접수를 거절한다. worker 시작 자체는 운영 승인이나 전송 허가가 아니다.
- 종료 시 먼저 readiness를 내리고 승인/측정값을 무효화하여 AI 작업을 중지한 뒤 HTTP·영상 작업·정리 작업·DB를 닫는다. 중복 `close()`/`stop()`은 한 번의 종료를 공유한다.
- 시작 실패 때도 이미 구성한 AI 실행기를 정리한다. 종료 오류가 나더라도 나머지 자원 정리를 시도한다.
- 합성 runtime은 caller의 pool을 닫지 않는다. 서버 전체의 pool 종료 책임은 기존 repository 소유권에 남긴다.

일반 시작 경로는 아직 구체적인 승인 설정을 주입하지 않는다. 사용자 화면의 `startAvailable:false`도 유지한다. 명시적 활성화 단계에서 공통 중지 해제 조건/기록, 현재 승인 대상 선택, 표시 상태와 실행 상태의 일치를 함께 마무리해야 한다. 수동 SQL로 중지를 풀어 제품 완료로 처리하지 않는다.

## 검증

- 관련 단위 **16개** 통과(이번 새 검사 10개 포함). 실제 로컬 HTTP 서버 시작/종료와 시작 실패 정리를 검사했다.
- 일반 전체 **830개(이관 91 + 서버 653 + 클라이언트 86)** 통과. 실패·취소·생략 0, 종료 코드 0.
- 실제 임시 PostgreSQL 최종 **88개** 통과. 별도 LOGIN의 실제 인증·최소 권한·작성자 바인딩·저장/조회/중복/철회·잘못된 비밀번호 거절, API의 동일 DB/Storage 연결·worker 중지를 추가 검증했다.
- 최초 DB 실행은 87개 통과/1개 실패였다. 기존 만료 검사가 PC의 현재 시각을 만료 시각으로 사용해 DB 시계와의 미세한 차이에 따라 이미 만료된 입력이 되지 않을 수 있었다. DB의 현재 시각보다 250ms 이른 값을 사용하도록 테스트를 수정했다. 제품 만료 조건은 바꾸지 않았으며 전체 재검사를 통과했다.
- API 제품/테스트 타입 검사·서버 빌드 통과. 두 DB 실행의 일회용 컨테이너/데이터와 테스트 전용 역할 정리를 확인했다.

로컬 미커밋 상태다. 실제 운영 로그인 생성·권한 변경·Replit DB/Storage 변경·실제 AI 호출·개인 영상 전송·커밋/푸시·배포는 하지 않았다.

후속 구현: 명시적 활성화/중지와 준비 상태 표시 연결은 `ANALYSIS_EXPLICIT_ACTIVATION.md`에 기록했다. 위 내용은 이 문서를 작성한 단계의 이력으로 보존한다.
