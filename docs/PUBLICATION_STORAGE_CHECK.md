# 합성 게시 저장소 검사

`artifacts/api-server/scripts/check-publication-storage.ts`는 기존 앱을 재시작하거나 공개 실행기를 켜지 않고 실제 저장소 어댑터와 게시/철회 경로를 확인한다.

## 범위와 실행

- 입력은 저장소의 고정 합성 JPEG fixture 하나뿐이다. 개인 파일·화면·기존 가이드를 입력받지 않는다. 실제 영상 업로드/장면 추출 검사는 아니다.
- metadata는 새 임시 JSON repository만 사용한다. `DATABASE_URL`, `.env`, 외부 AI 설정을 읽어 적용하지 않는다. 서버는 `127.0.0.1` 임의 포트에만 열고 기존 Replit 앱/DB/공개 기능은 변경하지 않는다.
- Replit 실행은 일치하는 개발 프로젝트 UUID와 명시적 저장소 사용 인수를 모두 요구한다. 운영 deployment, AI 활성 환경, 누락/위험한 bucket·prefix 설정은 거절한다. SDK 쓰기는 기존 prefix 아래 `diagnostics/publication/<새 UUID>/`로 격리한다.
- 접근 가능한 키는 새 가이드의 합성 원본 프레임/썸네일 두 개와 가림 PNG 두 개, 최대 네 개다. 소스 영상이나 다른 가이드 경로는 허용하지 않는다.

API 디렉터리에서 실행한다. 실제 Replit 저장소를 사용하는 두 번째 명령은 승인된 개발 프로젝트에서만 실행한다.

```sh
NODE_ENV=test node --import tsx scripts/check-publication-storage.ts --local-synthetic
node --import tsx scripts/check-publication-storage.ts --replit-development=<현재 개발 프로젝트 UUID> --confirm-synthetic-storage
```

로컬에서는 `SHOWME_TEST_FFMPEG_PATH`/`SHOWME_TEST_FFPROBE_PATH`로 기존 검사 바이너리를 지정할 수 있다. Replit에서는 기존 `FFMPEG_PATH`/`FFPROBE_PATH` 또는 PATH의 바이너리를 사용한다. 바이너리 설치·교체는 하지 않는다.

## 통과 조건

1. 새 진단 prefix가 비어 있는지 확인한다. 합성 JPEG 두 개를 저장하고 스트림 읽기와 materialize 결과를 원본 바이트와 비교한다.
2. 인증 없는 게시와 실행기 시작 전 게시를 거절한다. 격리된 실행기 시작 후 합성 초안만 게시한다.
3. 실제 FFmpeg/가림 처리로 생성한 공개 PNG와 썸네일이 전체 가림의 예상 바이트와 일치하며, 합성 원본 프레임과 검토 완료 시점의 원본 metadata가 변하지 않는지 확인한다.
4. 공유 중지 후 공개 JSON과 이전 이미지 URL이 모두 404인지 확인한다. 비동기 정리가 처리본을 삭제했는지 SDK `exists`로 확인한다.
5. 검사가 만든 정확한 키만 삭제하고 네 객체 모두 `exists:false`와 진단 prefix 목록이 비어 있음을 확인한다. 성공 시 자체 임시 fixture도 삭제한다.

읽기 실패를 삭제 성공으로 간주하지 않는다. 비밀/SDK 원문 오류는 출력하지 않는다. `PASS`와 함께 `remoteObjectsRemoved:true`, `localFixtureRemoved:true`, `pendingIO:false`가 있어야 실제 Replit 검사 완료다.

## 불완전한 실행

각 원격 쓰기 전에 자체 임시 폴더의 `storage-check.jsonl`에 대상 key를 기록한다. 제한시간 뒤 원격 I/O가 남으면 정리를 완료했다고 표시하거나 새 쓰기를 재시도하지 않는다. `CLEANUP_PENDING`의 자체 폴더와 manifest를 보존한다. 프로세스 최종 제한은 240초이며, 강제 종료도 원격 작업 취소/삭제 증명이 아니다. 실패 출력 뒤 검사를 무조건 다시 실행하지 말고, 기존 작업이 끝났는지와 기록된 정확한 prefix/키만 확인해야 한다. 이 문서는 미확정 운영 쓰기 해소 기능을 구현했다고 주장하지 않는다.

## 이 검사로 완료되지 않는 것

실제 PostgreSQL과 Replit Storage를 함께 쓰는 앱의 통합 게시, bucket 전체 IAM/공개 ACL 감사, 인터넷 공개 링크/실제 수신자/모바일 검증, 운영 배포 및 기본 공개 활성화는 별도다. 합성 전체 가림 검사는 임의 개인정보 자동 탐지 성능이나 모든 유출 위험이 없음을 증명하지 않는다. 원래 개발 계획의 목표와 완료 조건은 변경하지 않는다.
