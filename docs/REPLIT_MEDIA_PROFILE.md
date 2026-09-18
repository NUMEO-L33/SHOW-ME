# Replit 첫 JPEG 실행 지연: 미디어 의존성 축소

## 관측과 범위

2026-09-18. `87d2607`의 최초 일반 회귀에서 첫 무관찰 JPEG 읽기가 10,114ms 뒤 실패했다. 후속 전체 서버 **진단**에서도 첫 디코더는 3,505ms에 `D / folio_wait_bit_common`, user CPU 0 tick, major faults 40, 출력 0바이트, RSS 3,508KiB였다. 그 진단은 583개를 통과했지만 최초 실패를 대체하지 않는다. 이 표본은 실행 시작 구간의 OS 페이지 읽기 대기를 보여 준다. 정확히 어느 파일/호스트 계층이 느린지와 최악 지연은 입증하지 않는다.

일반 headless도 GPU·장치·자막·네트워크 라이브러리를 기본 포함한다. 같은 고정 Nixpkgs `1559d3daa3ecc813a650b79375ea61b6741b8746`와 FFmpeg **8.1.2**에서 필요한 기능만 명시한 빌드를 사용하도록 `replit.nix`를 수정했다. 초기 라이브러리 로딩 부담을 줄이는 수정 후보이며, Replit 실제 빌드와 정상 전체 회귀 전에는 해결로 판단하지 않는다.

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
- 실제 Nix 빌드, Replit 전체 회귀 및 실행 환경 경로 검증은 진행 중이다. 기존 Project workflow는 아직 중지 상태다.
