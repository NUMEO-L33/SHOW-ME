import { ProcessorClientError } from "./processor-client.js";

export const UPLOAD_RECOVERY_GRACE_MS = 20 * 60_000;
export type JobIssue = {
  title: string;
  message: string;
  autoRetry: boolean;
};

export function jobIssueFor(error: unknown, startedAt: number, now = Date.now()): JobIssue {
  if (error instanceof ProcessorClientError) {
    if (error.status === 404) return {
      title: "작업을 찾을 수 없어요",
      message: "업로드가 접수되지 않았거나 이 작업의 접근 권한을 확인할 수 없어요. 작업이 삭제됐다는 뜻은 아닙니다. 복구 기록은 유지하며, 새 영상을 자동으로 올리지 않습니다.",
      autoRetry: now >= startedAt && now - startedAt < UPLOAD_RECOVERY_GRACE_MS,
    };
    if (error.status === 401 || error.status === 403) return {
      title: "접근 인증을 확인해 주세요",
      message: "Replit 미리보기를 새 탭으로 열고 접근 가능한 계정인지 확인해 주세요. 영상 처리 실패 여부는 아직 알 수 없어요.",
      autoRetry: false,
    };
    if (error.code === "INVALID_RESPONSE") return {
      title: "서버 응답을 확인할 수 없어요",
      message: "예상한 작업 응답 대신 다른 응답을 받았어요. 미리보기 연결과 서버 상태를 확인해 주세요. 복구 기록은 유지합니다.",
      autoRetry: false,
    };
    if (error.code === "REQUEST_TIMEOUT") return {
      title: "서버 응답이 늦어지고 있어요",
      message: "작업이 멈췄는지는 아직 확인되지 않았어요. 새로 업로드하지 않고 기존 작업의 응답을 다시 확인합니다.",
      autoRetry: true,
    };
  }
  return {
    title: "서버 연결을 확인하고 있어요",
    message: "현재 작업 상태를 가져오지 못했어요. 마지막 진행률을 현재 상태처럼 표시하지 않고, 기존 작업으로 다시 연결합니다. Replit 미리보기 인증도 확인해 주세요.",
    autoRetry: true,
  };
}
