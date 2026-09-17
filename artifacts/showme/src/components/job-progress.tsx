import React from "react";
import { CircleAlert, LoaderCircle, Trash2 } from "lucide-react";
import type { JobIssue } from "../lib/job-feedback";

export type JobProgressProps = {
  phase: "sample" | "uploading" | "checking" | "processing" | "failed" | "deleting";
  fileName: string;
  progress: number;
  message?: string;
  issue: JobIssue | null;
  errorMessage: string | null;
  onCancel: () => void;
  onCheck: () => void;
  onRetry?: () => void;
  retrying: boolean;
  canCancel: boolean;
};

export function JobProgress({ phase, fileName, progress, message, issue, errorMessage, onCancel, onCheck, onRetry, retrying, canCancel }: JobProgressProps) {
  const deleting = phase === "deleting";
  const failed = Boolean(errorMessage);
  const showProgress = !deleting && !issue && !failed && phase !== "checking" && phase !== "uploading";
  const title = deleting ? "원본 영상과 추출 화면을 삭제하고 있어요"
    : failed ? "영상을 처리하지 못했어요"
    : issue ? issue.title
    : phase === "checking" ? "업로드 접수와 작업 상태를 확인하고 있어요"
    : phase === "uploading" ? "영상을 전송하고 있어요"
    : phase === "sample" ? "예시 화면을 준비하고 있어요"
    : "영상에서 장면을 추출하고 있어요";
  const label = deleting ? "영상 삭제" : issue || failed ? "작업 확인 필요" : "장면 추출";
  const percent = Math.round(Math.max(0, Math.min(100, progress)));
  return <main className="min-h-screen bg-[#f7f8fc] px-5 text-[#172033]">
    <header className="mx-auto flex h-[76px] max-w-[960px] items-center justify-between"><span className="text-xl font-black">ShowMe</span><span className="text-sm text-muted-foreground">{label}</span></header>
    <section className="mx-auto max-w-[680px] pb-16 pt-8 sm:pt-16">
      <div className="rounded-[30px] border border-[#e1e5ed] bg-white p-6 shadow-[0_28px_80px_rgba(20,32,61,.09)] sm:p-9" aria-busy={!issue && !failed}>
        <div className={`mb-5 grid size-16 place-items-center rounded-2xl ${deleting || issue || failed ? "bg-[#fff1ed] text-[#a7463a]" : "bg-[#eef1ff] text-[#4f6df5]"}`}>
          {deleting ? <Trash2 aria-hidden="true" /> : issue || failed ? <CircleAlert aria-hidden="true" /> : <LoaderCircle className="animate-spin" aria-hidden="true" />}
        </div>
        <p className="break-all text-sm font-bold text-muted-foreground">{fileName}</p>
        <h1 className="mt-2 text-2xl font-black leading-tight tracking-tight sm:text-3xl">{title}</h1>
        <div role={issue || failed ? "alert" : "status"} className="mt-4 space-y-3 text-sm leading-6 text-muted-foreground">
          {deleting ? <>
            <p>서버의 삭제 완료 응답을 기다리고 있어요. 완료 전에는 첫 화면으로 이동하거나 복구 기록을 지우지 않습니다.</p>
            <p>삭제 진행률은 제공되지 않습니다. 영상을 다시 분석하는 과정이 아니에요.</p>
          </> : <p>{errorMessage || issue?.message || message || "서버 응답을 확인하고 있어요."}</p>}
          {deleting && issue && <p className="rounded-xl border border-[#efc8bb] bg-[#fff8f5] p-3 text-[#934a34]">삭제 완료를 확인하지 못했어요. {issue.message}</p>}
          {issue && <p>{issue.autoRetry ? "기존 작업에 자동으로 다시 연결합니다." : "자동 조회를 멈췄어요. 연결을 확인한 뒤 아래 버튼으로 다시 조회할 수 있어요."}</p>}
          {!deleting && phase !== "sample" && !issue && !failed && <p>현재는 장면 추출 단계입니다. AI 설명·누를 위치·개인정보 분석은 아직 실행하지 않습니다.</p>}
          {phase === "sample" && <p>실제 파일을 업로드하거나 분석하지 않는 예시입니다.</p>}
          {phase === "uploading" && !issue && !failed && <p>파일 전송과 서버 접수 응답을 기다리고 있어요. 정확한 전송률은 제공하지 않습니다.</p>}
        </div>
        {showProgress && <div className="mt-7">
          <div className="mb-2 flex justify-between text-sm font-bold"><span>{phase === "sample" ? "예시 화면 준비" : "서버가 보고한 진행률"}</span><span>{percent}%</span></div>
          <progress className="h-3 w-full overflow-hidden rounded-full accent-[#4f6df5]" value={percent} max={100} aria-label="보고된 진행률" />
        </div>}
        <div className="mt-8 flex flex-wrap gap-3 border-t border-[#eaedf2] pt-5">
          {issue && !issue.autoRetry && <button type="button" className="min-h-11 rounded-xl bg-[#172033] px-4 text-sm font-bold text-white" onClick={onCheck}>{deleting ? "삭제 다시 확인" : "상태 다시 확인"}</button>}
          {failed && onRetry && <button type="button" className="min-h-11 rounded-xl bg-[#172033] px-4 text-sm font-bold text-white disabled:opacity-50" onClick={onRetry} disabled={retrying}>{retrying ? "요청 중…" : "원본으로 처리 재시도"}</button>}
          {deleting ? <p className="text-sm font-semibold text-muted-foreground">{issue ? "삭제 확인 대기 · 복구 기록 유지" : "삭제 응답 대기 중…"}</p>
            : <button type="button" className="min-h-11 rounded-xl border px-4 text-sm font-bold" onClick={onCancel}>{canCancel ? "이 작업 삭제하고 나가기" : "영상 선택으로 돌아가기"}</button>}
        </div>
      </div>
    </section>
  </main>;
}
