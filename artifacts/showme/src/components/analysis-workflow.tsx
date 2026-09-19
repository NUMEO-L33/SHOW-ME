import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AnalysisReviewDialog } from "./analysis-review-dialog";
import { AnalysisConsentNotice } from "./analysis-consent-notice";
import { AnalysisSession, type AnalysisSessionState, type AnalysisStorage } from "@/lib/analysis-session";
import type { AnalysisPreview } from "@/lib/analysis-review";
import type { DraftIdentity, DraftSnapshot } from "@/lib/draft-client";

const initial: AnalysisSessionState = { busy: false, phase: "idle", availability: null, run: null, message: null, canStart: false, pollingPaused: false, frameCount: 0 };
const descriptions: Record<AnalysisSessionState["phase"], string> = {
  idle: "AI 설명 생성 안내를 확인할 수 있어요.", checking: "저장된 분석 상태를 확인하고 있어요.",
  starting: "분석 요청의 접수 여부를 확인하고 있어요.", queued: "분석을 기다리고 있어요.", running: "AI가 설명을 만들고 있어요.",
  cancelling: "서버에서 취소됐는지 확인하고 있어요.", cancelled: "분석이 취소됐어요. 현재 편집은 유지됩니다.",
  succeeded: "AI 결과가 준비됐어요. 아래 ‘저장된 AI 결과 확인’에서 검토 후 선택해 적용하세요.",
  failed: "AI 설명 생성에 실패했어요. 현재 편집은 유지되며 자동 재실행하지 않습니다.",
  uncertain: "분석 상태를 아직 확정하지 못했어요.", error: "분석 연결을 확인해 주세요.",
};

// Keyed by guide + media fingerprint at the parent: switching media aborts all
// old requests, while edits to the same draft never restart a generation.
export function AnalysisWorkflow({ identity, base, disabled, onApply }: {
  identity: DraftIdentity; base: DraftSnapshot; disabled: boolean;
  onApply: (preview: AnalysisPreview, selectedIds: string[]) => void;
}) {
  const [state, setState] = useState(initial);
  const [open, setOpen] = useState(false);
  const [external, setExternal] = useState(false);
  const [nonSensitive, setNonSensitive] = useState(false);
  const [consentBase, setConsentBase] = useState<DraftSnapshot | null>(null);
  const session = useRef<AnalysisSession | null>(null);
  const current = useRef({ identity, base }); current.current = { identity, base };
  useEffect(() => {
    // Storage is accessed lazily and exceptions are handled by the session.
    const storage: AnalysisStorage = { getItem: key => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value), removeItem: key => window.localStorage.removeItem(key) };
    const controller = new AnalysisSession(current.current.identity, current.current.base, storage, setState);
    session.current = controller;
    const visibility = () => controller.setVisible(document.visibilityState === "visible");
    visibility(); document.addEventListener("visibilitychange", visibility);
    void controller.refresh(); // read-only recovery, never a POST
    return () => { document.removeEventListener("visibilitychange", visibility); controller.dispose(); session.current = null; };
  }, []);
  useEffect(() => { session.current?.updateBase(base); }, [base]);
  const stale = !consentBase || JSON.stringify(consentBase) !== JSON.stringify(base);
  const allowStart = state.canStart && !disabled && !stale && external && nonSensitive;
  const close = () => { setOpen(false); setExternal(false); setNonSensitive(false); setConsentBase(null); };
  const showConsent = () => {
    setConsentBase(structuredClone(base)); setExternal(false); setNonSensitive(false); setOpen(true);
  };

  return <>
    <section className="border-b bg-white px-5 py-3" aria-label="AI 설명 생성과 진행">
      <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 text-sm">
          <p role="status" aria-live="polite">{descriptions[state.phase]}</p>
          {state.message && <p role="alert" className="mt-1 text-xs text-[#a7463a]">{state.message}</p>}
          {state.pollingPaused && <p className="mt-1 text-xs text-muted-foreground">자동 상태 확인을 잠시 멈췄어요. 작업을 취소한 것은 아닙니다. 상태를 다시 확인해 주세요.</p>}
          {state.availability?.startAvailable === false && <p className="mt-1 text-xs text-muted-foreground">현재 외부 AI 전송은 차단되어 있어요. 수동 편집과 자동 저장은 계속 사용할 수 있습니다.</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={state.busy} onClick={() => void session.current?.refresh()}>상태 다시 확인</Button>
          {state.run?.cancellable && <Button variant="outline" disabled={state.busy} onClick={() => void session.current?.cancel()}>AI 분석 취소</Button>}
          <Button variant="outline" onClick={showConsent} disabled={state.busy || Boolean(state.run?.cancellable)}>AI 설명 생성 안내</Button>
        </div>
      </div>
    </section>
    <AnalysisReviewDialog identity={identity} base={base} disabled={disabled || state.busy} onApply={onApply} />
    <Dialog open={open} onOpenChange={value => { if (!value) close(); }}>
      <DialogContent className="max-h-[85dvh] w-[calc(100%-2rem)] overflow-y-auto [overflow-wrap:anywhere] sm:max-w-xl">
        <DialogHeader><DialogTitle>AI 설명 생성 전 확인</DialogTitle><DialogDescription>
          ShowMe AI가 화면을 읽고 단계별 설명을 제안합니다. 아래 내용을 확인하고 시작 버튼을 눌러야 전송을 요청합니다.
        </DialogDescription></DialogHeader>
        <div className="space-y-3 text-sm leading-relaxed">
          <AnalysisConsentNotice frameCount={state.frameCount} />
          {!state.availability?.startAvailable && <p role="status" className="rounded-lg border p-3 font-medium">현재 서버의 실행 준비가 끝나지 않아 시작할 수 없습니다. 체크해도 외부 전송은 켜지지 않습니다.</p>}
          {(disabled || stale || base.revision === 0) && <p role="alert">현재 제목·설명을 편집해 자동 저장을 확인한 뒤 이 창을 다시 열어 주세요. 저장된 편집본에서만 분석을 요청할 수 있습니다.</p>}
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={nonSensitive} onChange={event => setNonSensitive(event.target.checked)} />전송 대상 전체에 개인·민감·기밀 정보가 없으며 사용이 승인된 합성 자료임을 확인했습니다.</label>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={external} onChange={event => setExternal(event.target.checked)} />안내된 화면과 정보가 Google로 전송·처리되는 것에 동의합니다.</label>
        </div>
        <DialogFooter><Button variant="outline" onClick={close}>닫기</Button>
          <Button disabled={!allowStart} onClick={() => {
            if (!allowStart || !consentBase) return;
            const consent = { externalProcessing: external, nonSensitive, base: consentBase };
            close(); void session.current?.start(consent, window.crypto.randomUUID());
          }}>동의하고 AI 설명 생성</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
