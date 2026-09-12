# Gemini 시작하기 — Gate 3B-1

작성일: 2026-09-12 · 범위: 로컬 Gemini 어댑터와 가상 화면 시험

사용자 선택에 따라 첫 AI 공급자를 Gemini로 정했다. 현재 모델 ID는 `gemini-3.8-flash`, 프롬프트 버전은 `showme-gemini-ko-v1`이다. 모델은 자동으로 교체하지 않는다. 이 단계는 공개 서비스에 AI 기능을 켠 것이 아니다.

## 1. 키 없이 먼저 확인하기

프로젝트 폴더에서 실행한다.

```powershell
npm run processor:gemini:smoke
```

이 명령은 설치된 FFmpeg로 `SETUP → READY` 가상 화면 JPEG 2장을 만든다. 실제 녹화 파일을 읽지 않고 외부 통신도 하지 않는다. 출력의 `prepared-not-analyzed`는 **준비 완료, AI 분석 미실행**이라는 뜻이다. 생성 폴더는 `processor/.data/gemini-smoke/dry-run-*`이며 Git에 포함되지 않는다.

## 2. Google에서 테스트용 키 준비하기

1. [Google AI Studio의 API 키 화면](https://aistudio.google.com/api-keys)에서 테스트 전용 키를 만든다. 현재는 새 auth key를 사용한다. 키는 비밀번호처럼 보관한다. [Google 키 안내](https://ai.google.dev/gemini-api/docs/api-key).
2. 그 키가 속한 프로젝트가 **Free tier**인지 확인한다. 이 시험을 위해 유료 과금·선불 크레딧을 활성화하지 않는다. 무료 한도·모델 이용 가능 여부는 계정과 시점에 따라 달라질 수 있다. [Google 가격 안내](https://ai.google.dev/gemini-api/docs/pricing).
3. `processor/.env.example`을 참고해 로컬 `processor/.env`를 만든다. 기존 파일이 있다면 덮어쓰지 말고 아래 세 항목만 수정한다. **키를 채팅, Git, 화면 캡처, 웹 클라이언트의 `NEXT_PUBLIC_` 변수에 넣지 않는다.**

```dotenv
GEMINI_API_KEY=여기에_본인의_키를_로컬에서만_입력
SHOWME_GEMINI_FREE_TIER_CONFIRMED=true
SHOWME_GEMINI_SYNTHETIC_CONSENT=synthetic-screens-only-v1
```

위 두 확인값은 사용자의 확인·동의 표시다. 앱이 API 키로 Google의 과금 등급을 알아내는 기능은 아니다. **유료 프로젝트의 키를 넣으면 과금될 수 있으며, 이 코드는 요금 0원을 강제하지 못한다.** 로컬 요청 한도는 Google의 계정 한도나 통화 기준 예산이 아니다.

Free tier에서는 입력·출력이 서비스 개선에 이용될 수 있으므로 실제 개인정보·기밀·민감한 화면을 보내지 않는다. 이 명령은 코드로 만든 가상 화면만 보내며, 사용자 영상 경로를 받는 옵션은 없다. 실제 고객 화면 사용은 적합한 데이터 처리 조건과 제품 내 동의 절차를 정한 뒤 별도 단계에서 진행한다. [Google 이용약관](https://ai.google.dev/gemini-api/terms).

## 3. 동의 후 실제 연결 시험

키와 위 확인값을 입력한 뒤, 가상 화면을 Google에 전송해도 되는 경우에만 실행한다.

```powershell
npm run processor:gemini:smoke -- --live
```

- 기본 실행은 항상 오프라인이다. `--live`와 세 환경변수가 모두 필요하다. 프로그램은 `GEMINI_API_KEY`만 읽으며 `GOOGLE_API_KEY`로 자동 대체하지 않는다. 기존 프로세스 환경변수는 Node의 env 파일보다 우선한다.
- 실제 요청은 **한 번**, 가상 화면 2장을 보낸다. 이 시험 명령에서는 자동 재시도를 하지 않는다.
- 성공하면 출력된 `live-*` 폴더의 `result.json`에서 검증된 한국어 단계 설명·클릭 후보·개인정보 후보와 토큰 사용량을 확인한다. 원문 응답·API 키·추론 내용은 저장하지 않는다.
- 모델 응답의 형식 검증과 실제 품질은 다르다. 사람이 한국어 설명과 버튼 위치를 확인해야 하며, 가상 화면 2장은 전체 품질 평가를 대신하지 않는다.
- `store:false`는 상호작용 조회용 저장을 끄는 설정이지 무보관·학습 제외 보장이 아니다. [Interactions API](https://ai.google.dev/api/interactions-api).

## 구현한 안전장치

- 내부 어댑터는 고정된 Google HTTPS 주소로만 호출하고 리디렉션을 금지한다. 키는 HTTP 헤더에만 넣는다. 브라우저/공개 API/업로드/서버 시작에 자동 연결하지 않았다.
- 분석 대상 최대 4장과 앞뒤 문맥 최대 2장, JPEG 1장당 2 MiB, 가로·세로 최대 4096픽셀. 원본 영상·오디오·편집 키·파일명·저장소 URL은 보내지 않는다.
- 한국어 설명·percent 좌표·개인정보 후보를 JSON schema로 요청한 뒤 서버 계약으로 재검증한다. 다른 단계 ID, 누락, 중복, 범위를 벗어난 좌표, 추가 개인정보 값 필드, 자동 병합은 거부한다. 화면 안의 명령은 따르지 않도록 지시하고 외부 도구는 제공하지 않는다.
- 요청당 기본 60초(초과 설정 불가), 응답 본문 512 KiB, 출력 설정 8192토큰, thinking low. 사용량은 출력과 생각 토큰을 합산한다. 타임아웃은 로컬 대기 종료이며 외부 계산/과금 즉시 중단을 보장하지 않는다.
- 일반 내부 어댑터는 일부 5xx에 최대 1회만 재시도할 수 있다. 키 오류·429·잘못된 응답은 재시도하지 않는다. 각 시도 전에 요청 슬롯을 예약하며 실패한 시도도 반환하지 않는다.
- 이 **로컬 시험 명령**은 저장 폴더당 UTC 하루 10회로 제한한다(한국 시간 오전 9시 날짜 변경). 동시에 실행해도 동일 폴더의 원자적 파일 예약으로 한도를 공유한다. 재실행으로 초기화되지 않으며 예약 파일을 삭제하면 이 보호가 사라진다. 다른 PC/배포 복제본/동일 키를 쓰는 다른 앱의 사용량은 합산하지 않는다.
- 오류 메시지는 제한된 코드만 출력한다. AI 설명의 개인정보 누락·오판까지 보장하는 기능은 아니며, 자동 가림·공개는 하지 않는다.

## 오류가 나면

| 코드 | 의미와 다음 행동 |
|---|---|
| `GEMINI_KEY_MISSING` | 로컬 키 누락/형식 문제. `.env`를 확인하되 키를 채팅에 보내지 않는다. |
| `GEMINI_DISABLED` | 실행 인자 또는 확인·동의 값이 맞지 않는다. 위 절차를 확인한다. |
| `GEMINI_AUTH_FAILED` | Google 인증/권한 거절. 키가 속한 프로젝트·API 권한·새 auth key 여부를 확인한다. |
| `GEMINI_QUOTA_LIMIT` | Google 한도 초과. 자동 반복·과금 활성화 대신 AI Studio 한도를 확인한다. |
| `GEMINI_LOCAL_LIMIT` | 로컬 하루 한도 도달 또는 예약 저장 실패. 반복 실행하거나 예약 파일을 삭제하지 않는다. |
| `GEMINI_TIMEOUT` | 로컬 대기 시간 초과. 이미 요청은 전송됐을 수 있으므로 사용량 확인 후 재시험한다. |
| `GEMINI_RESPONSE_INVALID` / `AI_INVALID_OUTPUT` | 응답이 완성되지 않았거나 계약에 맞지 않는다. 초안으로 적용하지 않는다. |
| `GEMINI_HTTP_FAILED` / `GEMINI_SMOKE_FAILED` | 통신/로컬 시험 오류. 원문에 키가 있을 수 있으므로 원문 대신 오류 코드로 문의한다. |

## 아직 하지 않은 것과 다음 순서

현재 키가 없어 실제 Google 호출·응답 품질·무료 등급은 검증하지 않았다. 모의 HTTP 응답을 통한 어댑터→내부 실행기→로컬 초안 저장 검증만 완료했다. 실제 PostgreSQL 통합 검증도 남아 있다.

1. 키를 로컬에 설정하고 가상 화면 1회 실제 호출 및 한국어/좌표 품질 확인.
2. Gate 3B-2: 인증된 분석 API·제품 내 외부 전송 동의, 별도 작업 큐, 운영 DB 기반 요청/비용 예약, 실패 묶음 보존·취소·복구. 실제 민감정보 사용 조건은 별도 결정.
3. Gate 3C: 진행/실패/검토 필요 화면, 다양한 가상 자료 품질 평가.
4. 이후 편집·개인정보 비가역 가림·공개 링크·운영 배포. 기존 공개 사이트는 계속 이전 프로토타입으로 유지.

모델의 이미지 입력·구조화 출력·thinking 지원은 [Gemini 3.8 Flash 공식 문서](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), 응답 JSON 형식은 [구조화 출력 문서](https://ai.google.dev/gemini-api/docs/structured-output)를 기준으로 구현했다.

## 이번 단계의 검증 기록

- `npm run check` 성공: processor 145개와 client 4개, 총 149개 테스트 및 processor 타입 검사·빌드, lint, frontend production build 통과.
- 후속 auth key 형식 보완 후 Gemini 테스트 23개, processor 타입 검사·빌드, 전체 TypeScript 검사(`npx tsc --noEmit --incremental false`), lint 재확인 통과.
- `npm run processor:gemini:smoke` 성공: 로컬 JPEG 2장 생성, `networkCalls: 0`, `prepared-not-analyzed` 확인. 첫 가상 화면 이미지도 직접 확인했다.
- 키 없는 환경이며 실 API 호출·무료 등급·실 AI 품질·브라우저 녹화·운영 DB·공개 배포는 검증/실행하지 않았다. Sites 스킬에 따라 기존 Sites 프로젝트와 실행 구조를 유지했으며 공개 사이트는 수정하지 않았다.
- 빌드에 기존 Vite 설정 로더/라우트 분류 관련 안내가 남아 있지만 빌드 실패는 아니다. 이 단계에서 관계없는 프레임워크 설정은 변경하지 않았다.
