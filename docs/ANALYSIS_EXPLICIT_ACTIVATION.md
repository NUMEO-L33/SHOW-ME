# 승인된 합성 작업의 명시적 활성화 — 2026-09-19

## 범위와 현재 상태

앞 단계인 `ANALYSIS_OPERATOR_LIFECYCLE.md` 이후의 구현 기록이다. 원래 개발 계획의 목표·완료 조건은 수정하지 않았다. 이 문서의 완료는 **로컬 구현/검증**을 뜻하며, Replit 배포나 개인 영상 AI 이용 허가를 뜻하지 않는다.

- 운영 확인 기록 저장과 실제 활성화를 분리했다. 승인 기록을 저장하는 것만으로 실행되지 않는다.
- 별도 운영자 로그인으로 정확한 승인 버전과 고정 합성 작업을 지정해 활성화/중지할 수 있다.
- 활성화 ID·승인 입력 전체 해시·가이드·프로젝트·자격 증명 참조·저장소 참조·만료 시각을 하나로 묶는다. 입력은 기존 동결 합성 화면 두 장으로 제한되며, 실제 이미지 바이트는 기존 비공개 로더가 전송 전에 검증한다.
- 화면의 실행 가능 표시는 현재 준비 검사를 통과할 때만 켜진다. 제품 기본 시작 경로에는 여전히 runtime factory/승인 설정을 주입하지 않으므로 기본 AI 실행은 꺼져 있다.

## 운영 명령과 변경 이력

기존 `admin:analysis-operations` CLI에 `activate`, `deactivate`를 추가했다. 비밀 값은 명령 인수에 넣지 않고 전용 `SHOWME_OPERATOR_DATABASE_URL` 연결만 사용한다. 앱 `DATABASE_URL`이나 PG 환경 변수로 대체하지 않는다. 이 절차는 실제 운영 환경에서 실행하지 않았다.

- `activate`: `--action=activate --deployment=<확인한 대상> --database=<확인한 DB> --confirm-synthetic-activation`
- `deactivate`: `--action=deactivate --deployment=<확인한 대상> --database=<확인한 DB> --confirm-stop`
- Replit 개발 DB라면 기존의 명시적 `--replit-development=<확인한 프로젝트 UUID>` 조건도 그대로 적용한다.
- 명령 JSON은 표준 입력으로 최대 32 KiB만 받는다. 활성화 명령 필드는 `type`, `commandId`, `expectedVersion`, `deploymentRef`, `reviewId`, `expectedReviewVersion`, `grant`다. `grant`는 기존 `SyntheticInputGrant` 전체이며 서버 운영자가 승인한 값이어야 한다.
- `expectedVersion`은 **DB 전체 활성화 이력**의 최신 버전이고 `expectedReviewVersion`은 **해당 배포 운영 확인 기록**의 최신 버전이다. 서로 다른 카운터다. 중지 명령에는 `type`, `commandId`, `expectedVersion`, `deploymentRef`만 필요하다.

Migration `0012_analysis_activation_events`에 실행자 참조, 명령 UUID/해시, 명령 내용, 대상, 활성화 확인값, 시각을 추가 이력으로 저장한다. 공통 제어 행 변경과 이력 저장은 같은 transaction이다. 변경이 조용히 무시되어도 성공으로 보고하지 않고 이력까지 되돌린다.

같은 명령 UUID/내용을 재전달하면 기존 영수증을 반환할 뿐, 중지된 상태를 다시 열지 않는다. 응답의 `authorizesAnalysis:false`는 **영수증 하나가 실행 허가 전체를 대신하지 않는다**는 뜻이다. 실제 실행에는 최신 readiness, 소유자 인증, 외부 전송 동의, 사용량/전송 검사가 추가로 필요하다. `status`의 `lastActivationVersion`/`lastActivationAction`도 과거 마지막 이벤트이지 현재 실행 허가가 아니다.

## 중지 해제 조건과 실행 경계

활성화는 현재 DB가 중지 상태이고, 지정한 최신 운영 기록이 승인·미만료이며, 합성 입력 허가와 대상/기간/한도가 맞을 때만 허용한다. 대기/실행 중인 작업이나 미정산·사용량 불명·초과 요청이 하나라도 있으면 거절한다. 이러한 사고를 무시하거나 사용량을 초기화하는 명령은 추가하지 않았다. 사고가 생기면 실제 상태 확인과 별도 정산 절차가 필요하다.

운영 확인 기록 갱신/철회 및 명시적 중지는 공통 DB 잠금 아래 활성화 확인값을 제거한다. 새 활성화는 새 ID를 쓰므로 오래된 실행기의 캐시나 이전 승인으로 작업을 시작할 수 없다. repository의 실행 대상은 한 번 연결하면 다른 허가로 재설정할 수 없다.

가이드 접수·작업 점유·count/generation 예산 할당 및 **두 종류의 실제 전송 직전**에도 같은 잠금 아래 활성화 대상/ID/만료를 확인한다. 일반 미설정 repository도 활성화된 다른 작업에 접근해 비용을 발생시킬 수 없다. 결과 정산·취소·삭제·안전한 정리는 중지와 별도로 계속 가능하다.

중지는 새로운 전송을 막는 것이며, 이미 네트워크로 나간 요청을 회수했다는 뜻은 아니다. 금액 0 보장이나 원격 IAM 실시간 검증도 아니다. 기존 운영 확인의 유효기간과 재확인 책임은 그대로 유지한다.

## 화면 연결

소유자 인증과 정확한 입력 fingerprint를 요구하는 `/analysis/capabilities`가 runtime의 읽기 전용 준비 검사를 사용한다. 준비 확인 자체는 작업 생성·예산 예약·영상/이미지 업로드·AI 호출을 하지 않는다. 확인 제한 시간 초과/예외/기본 비활성/종료 중에는 `startAvailable:false`를 반환한다. 비동기 확인 후에도 소유권과 입력을 재확인하여 삭제·교체된 가이드를 실행 가능으로 알리지 않는다.

표시는 순간의 상태 확인일 뿐 실행 약속이 아니다. 사용자가 시작하면 기존 동의/접수/전송 검사를 다시 수행한다. 새 표시 응답에는 운영 기록, 키, 프로젝트, 저장소, 모델 정보를 추가하지 않았다.

## 임시 DB에서 확인한 운영자 최소 권한

기존 별도 LOGIN에 다음 권한을 사용했다. 운영 환경에 이 SQL을 적용하지 않았다.

```sql
GRANT USAGE ON SCHEMA public TO "<전용 운영자 역할>";
GRANT SELECT, INSERT ON analysis_operations_reviews, analysis_activation_events TO "<전용 운영자 역할>";
GRANT SELECT, UPDATE(payload) ON analysis_accounting_controls TO "<전용 운영자 역할>";
GRANT SELECT(status) ON analysis_runs, analysis_count_attempts, analysis_request_attempts TO "<전용 운영자 역할>";
```

가이드·단계·실행 payload 읽기, 이력 수정/삭제, 제어 행 삭제는 거절되는지 검사했다. 제어 행 UPDATE는 관리 권한이므로 해당 로그인으로 직접 SQL을 실행하는 악의적 운영자까지 막는다고 주장하지 않는다. 실환경에서는 앱·migration·운영 로그인 분리가 필요하며, 앱 시작 시 migration을 실행하는 현재 경로도 함께 정리해야 한다.

## 검증 및 남은 작업

- 관련 단위/HTTP/수명주기 검사 65개 통과.
- 일반 전체 836개(이관 91 + 서버 659 + 클라이언트 86) 통과. 실패·취소·생략 0.
- 실제 일회용 PostgreSQL 최종 93개 통과. 실패·취소·생략 0. 별도 운영자 로그인, 활성화/중지/재생/동시성/이전 실행기 차단, 실제 count/generation 전송 직전 차단, 이력·제어 행 원자성까지 검사했다. 외부 HTTP는 모의 응답만 사용했으며 각 실행의 임시 컨테이너/DB 정리를 확인했다.
- API 제품/테스트 타입 검사와 서버 빌드 통과.
- 추가 전송 경계 테스트의 최초 실행은 준비 단계에서 generation 전송 상태를 count 검사보다 먼저 만들어 거절됐다. 두 경로의 fixture를 독립적으로 구성하도록 고쳤다. 제품 검사 조건을 완화하지 않았다.

**현재 AI 연결 파트에서 남은 큰 단계: 실환경 연결·최종 합성 검증.**

1. 정확한 Replit 대상 및 별도 DB 역할/권한, 최신 운영 확인을 검증한다. 서버 내부 bootstrap에서 승인 grant와 활성화 ID를 동일한 API DB/Storage에 연결하는 실제 실행 구성을 마무리한다.
2. 승인된 고정 합성 화면만으로 동의 → 실행 → 결과 저장 → 철회/중지까지 실제 환경에서 검사한다. 실제 외부 호출은 대상·범위를 확인한 별도 실행이며, 개인 영상으로 대체하지 않는다.

제품 전체에는 개인정보 영구 가림과 공개 공유 등 원래 계획의 미완료 항목이 별도로 남아 있다. 커밋/푸시·배포·Replit 설정/DB 변경·실제 AI 호출·개인 영상 전송은 이번 단계에서 하지 않았다.

후속 서버 bootstrap·계정 분리 구현 및 실환경 읽기 전용 점검은 `ANALYSIS_REPLIT_BOOTSTRAP.md`에 기록했다. 위 내용은 이 단계 당시의 상태로 보존한다.
