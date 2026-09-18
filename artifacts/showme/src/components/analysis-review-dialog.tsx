import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { analysisReviewFailure, getStoredAnalysis, type AnalysisPreview } from "@/lib/analysis-review";
import type { DraftIdentity, DraftSnapshot } from "@/lib/draft-client";

const reasons = { unclear_action: "동작 불명확", small_text: "작은 글씨", missing_context: "앞뒤 맥락 부족", privacy_uncertain: "개인정보 확인 필요" };

export function AnalysisReviewDialog({ identity, base, disabled, onApply }: {
  identity: DraftIdentity; base: DraftSnapshot; disabled: boolean;
  onApply: (preview: AnalysisPreview, selectedIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<AnalysisPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const close = () => { request.current?.abort(); request.current = null; setLoading(false); setOpen(false); setPreview(null); setSelected([]); };
  const inspect = async () => {
    if (disabled || request.current) return;
    setOpen(true); setLoading(true); setError(null); setPreview(null); setSelected([]);
    const abort = new AbortController();
    request.current = abort;
    try {
      const next = await getStoredAnalysis(identity, base, abort.signal);
      if (!abort.signal.aborted) setPreview(next);
    } catch (failure) { if (!abort.signal.aborted) setError(analysisReviewFailure(failure)); }
    finally { if (request.current === abort) { request.current = null; setLoading(false); } }
  };
  const run = preview?.analysis.run;
  const stale = Boolean(preview && (disabled || base.revision !== preview.base.revision || base.inputFingerprint !== preview.base.inputFingerprint ||
    JSON.stringify(base.document) !== JSON.stringify(preview.base.document)));

  return <section className="border-b bg-white px-5 py-3" aria-label="저장된 AI 결과">
    <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground">이미 저장된 AI 결과만 확인합니다. 새 분석이나 외부 전송은 시작하지 않습니다.</p>
      <Button variant="outline" disabled={disabled || loading} onClick={() => void inspect()}>저장된 AI 결과 확인</Button>
    </div>
    <Dialog open={open} onOpenChange={value => { if (!value) close(); }}>
      <DialogContent className="max-h-[85dvh] w-[calc(100%-2rem)] overflow-y-auto [overflow-wrap:anywhere] sm:max-w-2xl">
        <DialogHeader><DialogTitle>AI 결과 검토</DialogTitle><DialogDescription>
          선택한 단계의 제목·설명·누를 위치를 교체하고 자동 저장합니다. 가이드 제목·제작 의도·단계 순서는 유지합니다. 개인정보 가림과 공개는 실행하지 않습니다.
        </DialogDescription></DialogHeader>
        {loading && <p role="status">저장된 결과를 확인하고 있어요.</p>}
        {error && <p role="alert" className="text-sm text-[#a7463a]">{error}</p>}
        {preview && !run && <p role="status">이 영상에는 저장된 AI 결과가 없어요. AI 생성 기능은 아직 준비 중이며 현재 편집은 그대로 유지됩니다.</p>}
        {run && run.status !== "succeeded" && <p role="status">{run.status === "queued" ? "이 영상의 분석이 대기 중이에요." : run.status === "running" ? "이 영상의 분석이 진행 중이에요." : run.status === "cancelled" ? "이 영상의 분석은 취소됐어요." : "이 영상의 분석에 실패했어요."} 적용할 결과는 없으며 이 창을 열어도 재실행하지 않습니다.</p>}
        {run?.result && <>
          <p className="rounded-lg bg-amber-50 p-3 text-sm">AI가 잘못 설명할 수 있어요. 원본 화면과 비교해 주세요. 개인정보 후보가 0개여도 안전하다는 뜻은 아닙니다. 합친 단계는 이 창에서 교체하지 않습니다.</p>
          {preview!.base.document.steps.map((step, index) => {
            const value = run.result!.steps.find(candidate => candidate.stepId === step.activeFrameStepId)!;
            const merged = step.sourceStepIds.length !== 1;
            return <article key={step.id} className="space-y-2 rounded-lg border p-3 text-sm">
              <label className="flex items-center gap-2 font-bold">
                <input type="checkbox" disabled={merged || stale} checked={selected.includes(step.id)}
                  onChange={event => setSelected(ids => event.target.checked ? [...ids, step.id] : ids.filter(id => id !== step.id))} />
                {index + 1}단계에 적용{merged ? " (합친 단계 제외)" : ""}
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><p className="text-xs text-muted-foreground">현재 내용</p><p className="mt-1 font-bold">{step.shortLabel}</p><p className="whitespace-pre-wrap break-words">{step.instruction}</p></div>
                <div><p className="text-xs text-muted-foreground">AI 제안</p><p className="mt-1 font-bold">{value.shortLabel}</p><p className="whitespace-pre-wrap break-words">{value.instruction}</p>
                  <p className="mt-1 text-xs">{value.target ? `누를 위치: 가로 ${value.target.x}%, 세로 ${value.target.y}%` : "누를 위치 표시 없음 (기존 표시 제거)"}</p></div>
              </div>
              <p className="text-xs text-muted-foreground">개인정보 후보 {value.privacy.length}개 · 가림 미적용{value.reviewReasons.length ? ` · ${value.reviewReasons.map(reason => reasons[reason]).join(", ")}` : ""}{value.mergeWithNext ? " · 다음 단계와 합치기 제안 (적용하지 않음)" : ""}</p>
            </article>;
          })}
        </>}
        {stale && <p role="alert" className="text-sm text-[#a7463a]">편집 상태가 바뀌었어요. 창을 닫고 자동 저장을 확인한 뒤 다시 열어 주세요.</p>}
        <DialogFooter><Button variant="outline" onClick={close}>닫기</Button>
          {run?.result && <Button disabled={stale || !selected.length} onClick={() => {
            if (!preview || disabled) return;
            try { onApply(preview, selected); close(); }
            catch (failure) { setError(analysisReviewFailure(failure)); }
          }}>선택한 {selected.length}개 단계 적용</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
