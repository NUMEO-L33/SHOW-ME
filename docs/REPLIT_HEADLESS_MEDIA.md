# FFmpeg 초기 실행 지연 대응

## 변경과 근거

Replit `00d54a4`에서 진단 자체 7개는 통과했지만 이미지 21개 중 첫 무관찰 정상 읽기가 4.5초에 실패했다. 3.5초 OS 표본은 `D`/`folio_wait_bit_common`, user CPU 0 tick, major faults 59였다. 두 번째 실행도 같은 페이지 대기 상태였다가 완료됐다. 실행 파일/라이브러리 초기 읽기 지연이 유력하지만 특정 파일 또는 호스트 장애까지 입증한 기록은 아니다.

`replit.nix`에서 **같은 Nixpkgs 커밋과 FFmpeg 8.1.2**의 `ffmpeg_8-full`을 `ffmpeg_8-headless`로 교체한다. 고정 커밋의 [패키지 정의](https://github.com/NixOS/nixpkgs/blob/1559d3daa3ecc813a650b79375ea61b6741b8746/pkgs/development/libraries/ffmpeg/default.nix)와 [기능 정의](https://github.com/NixOS/nixpkgs/blob/1559d3daa3ecc813a650b79375ea61b6741b8746/pkgs/development/libraries/ffmpeg/generic.nix)를 확인했다. headless는 FFmpeg/FFprobe, avcodec/avfilter/avformat/swscale, libx264/libvpx 및 safe-bitstream-reader를 유지하면서 full 전용 통합 기능과 ffplay/SDL 등의 의존성을 제외한다. 임의 커스텀 빌드·버전 하향·번들 fallback은 사용하지 않는다.

앱 소스, 승인·해시·실제 JPEG 디코딩·출력 크기 확인, 기존 이미지 검사, 4.5초 시간 제한은 변경하지 않는다. 사전 FFmpeg 실행·캐시 강제 비우기·성공할 때까지 반복도 하지 않는다. headless에서도 호스트 I/O 지연이 생길 수 있으므로 Replit 실행 전에는 해결 완료로 판정하지 않는다.

## 적용 후 한 번 확인

로컬 검증: Windows/Node 24.15.0의 기존 의존성에서 안전 검사 61개, 기존 이미지 검사 21개 및 Bash 구문 검사가 통과했다. 패키지 정의는 고정 커밋 원본으로 확인했으나 이 PC에서 Nix headless 바이너리를 실행한 결과는 아니다. 새 headless의 Replit 실행·전체 회귀·초기 지연 해소는 아래 절차의 결과를 받아야 판정한다.

기존 `codex/replit-migration-hardening`에서 사용자 변경이 없는 경우 보완본을 받는다. 아래 Nix shell은 저장된 `replit.nix`의 미디어 의존성만 별도 실행 환경에 적용한다. 기존 Shell의 오래된 PATH에 의존하지 않는다. 패키지 캐시가 없다면 Nix가 해당 의존성을 다운로드할 수 있다. DB/Storage/Gemini 호출·서버 시작·Publish는 하지 않는다.

```sh
git pull --ff-only &&
bash scripts/check-replit-media.sh
```

이 검사는 `-version`이나 합성 해독으로 먼저 워밍업하지 않는다. 다만 Nix 다운로드/다른 프로세스가 OS 캐시에 미친 영향까지 통제한 강제 cold-cache 실험은 아니다. 이미지 검사 하나라도 실패하면 계속 진행하지 않고 실패로 남긴다. 통과하면 같은 headless 환경에서 전체 기본 검사와 빌드를 실행해 MOV/MP4/WebM, 회전·장면 추출, 손상 이미지 거부 등을 검증한다. 전체 검사 전에는 기능 호환 완료로 표시하지 않는다.

이후 Replit 관리 실행 환경이 재구성된 뒤 실제 `ffmpeg`와 `ffprobe`가 모두 headless 8.1.2로 선택됐는지 확인해야 한다. 위 시험 Shell만으로 현재 실행 중인 서버나 게시 환경까지 교체됐다고 판단하지 않는다. `FFMPEG_PATH`/`FFPROBE_PATH`를 예전에 명시했다면 그 설정이 오래된 full 바이너리를 가리키는지도 별도로 확인한다. 다른 Secrets는 출력하거나 변경하지 않는다.
