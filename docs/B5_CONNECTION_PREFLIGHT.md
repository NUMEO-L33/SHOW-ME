# B5-B4 연결 준비 — 2026-09-16

상태: **오프라인 설정 점검 구현 완료, 실제 DB·저장소 연결 대기.** B5 전체 완료나 분석 활성화 승인이 아니다. 기존 계산→생성 실행 경계는 [B5-B3b5](B5_COUNT_EXECUTION.md)를 따른다.

## 1. 확인한 범위

- 사용자는 ShowMe용 PostgreSQL·App Storage를 아직 만들지 않았다고 답했다. 이는 Replit이 자동으로 준비한 개발 DB까지 없다는 뜻은 아니다. 프로젝트 화면은 아직 확인하지 못했다.
- 후속 Replit 홈 화면에는 `Numeo`만 표시됐고 사용자는 ShowMe 프로젝트 자체가 아직 준비되지 않았다고 정정했다. 기존 ShowMe Replit 프로젝트가 있다고 가정했던 안내를 수정한다. 현재 ShowMe 코드는 로컬에 있으며, GitHub 최신 반영 → Replit 가져오기 → DB 확인 순서로 진행한다.
- 현재 PC의 실행 환경과 `processor/.env`에서는 Gemini 키 설정만 있고, `DATABASE_URL`, `SHOWME_STORAGE`, `CORS_ORIGINS`, `ASSET_TICKET_SECRET`, `EXPECTED_MEDIA_VERSION`은 없다. 키 값은 출력하지 않았다. 이 결과로 Replit Secrets를 판단하지 않는다.
- 기존 무료 Gemini 프로젝트·결제수단 미연결 및 Replit 월 추가 예산 $0.02는 사용자 확인 기록을 유지한다. 이번에 계정에서 재검증한 것은 아니다.
- DB·버킷 생성, Secrets/키/과금 변경, Gemini 전송, 배포·푸시는 하지 않았다.

## 2. 추가한 점검 기능

```sh
npm run processor:preflight
npm run processor:preflight -- --json
```

`processor/src/analysis-preflight.ts`는 서버를 시작하지 않고 현재 환경의 설정 유무·형식만 검사한다. DB/Storage 클라이언트 생성, 연결, migration, FFmpeg 실행, Google 호출, 파일 변경은 없다. 키·연결 문자열·호스트·버킷 ID·잘못 입력한 값은 보고서에 넣지 않는다.

| 설정 | 검사 범위 |
|---|---|
| `DATABASE_URL` | PostgreSQL URL 형식·호스트·DB 경로 |
| `SHOWME_STORAGE` | 운영용 `replit` 선택 |
| `CORS_ORIGINS` | 자격 증명·경로·와일드카드 없는 HTTPS origin 목록 |
| `ASSET_TICKET_SECRET` | base64url 형식과 최소 32바이트; 무작위성은 증명하지 않음 |
| `EXPECTED_MEDIA_VERSION` | 정확한 버전 표기; 지원 여부·실제 바이너리는 미검증 |
| `GEMINI_API_KEY` | 비어 있지 않은 키 형식; 유효성·프로젝트·등급은 미검증 |
| 선택 설정 | 저장소 prefix 형식, 명시적/기본 버킷 선택 여부 |

버킷 ID는 기본 버킷을 사용하면 생략할 수 있으므로 필수 누락으로 처리하지 않는다. `settingsShapeValid`는 위 목록의 형식 검사만 의미하며 전체 서버 설정 검증이 아니다.

모든 값이 있어도 `ready: false`, `enablesAnalysis: false`다. DB/저장소/미디어 실행·현재 승인 입력·상한 근거·프로젝트 한도·호스팅 사용량·실제 준비 검증기는 별도의 미검증 항목으로 남는다. 이 보고서는 `AnalysisAdmissionReadiness`의 증거로 사용할 수 없다. 기존 시험 동의 환경값도 이를 바꾸지 않는다.

직접 CLI 실행은 미검증 상태를 종료 코드 2로 표시한다. 이 Windows 환경의 npm 실행 래퍼에서는 비정상 종료 코드 1로 전달될 수 있다. `--help`는 0이며, 지원하지 않는 옵션은 1이다. `--live`·`--send`·`--migrate` 옵션은 없다.

## 3. 다음 행동 — 프로젝트 가져오기 후 DB 확인

먼저 최신 로컬 변경을 검사해 GitHub에 반영하고, Replit의 Import → GitHub에서 `NUMEO-L33/SHOW-ME`를 가져온다. 코드 가져오기와 서비스 게시·운영 DB 생성은 별개다. `.env`·비밀 키·로컬 시험 자료는 GitHub에 포함하지 않는다. 다음 DB 안내는 **Replit에 프로젝트가 생긴 뒤** 진행한다.

1. 기존 ShowMe Replit 프로젝트에서 **Tools → Database**를 연다.
2. 데이터베이스 목록과 **Development** 대상의 존재 여부를 확인한다. 공식 문서는 개발 DB가 앱에 자동으로 준비된다고 안내하므로, 먼저 확인하고 불필요한 중복 DB는 만들지 않는다. [Database 안내](https://docs.replit.com/features/data-and-storage/sql-database)
3. 사용자에게는 비밀값 없는 목록/Overview 화면만 요청한다. Settings의 연결 문자열·비밀번호, Secrets 값은 채팅에 보내지 않는다.

현재 방식의 개발 DB는 해당 앱 안에서 접근하도록 제한된다. Windows `.env`에 URL을 복사하면 연결된다고 가정하지 않고, 이후 연결 시험은 Replit 실행 환경에서 진행한다. 기존 Neon 기반 프로젝트는 별도 확인한다. [연결 범위](https://docs.replit.com/features/data-and-storage/connection-details)

운영 DB는 게시 과정에서 별도로 생성되며 개발 DB와 과금 조건도 다르다. 지금은 **Publish를 누르거나 운영 DB를 만들지 않는다.** 개발 DB가 준비돼 있어도 운영 DB 검증 완료로 기록하지 않는다. [개발/운영 DB 구분](https://docs.replit.com/features/data-and-storage/development-and-production)

DB 대상을 확인한 뒤 App Storage와 서버 실행 조건을 순서대로 준비한다. App Storage는 별도 도구에서 버킷을 생성할 수 있지만 이번 단계에서는 생성하지 않았다. 사용량 비용과 포함 크레딧도 확인해야 한다. 기존 `processor/drizzle` migration이 스키마 기준이므로 Replit Agent에 임의 테이블 생성을 요청하지 않는다. [App Storage](https://docs.replit.com/features/data-and-storage/object-storage), [사용량 과금](https://docs.replit.com/billing/about-usage-based-billing)

## 4. 검증 결과

- 사전 점검 전용 7개: 누락, 형식 오류, 비밀값 미출력, 기본 버킷, 잘못된 옵션, 운영 플래그가 있어도 외부 연결 없음, 준비 증거로 사용 불가.
- processor **476개** + client **4개** = **480개 통과**.
- processor 타입 검사·빌드, 전체 lint 통과.
- 이전 실제 PostgreSQL 43개 검증은 이번에 재실행하지 않았다. DB 코드·스키마는 이번 단계에서 바꾸지 않았다.
- 사이트 화면·호스팅은 변경하지 않았고 사이트 빌드는 재실행하지 않았다.
- 운영 DB·비공개 저장소·실제 Replit 미디어 실행 검증은 대기 상태다.
