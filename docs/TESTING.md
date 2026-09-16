# 이관본 테스트 실행

기준: Replit `artifacts/` 구조. 백업 코드를 실행해 통과한 결과로 대체하지 않는다.

## 기본 검사

저장소 루트, Node 24, Linux/Replit, 설치된 잠금 파일 의존성을 사용한다.

```sh
node scripts/run-tests.mjs
PORT=20116 BASE_PATH=/ pnpm run build
```

- 기본 검사는 안전장치 → 서버 → 클라이언트 순서이며 첫 실패 시 실패 종료한다.
- 그룹별로 `node scripts/run-tests.mjs migration`, `server`, `client`를 실행할 수 있다.
- `pnpm test`, 각 패키지의 `test`도 같은 실행기로 연결된다. 번들 패키지 관리자가 자동 설치를 시도하는 PC에서는 직접 Node 명령을 사용한다.
- 두 패키지의 `typecheck`에는 복원된 테스트 코드 검사도 포함된다. API 빌드는 테스트를 배포 묶음에 넣지 않는다.
- `.env`를 읽지 않고, 앱/DB/Google/Replit 설정과 `NODE_OPTIONS`는 테스트 자식 프로세스에 전달하지 않는다. 테스트는 임시 파일·모의 공급자·로컬 HTTP를 사용한다.
- 환경변수 제외 자체가 네트워크 방화벽은 아니다. 엄격한 재검증에서는 의존성 준비 후 테스트 컨테이너의 외부 연결을 차단한다.

## 합성 영상과 고정 이미지

영상 테스트는 실제 FFmpeg/FFprobe를 실행한다. Linux/Replit에서는 호스트 명령을, Windows에서는 기존 번들 바이너리를 사용한다. 도구 누락은 실패이며 테스트를 건너뛰지 않는다. 필요하면 `SHOWME_TEST_FFMPEG_PATH`와 `SHOWME_TEST_FFPROBE_PATH`를 **둘 다** 명시한다. 이 변수는 테스트용이며 운영 미디어 설정과 별개다.

회전 영상 테스트는 `display_rotation` 옵션을 사용하므로 오래된 시스템 도구로는 실패할 수 있다. Replit의 운영 미디어 기준 `8.1.2`와 보안 검사는 그대로 유지한다. 테스트용 도구의 통과를 운영 버전 검증으로 취급하지 않는다. pnpm의 설치 스크립트 허용 목록을 전체 해제하지 않는다.

Gemini 시험 화면 두 장은 보존된 코드의 픽셀/글꼴 알고리즘으로 생성한 개인정보 없는 합성 데이터다. 이전 Windows 환경에서 전체 요청 지문이 역사적 계수 기록과 일치함을 먼저 확인하고 `synthetic-fixture.json`에 고정했다. 다른 OS/인코더로 재압축하지 않으며, 매 호출마다 이미지 해시를 확인하고 독립된 버퍼를 돌려준다.

전체 요청 지문:

```text
520a4dcd1bd453584265c015d85a9fa9211e07ab9ad09a929be70fe4467545fc
```

이 일치 여부는 새 전송 승인이나 범용 토큰 상한이 아니다. 기존 `generationProbeMode`의 명시적 승인 조건과 `matchesCountReference`는 변경하지 않았다. 기본 테스트의 공급자 응답은 모두 모의 응답이다.

## 별도 검증

PostgreSQL 통합 검사는 `artifacts/api-server/scripts/verify-postgres.mjs`로 분리했다. 기본 검사에는 포함되지 않는다. 명시적인 로컬 Docker 호스트, 기존 이미지, 임의 이름·암호·tmpfs·루프백 주소인 일회용 DB만 허용하며 실제 `DATABASE_URL`을 사용하지 않는다. 실행 후 해당 시험의 소유권을 확인해 컨테이너만 정리한다.

Replit 실제 DB/Storage 연동, 브라우저 녹화·업로드 흐름, AI 준비 검증기, 편집·가림·게시 및 운영 배포는 별도의 완료 조건이다. 빌드 성공은 이 항목들의 완료를 뜻하지 않는다.
