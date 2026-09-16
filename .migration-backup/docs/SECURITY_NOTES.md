# 보안 검증 기록

마지막 코드 리뷰: 2026-09-12

## 적용한 경계

- 편집 키는 Authorization header로만 받고 URL query에는 허용하지 않는다.
- frame URL에는 guide 범위와 만료 시간이 있는 read-only HMAC ticket만 넣는다.
- 브라우저가 upload identity와 edit token을 전송 전에 보관해 응답 유실 시 같은 작업을 복구한다.
- 가이드별 복구 키와 탭별 현재 작업을 분리한다. 브라우저 직접 녹화에서는 오디오를 요청하지 않는다.
- 취소 tombstone은 24시간 유지한다. 미공개 ready/failed 초안은 마지막 상태 갱신으로부터 7일 후 정리 대상이며, 저장소 장애 시 삭제 기록을 유지하고 재시도한다.
- 삭제 완료는 자산 삭제가 확인된 뒤에만 기록한다. 시간 초과된 저장의 늦은 완료·삭제 실패도 durable ACTIVE 기록으로 추적한다.
- 과거 worker/업로더는 다른 attempt/lease가 소유한 삭제를 완료할 수 없다. 자동 정리는 조회한 `updatedAt`을 상태 변경과 최종 DB 삭제 시점에 다시 비교해 새 생존 신호를 덮어쓰지 않는다.
- 저장소 삭제는 동일 key별 진행 중 요청을 합치고 전체 대기를 제한한다. 정리 주기는 작은 배치·시간 예산을 사용하며 반복 실패한 행을 뒤로 보내 다른 가이드의 삭제가 진행되도록 한다. 전체 정리는 준비 완료 이후 백그라운드로 실행한다.
- 미디어 입력은 file 프로토콜과 컨테이너별 demuxer allowlist로 제한한다. HLS를 MP4로 위장해도 loopback HTTP 요청이 발생하지 않는 회귀 테스트가 있다.
- 원본 이름은 경로로 사용하지 않고, 모든 로컬/object 경로는 서버가 만든 ID 아래로 제한한다.
- multipart 크기·개수·시간 제한과 queue/resource/attempt 상한을 적용한다.
- production과 Replit 미리보기는 시스템 FFmpeg/ffprobe를 시작 시 검증하며 npm의 오래된 bundled binary로 자동 fallback하지 않는다.
- FFmpeg는 검토한 보안 release branch만 허용한다. 배포에서는 두 바이너리 모두 `EXPECTED_MEDIA_VERSION`과 정확히 일치해야 하며, Replit Nix channel은 `stable-26_05`로 고정한다.
- 배포 migration은 HTTP 실행 명령 앞에서 별도 CLI로 돌리지 않는다. listener가 즉시 503 readiness를 제공한 뒤 제한 시간 안에서 적용하고, 완료된 프로세스만 200으로 전환한다.
- 2026-09-11 현재 Next/Vinext/Vite/Cloudflare/React Server DOM의 high·critical advisory가 해소된 조합으로 잠갔다.

## 알려진 잔여 항목

로컬 자동 테스트는 JSON/LocalStorage 어댑터와 실패 주입을 중심으로 실행한다. 실제 PostgreSQL의 트랜잭션 경합, Replit App Storage 장애·재시작·배포 교체 동작은 아직 운영 환경에서 검증하지 않았다. 직접 녹화의 화면 선택/권한 취소는 실제 지원 브라우저에서 확인해야 한다. 현재 UI에서는 실제 영상의 AI 분석·가림·공개가 완료된 것으로 표시하지 않는다.

`npm audit --omit=dev --audit-level=high`은 high/critical 없이 통과한다. 다만 공식 `@replit/object-storage@1.0.0`이 사용하는 Google Cloud Storage 의존성 아래 `uuid@9.0.1` advisory 때문에 moderate 6건이 남는다. 현재 SDK 체인에는 audit가 제시하는 호환 업데이트가 없고, ShowMe 코드는 취약 대상으로 명시된 uuid v3/v5/v6 buffer API를 직접 호출하지 않는다. Replit SDK 또는 그 Google Storage 의존성이 갱신되면 우선 반영한다.

전체 개발 의존성 감사에는 `drizzle-kit` 내부의 오래된 esbuild loader 때문에 moderate 항목이 추가로 남는다. 이 경로는 배포 HTTP 서비스가 아니라 migration 생성 도구이며, audit가 제안하는 수정은 오히려 drizzle-kit의 breaking downgrade이므로 적용하지 않았다. migration 생성은 신뢰한 저장소 schema만 대상으로 실행한다.
