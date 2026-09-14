# Gemini 시작하기 — Gate 3B-1

작성일: 2026-09-12 · 업데이트: 2026-09-14 · 범위: 로컬 Gemini 어댑터와 가상 화면 시험

사용자 선택에 따라 첫 AI 공급자를 Gemini로 정했다. 기본 모델 ID는 `gemini-3.8-flash` 그대로이며, 사용자가 승인한 대체 시험 모델 `gemini-3.5-flash-lite`를 명시적으로 선택할 수 있다. **2026-09-14에는 3.5 Flash-Lite로 실제 분석·검증·결과 파일 저장까지 성공했다.** 프롬프트 버전은 `showme-gemini-ko-v1`, 전송 경로는 `generateContent` REST API다. 모델은 자동으로 교체하지 않으며, 이 단계는 공개 서비스에 AI 기능을 켠 것이 아니다.

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

위 명령은 기본 3.8 Flash를 사용한다. 연결 시험에 성공한 **3.5 Flash-Lite**는 다음처럼 명시한다. `.env`나 기본 모델을 바꾸지 않는다.

```powershell
npm run processor:gemini:smoke -- --model gemini-3.5-flash-lite
npm run processor:gemini:smoke -- --live --model gemini-3.5-flash-lite
```

첫 줄은 여전히 외부 통신 없는 준비 확인이고, 두 번째 줄만 실제 요청이다. 허용 모델은 `gemini-3.8-flash`와 `gemini-3.5-flash-lite` 두 개다. `latest` 별칭·임의 URL·중복 옵션·영상 경로를 거부하며, `GEMINI_MODEL` 환경변수로 조용히 변경되지 않는다. 모델을 바꿔도 같은 로컬 일일 한도를 공유한다.

- 기본 실행은 항상 오프라인이다. `--live`와 세 환경변수가 모두 필요하다. 프로그램은 `GEMINI_API_KEY`만 읽으며 `GOOGLE_API_KEY`로 자동 대체하지 않는다. 기존 프로세스 환경변수는 Node의 env 파일보다 우선한다.
- 실제 요청은 **한 번**, 가상 화면 2장을 보낸다. 이 시험 명령에서는 자동 재시도를 하지 않는다.
- 성공하면 출력된 `live-*` 폴더의 `result.json`에서 검증된 한국어 단계 설명·클릭 후보·개인정보 후보와 토큰 사용량을 확인한다. 원문 응답·API 키·추론 내용은 저장하지 않는다.
- 모델 응답의 형식 검증과 실제 품질은 다르다. 사람이 한국어 설명과 버튼 위치를 확인해야 하며, 가상 화면 2장은 전체 품질 평가를 대신하지 않는다.
- 단일 요청의 `contents[].parts`에 텍스트와 인라인 JPEG를 넣고 JSON 결과를 요청한다. `generateContent`에는 이전 Interactions용 `store` 옵션을 보내지 않는다. 이 방식도 무보관·학습 제외를 보장하지 않는다. [GenerateContent API](https://ai.google.dev/api/generate-content).

## 구현한 안전장치

- 내부 어댑터는 고정된 Google HTTPS 주소로만 호출하고 리디렉션을 금지한다. 키는 HTTP 헤더에만 넣는다. 브라우저/공개 API/업로드/서버 시작에 자동 연결하지 않았다.
- 분석 대상 최대 4장과 앞뒤 문맥 최대 2장, JPEG 1장당 2 MiB, 가로·세로 최대 4096픽셀. 원본 영상·오디오·편집 키·파일명·저장소 URL은 보내지 않는다.
- 한국어 설명·percent 좌표·개인정보 후보를 단순한 공급자용 JSON schema로 요청한 뒤 **기존의 엄격한 서버 계약**으로 재검증한다. 공급자용 schema의 길이·범위 제한을 줄였지만 서버에서는 다른 단계 ID, 누락, 중복, 긴 문구, 범위를 벗어난 좌표, 추가 개인정보 값 필드, 자동 병합을 계속 거부한다. 화면 안의 명령은 따르지 않도록 지시하고 외부 도구는 제공하지 않는다.
- 요청당 기본 60초(초과 설정 불가), 응답 본문 512 KiB, 출력 설정 8192토큰. 실호출에 성공한 기본 thinking 설정을 사용하며 별도 `thinkingConfig`를 보내지 않는다. 사용량은 `candidatesTokenCount`와 `thoughtsTokenCount`를 합산한다. 생각 내용·서명은 결과로 추출하거나 저장하지 않는다. 타임아웃은 로컬 대기 종료이며 외부 계산/과금 즉시 중단을 보장하지 않는다.
- 정상 완료된 단일 후보와 **명시적으로 선택한 모델 ID**, 토큰 사용량을 확인한다. 다른 허용 모델의 응답도 선택한 모델과 다르면 거부한다. `MAX_TOKENS`는 미완료, 안전성 차단은 거절로 처리하며 초안으로 적용하지 않는다. 도구 호출·알 수 없는 출력 형식도 거부한다.
- 일반 내부 어댑터는 일부 5xx에 최대 1회만 재시도할 수 있다. 키 오류·429·잘못된 응답은 재시도하지 않는다. 각 시도 전에 요청 슬롯을 예약하며 실패한 시도도 반환하지 않는다.
- 이 **로컬 시험 명령**은 저장 폴더당 UTC 하루 10회로 제한한다(한국 시간 오전 9시 날짜 변경). 동시에 실행해도 동일 폴더의 원자적 파일 예약으로 한도를 공유한다. 재실행으로 초기화되지 않으며 예약 파일을 삭제하면 이 보호가 사라진다. 다른 PC/배포 복제본/동일 키를 쓰는 다른 앱의 사용량은 합산하지 않는다.
- 오류 메시지는 제한된 코드와 HTTP 실패 시 숫자 상태(400–599)만 출력한다. 공급자 원문 오류·키는 출력하지 않는다. AI 설명의 개인정보 누락·오판까지 보장하는 기능은 아니며, 자동 가림·공개는 하지 않는다.

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
| `GEMINI_HTTP_FAILED` / `GEMINI_SMOKE_FAILED` | 통신/로컬 시험 오류. 표시된 안전한 코드와 `httpStatus`만 공유한다. 503은 서버 오류 응답이며, 이 시험 명령은 자동 재시도하지 않는다. HTTP 상태 없이 즉시 실패하면 실행 환경의 외부 통신 권한도 확인한다. |

## 아직 하지 않은 것과 다음 순서

**대체 모델의 로컬 실제 연결 검증은 완료했다.** 3.8 Flash의 최종 시험은 HTTP 503으로 실패했지만, 이후 사용자가 승인한 3.5 Flash-Lite 시험 명령에서 가상 화면 2장의 분석·서버 검증·`result.json` 저장까지 성공했다. 두 모델 모두 모의 HTTP 응답을 통한 어댑터→내부 실행기→로컬 초안 저장 검증도 통과했다. 가상 화면 시험 성공은 운영 안정성·개인정보 탐지 품질을 보증하지 않는다. Google 무료 등급의 실제 계정 조회, 실제 PostgreSQL 통합, 다양한 화면 품질은 여전히 미검증이다.

1. 연결 검증 완료: 3.5 Flash-Lite 시험에서 `analyzed-synthetic-only`와 결과 저장을 확인했다. 2026-09-14 사용량은 3.8 실패 2회 + 3.5 성공 1회, **로컬 예약 3/10회**다. 기본 3.8 모델은 유지했으며, 다음 분석 API 단계에서는 성공한 3.5 모델을 명시적으로 채택할지 결정한다. 자동 재시험·모델 전환·과금 활성화는 하지 않았다.
2. Gate 3B-2: 인증된 분석 API·제품 내 외부 전송 동의, 별도 작업 큐, 운영 DB 기반 요청/비용 예약, 실패 묶음 보존·취소·복구. 실제 민감정보 사용 조건은 별도 결정.
3. Gate 3C: 진행/실패/검토 필요 화면, 다양한 가상 자료 품질 평가.
4. 이후 편집·개인정보 비가역 가림·공개 링크·운영 배포. 기존 공개 사이트는 계속 이전 프로토타입으로 유지.

모델의 이미지 입력·구조화 출력·thinking 지원은 [Gemini 3.8 Flash 공식 문서](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash), 응답 JSON 형식은 [구조화 출력 문서](https://ai.google.dev/gemini-api/docs/structured-output)를 기준으로 구현했다.

## 이번 단계의 검증 기록

### 초기 체크포인트 (`a18bf86`)

- 키가 없던 당시 `npm run check`로 processor 145개 + client 4개, 총 149개와 타입 검사·빌드·lint를 통과했다.
- 오프라인 시험에서 로컬 JPEG 2장, `networkCalls: 0`, `prepared-not-analyzed`를 확인했다.

### 2026-09-12 연결 수정

- 원래 Interactions 요청의 `{role, content}` 입력이 문서 형식과 달랐다. 문서에 맞는 다른 입력 형태도 시험했으나 HTTP 400/60초 timeout이 이어졌다. 남은 Interactions 실패의 정확한 원인까지 확정한 것은 아니다.
- 같은 키·같은 `gemini-3.8-flash` 모델로 `generateContent`의 짧은 텍스트 응답을 확인했다. 이어 **단순화한 JSON schema + 기본 thinking**의 가상 화면 분석 요청이 HTTP 200/STOP으로 성공했다. 두 설정을 함께 바꿨으므로 어느 하나만이 앞선 실패 원인이라고 단정하지 않는다.
- 진단 성공 결과: `다음 누르기` / `완료 누르기`, 파란색 다음 버튼 / 초록색 완료 버튼을 누르라는 한국어 설명. 두 클릭 후보 모두 `(50%, 68.8%)`로 반환돼 합성 화면의 버튼 영역 안에 있다. 입력 2,627토큰, 응답 238토큰, 생각 476토큰(출력 합계 714). 서버 계약 검증 통과. 이는 가상 화면 2장에 한정된 확인이며 개인정보 탐지 성능·전체 품질을 입증하지 않는다.
- 이 요청 형식을 어댑터와 응답 파서에 반영했다. 자동 API 전환·추가 네트워크 재시도는 넣지 않았다. 최종 CLI 검증은 제한 환경에서 통신 권한 오류, 허용 환경에서 **HTTP 503**으로 실패했다. 성공한 진단 결과와 CLI 전체 성공을 구분한다.
- `npm run check` 성공: processor 147개 + client 4개, **총 151개 테스트**, processor 타입 검사·빌드, 전체 lint, frontend production build 통과. Gemini 관련 모의·통합 테스트 25개를 포함한다.
- API 키와 `.env`, 가상 시험 자산은 Git에서 제외한다. 실제 사용자 영상·화면은 전송하지 않았다. Sites 스킬에 따라 기존 프로젝트와 실행 구조를 유지했고 공개 사이트는 수정하지 않았다.
- Sites 빌드 보조 스크립트는 Windows의 npm 경로 조회에서 실패하여 기존 `npm run build`를 사용했다. 기존 Vite 설정 로더/라우트 분류 안내는 별도이며 관계없는 프레임워크 설정은 변경하지 않았다.

### 2026-09-14 실제 연결 재검증 (`220a360` 기준)

- 키 존재, 무료 등급 사용자 확인값, 가상 화면 전송 동의값을 값 노출 없이 확인했다. Google 과금 등급을 실제 조회한 것은 아니다.
- `npm run processor:gemini:smoke -- --live`로 개인정보 없는 가상 JPEG 2장을 전송했다. 첫 실행과 진단 후 한 번의 추가 실행 모두 `GEMINI_HTTP_FAILED`, HTTP **503**으로 종료됐다. 자동 재시도는 여전히 0회이며 추가 반복은 중단했다. 성공 결과 파일은 생성되지 않았다.
- 동일한 키로 `models/gemini-3.8-flash` 정보 조회는 HTTP **200**이었다. 모델 ID 일치와 `generateContent` 지원을 확인했다. 이 읽기 전용 조회는 분석 생성 요청이 아니며, 생성 요청의 정상 처리나 과금 등급을 보증하지 않는다.
- Google은 503을 일시적 과부하/사용 불가 오류로 안내하고 제한된 재시도를 권장한다. 이번 계정·요청에서의 구체적인 원인이나 복구 시각은 확인되지 않았다. 상태 페이지의 실시간 장애 내용도 확인하지 못했으므로 전면 장애로 단정하지 않는다. [오류 안내](https://ai.google.dev/gemini-api/docs/api-errors), [재시도 안내](https://ai.google.dev/gemini-api/docs/troubleshooting).
- `npx tsx --test processor/tests/gemini.test.ts`: **25개 통과**. 이번에는 소스 코드 변경이 없어 전체 151개 테스트·전체 빌드는 재실행하지 않았다. 이전 전체 검증과 이번 재검증을 구분한다.
- 일일 예약 파일은 2026-09-12 10개를 그대로 보존했고, 2026-09-14에는 2개를 사용했다. 실패분을 돌려놓거나 상한을 변경하지 않았다.
- 새 기능·모델·키·과금 설정은 변경하지 않았다. 분석 API/화면 연결 단계로 넘어가지 않았으며 GitHub 푸시·공개 배포도 하지 않았다. 다음 조치는 같은 모델의 복구 후 재검증 또는 사용자 승인 후 다른 Gemini 모델의 별도 시험이다.

### 2026-09-14 대체 모델 시험 성공

- 사용자 승인 후 `gemini-3.5-flash-lite`를 시험 대상으로 추가했다. 공식 문서에서 안정 버전, 이미지 입력·구조화 출력·무료 등급 지원을 확인했고, 같은 키의 모델 목록에서도 확인했다. 이는 해당 계정의 실제 과금 등급을 확인한 것은 아니다. [모델 문서](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite), [요금 문서](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite).
- 변경 범위는 명시적 모델 선택, 선택한 모델과 응답 ID 대조, 시험 CLI의 `--model` 옵션, 회귀 테스트다. 기존 기본 모델·키·프롬프트·schema·60초/8192토큰 제한·재시도·한도 정책은 유지했다. 공개 API나 브라우저에서 모델을 선택하는 기능은 추가하지 않았다.
- 오프라인 준비 실행: `prepared-not-analyzed`, `model: gemini-3.5-flash-lite`, `networkCalls: 0` 확인.
- `npm run processor:gemini:smoke -- --live --model gemini-3.5-flash-lite`: **1회 성공**, `analyzed-synthetic-only` 출력과 검증된 `result.json` 저장 확인. 결과는 Git 제외 경로 `processor/.data/gemini-smoke/live-ROpmcY/result.json`에 있다.
- 실제 출력: 단계명 `다음` / `완료`, 설명 `다음 버튼을 누르세요.` / `완료 버튼을 누르세요.`. 두 클릭 후보 `(50%, 67.8%)`는 640×360 화면에서 `(320, 244.08)`이며, 버튼 영역 x=205–435, y=214–282 안에 있다. 두 JPEG와 결과를 직접 확인했다. 개인정보 후보는 빈 배열이며 이 자료로 개인정보 탐지 성능을 평가하지 않는다.
- 입력 2,627토큰, 출력(생각 포함) 219토큰. API 키·원문 공급자 응답·생각 내용은 저장하지 않았다. 성공 1회로 장기 가용성이나 3.8의 실패 원인까지 단정하지 않는다.
- `npm run check` 통과: processor **154개** + client **4개**, 총 **158개 테스트**, 타입 검사·processor 빌드·lint·frontend production build 성공. 관련 테스트 32개에는 기본 모델 유지, 허용 목록, 응답 모델 불일치 차단, 자동 전환 없음, 두 모델의 한도 공유, 성공/실패 시 초안 보존을 포함한다. 기존 Vite 설정 로더/라우트 분류 안내는 남아 있지만 빌드는 성공했다.
- 이번 작업은 독립 processor의 로컬 시험 경로에 한정했다. 프런트엔드·공개 Site·과금 설정·`.env`는 변경하지 않았고 GitHub 푸시·공개 배포도 하지 않았다.
