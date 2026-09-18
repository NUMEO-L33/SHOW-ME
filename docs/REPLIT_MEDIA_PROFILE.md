# Replit 첫 JPEG 실행 지연: 미디어 의존성 축소

## 관측과 범위

2026-09-18. `87d2607`의 최초 일반 회귀에서 첫 무관찰 JPEG 읽기가 10,114ms 뒤 실패했다. 후속 전체 서버 **진단**에서도 첫 디코더는 3,505ms에 `D / folio_wait_bit_common`, user CPU 0 tick, major faults 40, 출력 0바이트, RSS 3,508KiB였다. 그 진단은 583개를 통과했지만 최초 실패를 대체하지 않는다. 이 표본은 실행 시작 구간의 OS 페이지 읽기 대기를 보여 준다. 정확히 어느 파일/호스트 계층이 느린지와 최악 지연은 입증하지 않는다.

일반 headless도 GPU·장치·자막·네트워크 라이브러리를 기본 포함한다. 같은 고정 Nixpkgs `1559d3daa3ecc813a650b79375ea61b6741b8746`와 FFmpeg **8.1.2**에서 필요한 기능만 명시한 빌드를 사용하도록 `replit.nix`를 수정했다. 초기 라이브러리 로딩 부담을 줄이는 수정으로, 아래 Replit 실제 빌드·첫 일반 전체 회귀·실행 경로 검증까지 완료했다.

## 그대로 유지하는 것

- 입력 MP4/MOV/WebM, 내장 코덱·컨테이너·필터, FFmpeg/FFprobe, lavfi 합성 자료 생성, JPEG/RGB 검사.
- H.264/H.265/VP8/VP9/AV1 및 Opus 관련 x264/x265/libvpx/libaom/dav1d/opus, zlib.
- safe-bitstream-reader, hardcoded tables, runtime CPU detection, pixel utilities를 명시적으로 유지한다. 기능군 기본값을 끄면서 안전 옵션까지 꺼지는 일을 검사로 차단한다.
- I/O 4.5초, 디코더 기동+해독 10초, 전체 최대 15초, 해시·승인·소유권 재확인, 실제 해독·정확한 출력 크기, 취소·동시 1개 제한은 수정하지 않는다.
- 원본 일반 테스트 순서·동시성·검사 항목은 유지한다. 테스트 제외·재시도·사전 예열·외부 디코더·바이너리 버전 하향은 없다.

FFmpeg 내부 네트워크는 빌드에서 제외한다. 앱은 이미 로컬 file/pipe 입력만 허용하므로 영상 처리 경로와 맞는다. GPU/장치 캡처·자막 렌더링·네트워크 스트리밍 연동을 제거하며, ShowMe의 화면 녹화는 브라우저에서 수행하는 기존 방식 그대로다. 변경은 설치 패키지 구성이고 제품 요구사항이나 기준 MD 변경이 아니다.

공식 고정 원본: [패키지 버전](https://github.com/NixOS/nixpkgs/blob/1559d3daa3ecc813a650b79375ea61b6741b8746/pkgs/development/libraries/ffmpeg/default.nix), [기능 기본값·빌드 정의](https://github.com/NixOS/nixpkgs/blob/1559d3daa3ecc813a650b79375ea61b6741b8746/pkgs/development/libraries/ffmpeg/generic.nix). 별도 공급자의 실행 파일을 받지 않는다. 사용자 영상·AI·DB/Storage는 이 빌드와 합성 검사에 사용하지 않는다.

## 검증 기록

- 로컬 이관/안전 검사 91/91 통과. 패키지 pin, 버전, 필수 라이브러리/안전 옵션 누락, 네트워크 재활성화, full fallback을 검사한다.
- H.265/AV1의 실제 생성→MP4 메타데이터 확인→JPEG/썸네일 추출 검사 2개를 추가했다. 기존 MP4/MOV/H.264/WebM/VP8/VP9·회전·장면 경계·손상 거부 검사는 유지한다. 로컬 일반 전체 744개(91+585+68), 실패·생략 0 및 API 테스트 타입 검사를 통과했다. 로컬 FFmpeg 통과가 새 Nix 빌드 통과를 대신하지 않는다.
- Replit에서 고정 Nix 소스의 새 패키지 빌드가 완료됐다. 그 패키지의 FFmpeg/FFprobe 경로를 테스트 전용 변수로 함께 지정한 **첫 일반 전체 회귀**에서 744개(91+585+68), 실패·생략 0을 확인했다. 첫 `private loader ... (without tracing)`는 **193.276ms**였다. 관찰기 preload·별도 이미지 검사·버전 확인으로 미리 예열하지 않았고, 기존 순서와 동시성 2를 유지했다. 이 한 번의 결과가 모든 호스트의 최악 cold-start 지연을 보장하지는 않는다.
- 전체 원본 출력은 Replit의 `/tmp/showme-scoped-media-tests-27f4506.log`에 보관했다. 테스트 뒤 종료 코드 표시용 Shell 구문의 오타가 있어 그 표시값은 사용하지 않았다. 동일 로그의 세 그룹 tests/pass가 각각 91/585/68이고 fail/skipped가 모두 0임을 별도 assertion으로 확인했다. 일반 회귀를 다시 실행해 결과를 대체하지 않았다.
- Replit 전체 타입 검사와 제품 빌드가 통과했다. 기존 ShowMe 번들 크기 543.52kB 경고는 남는다.
- 실제 FFmpeg 빌드 옵션에서 네트워크 비활성화, safe-bitstream-reader, x264/x265/vpx/aom/dav1d 유지 assertion이 통과했다. `nix-store -qR` 의존성 closure의 store path 수는 **118 → 17**이다. 이는 파일 수나 메모리 사용량 측정은 아니다.
- 실행 환경 확인 시 기존 Project workflow는 이미 실행 중이었다. 추가 재시작 없이 ShowMe API 작업 디렉터리의 유일한 `dist/index.mjs` 프로세스(PID 268)에서 미디어 경로 설정/PATH만 대조했다. FFmpeg/FFprobe 모두 새 `/nix/store/zp0dhr7957b4m6b6fnwz8xa1m9c837d4-ffmpeg-headless-8.1.2-bin/bin/`을 사용한다. 자격 증명 값이나 다른 프로세스 환경은 출력하지 않았다.
- API 직접 경로 `127.0.0.1:8080/api/healthz`와 웹 프록시 `127.0.0.1:20116/api/healthz` 모두 성공 응답 `{"status":"ok"}`를 확인했다. 코드 반영·검증·실행 확인을 완료했으며, main 병합/Publish·개인 영상 업로드·추가 AI 호출은 하지 않았다. 원래 기준 MD도 변경하지 않았다.
