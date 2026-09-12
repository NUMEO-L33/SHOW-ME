# ShowMe 구현 게이트

각 단계는 아래 완료 조건과 자동 검증을 통과한 뒤에만 다음 단계로 넘어갑니다. UI 데모가 보인다는 이유만으로 뒤 단계를 완료 처리하지 않습니다.

이 문서의 완료 표시는 **코드와 로컬 검증**에 한정합니다. PostgreSQL/Replit App Storage 실서비스 검증, 실제 브라우저 화면 공유 권한, 운영 배포는 Gate 7에서 별도로 확인합니다. 현재 공개 사이트는 이전 프로토타입입니다. 2026-09-12 독립 리뷰 결과는 [리뷰 기록](REVIEW_2026-09-12.md)을 참고하세요.

다음 구현의 순서·데이터 계약·실패 처리·완료 기준은 [순차 구현 설계](NEXT_PHASE_DESIGN.md)에 정리했습니다. Gate 2의 실제 녹화/업로드 보완 확인을 먼저 다루고, Gate 3–7을 각각 구현·검증·리뷰 단위로 진행합니다. 설계 문서의 제안은 구현 완료를 뜻하지 않습니다.

## Gate 0 — 실행 구조와 데이터 경계 ✅

- Sites UI와 장시간 미디어 프로세서를 분리한다.
- Replit 배포에서는 PostgreSQL과 App Storage가 없으면 시작하지 않는다.
- 원본 영상 object key와 편집 키를 공개 응답에 노출하지 않는다.
- DB migration과 Replit build/run 명령을 저장소에 고정한다.

검증: 중앙 설정 테스트, 시작 readiness, DB·Storage startup probe, 운영 FFmpeg 버전 검사.

## Gate 1 — 안전한 영상 수신과 작업 복구 ✅

- MP4/MOV/WebM을 스트리밍으로 받고 500 MiB에서 차단한다.
- 지원 브라우저에서는 창·탭·전체 화면을 직접 녹화해 같은 WebM/MP4 업로드 흐름으로 넘긴다. 직접 녹화는 브라우저 메모리 안전을 위해 4분/64 MiB로 제한하고, 긴 영상은 파일 업로드를 사용한다.
- 브라우저가 업로드 전에 guide ID와 edit token을 보관한다.
- 복구 키는 가이드별로 분리하고 현재 탭의 작업을 우선 복구한다. 직접 녹화에서는 오디오를 수집하지 않는다.
- 같은 업로드를 다시 보내도 새 가이드나 고아 원본을 만들지 않는다.
- bounded queue, 재시도 coalescing, 최대 처리 시도 횟수를 적용한다.
- 프로세스 재시작과 겹친 worker에서 stale attempt가 승자의 상태나 자산을 변경하지 못한다.
- 취소가 업로드보다 먼저 도착하면 24시간 tombstone을 남긴다. 원본과 프레임은 수동 전체 삭제를 지원하고, 미공개 ready/failed 초안은 마지막 상태 갱신으로부터 7일 뒤 자동 정리 대상이 된다.
- 저장이 시간 초과 후 늦게 끝나도 삭제 기록을 유지한다. 삭제 실패 기록은 다음 정리 주기로 넘기고, 갱신된 생존 신호와 다른 처리 작업의 삭제 권한을 존중한다.

검증: API, multipart cleanup, retry race, queue capacity, CAS/ABA, recovery 테스트.

## Gate 2 — 실제 FFmpeg 장면·프레임 처리 ✅

- ffprobe로 길이, 코덱, FPS, 회전 메타데이터를 검증한다.
- scene detection과 interval fallback으로 최대 24개 단계를 만든다.
- iPhone 회전 메타데이터를 정확히 한 번 적용한다.
- 세로·가로 비율의 대표 프레임과 thumbnail을 영속 저장한다.
- 길이·해상도·픽셀·FPS·코덱 제한으로 비정상 입력을 조기에 중단한다.
- 업로드 영상 입력마다 file 프로토콜 및 MP4/MOV/WebM 컨테이너 allowlist를 적용한다. 위장된 재생목록이 외부 URL을 여는 것을 차단한다.
- 각 처리 시도의 최대 100개 단계 키를 정리해 설정 변경 후에도 과거 자산을 추적한다. 다운로드·삭제 대기는 제한 시간 안에 끝내고, 늦게 완료된 로컬 복사도 제거한다.
- 현재 단계의 설명과 중앙 포인터는 임시 표시다. UI에서 AI 설명·개인정보 탐지·가림·편집 저장이 아직 적용되지 않았음을 명시하고 실제 영상의 공개를 차단한다.

검증: 실제 FFmpeg fixture, 회전 영상, 손상 영상, resource limit, superseded attempt 테스트 및 수동 API E2E.

## Gate 3 — AI 초안 생성 ⏭️

- provider interface 뒤에서 OpenAI Vision structured output을 호출한다.
- 각 단계의 한국어 설명, 클릭 위치, 개인정보 후보를 percent 좌표로 반환한다.
- schema validation, timeout, retry, 비용·프레임 상한을 적용한다.
- AI 실패가 미디어 처리 결과나 원본을 손상시키지 않는다.

진행 상황: **3A 계약·저장 기반 구현 및 로컬 검증 완료**. 입력/출력 검증, 별도 초안 revision, 분석 실행 소유권, JSON/PostgreSQL 저장 구현과 추가 migration, 테스트 전용 공급자를 통한 실행기가 있다. 실제 OpenAI 어댑터·유료 호출·분석 API·사용자 동의 화면·예산 집행·자동 dispatcher는 아직 연결하지 않았다. PostgreSQL 실환경 경합 검증도 남아 있으므로 Gate 3 전체 완료는 아니다. 자세한 범위는 [Gate 3A 체크포인트](GATE_3A_CHECKPOINT.md)를 참고한다.

## Gate 4 — 서버 저장 편집기

- 제목·단계·문구·클릭 위치·가림 영역 변경을 edit token 권한으로 저장한다.
- 직접 조작 StepCanvas와 키보드 접근성을 제공한다.
- 새로고침·다른 화면 크기에서도 percent 좌표가 유지된다.

## Gate 5 — 개인정보 비가역 처리와 게시

- 게시 전 모든 가림 후보를 확인하게 한다.
- Sharp/FFmpeg로 파생 이미지에 blur를 구워 원본 픽셀 복구를 막는다.
- 게시 snapshot과 편집 draft를 분리한다.
- 원본 공유는 기본 꺼짐이며 별도 권한 경로로만 제공한다.

## Gate 6 — 공개 링크와 모바일 뷰어

- 공개 slug API와 `/g/:slug`가 동일한 게시 snapshot을 표시한다.
- 공개 응답에는 edit token, 원본 object key, 미가림 frame이 없다.
- 카카오톡 공유용 metadata와 모바일/데스크톱 뷰어를 검증한다.

## Gate 7 — 실제 배포와 회귀 검증

- Replit Reserved VM에 processor를 배포하고 production Secrets를 등록한다.
- Sites 빌드에 HTTPS processor URL을 주입한 뒤 한 번만 다시 게시한다.
- MP4/MOV/WebM, 세로/가로/회전, 재시작 복구, 500 MiB 경계를 순서대로 확인한다.
- 실제 processor가 준비되기 전에는 현재 공개 Sites를 새 frontend로 덮어쓰지 않는다.
