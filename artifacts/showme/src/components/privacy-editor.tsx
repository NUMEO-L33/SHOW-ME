import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, ShieldCheck } from "lucide-react";
import { GuideScreen } from "./guide-screen";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import type { GuideStep } from "@/lib/showme-data";
import type { DraftIdentity, DraftSnapshot, EditorStep } from "@/lib/draft-client";
import { addMask, editMask, getPrivacyPreview, masksFor } from "@/lib/privacy-masks";
import { PrivacyReviewPanel } from "./privacy-review-panel";

export function PrivacyEditor({ step, onChange, disabled: editorDisabled, previewDisabled, identity, base, onPrivacySaved }: {
  step: GuideStep; onChange: (draft: EditorStep) => void; disabled: boolean; previewDisabled: boolean;
  identity?: DraftIdentity; base?: DraftSnapshot;
  onPrivacySaved: (before: DraftSnapshot, saved: DraftSnapshot) => boolean;
}) {
  const [reviewBusy, setReviewBusy] = useState(false);
  const disabled = editorDisabled || reviewBusy;
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [preview, setPreview] = useState<{ frame: string; thumbnail: string; key: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const resultView = useRef<HTMLElement | null>(null);
  const draft = step.draft!;
  const masks = masksFor(draft);
  const selected = masks.find(mask => mask.id === selectedId) ?? masks[0];
  const key = JSON.stringify([identity?.guideId, base?.revision, draft, previewDisabled]);
  useEffect(() => {
    request.current?.abort(); setPreview(null); setError(""); setLoading(false);
    return () => { request.current?.abort(); };
  }, [key, open]);
  useEffect(() => () => {
    if (preview) { URL.revokeObjectURL(preview.frame); URL.revokeObjectURL(preview.thumbnail); }
  }, [preview]);
  useEffect(() => { if (preview) resultView.current?.scrollIntoView({ block: "nearest" }); }, [preview]);
  const imageFailed = () => { setPreview(null); setError("처리 이미지를 표시하지 못했어요. 원본으로 대신 표시하지 않습니다. 다시 확인해 주세요."); };

  const showPreview = async () => {
    if (!identity || !base || previewDisabled || loading) return;
    request.current?.abort(); const abort = new AbortController(); request.current = abort;
    setPreview(null); setError(""); setLoading(true);
    try {
      const frame = await getPrivacyPreview(identity, base, draft.id, "frame", abort.signal);
      const thumbnail = await getPrivacyPreview(identity, base, draft.id, "thumbnail", abort.signal);
      if (abort.signal.aborted) return;
      setPreview({ frame: URL.createObjectURL(frame), thumbnail: URL.createObjectURL(thumbnail), key });
    } catch {
      if (!abort.signal.aborted) setError("처리본을 확인하지 못했어요. 최신 저장 상태를 확인하고 다시 눌러 주세요. 원본으로 대신 표시하지 않습니다.");
    } finally { if (!abort.signal.aborted) setLoading(false); }
  };
  const shown = !previewDisabled && preview?.key === key ? preview : null;
  return <>
    <div className="space-y-3 text-sm">
      <p className="flex items-center gap-2 font-black"><ShieldCheck className="size-4" />개인정보 가림</p>
      <p className="leading-6 text-muted-foreground">가림 영역 {masks.length}개 · 켜짐 {masks.filter(m => m.enabled).length}개. 자동 탐지 결과나 안전 판정이 아닙니다.</p>
      <Button variant="outline" className="min-h-11 w-full" disabled={disabled} onClick={() => setOpen(true)}>가림 영역 편집</Button>
      <p className="text-xs leading-5 text-muted-foreground">영역은 자동 저장됩니다. 처리본은 비공개로 확인하며 원본·AI 전송 이미지에는 적용되지 않습니다. 공개 여부는 ‘게시·공유 관리’에서 따로 확인하세요.</p>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto [&_button]:min-h-11 [&_input]:min-h-11">
        <DialogHeader><DialogTitle>가림 영역 편집</DialogTitle><DialogDescription>아래는 원본 위 영역 지정용 표시입니다. 마지막에 ‘저장된 가림 이미지 확인’을 눌러 실제 처리본을 확인하세요. 제목과 설명의 개인정보도 직접 확인해 주세요.</DialogDescription></DialogHeader>
        <div className="relative mx-auto w-full max-w-xl touch-none overflow-hidden rounded-xl border outline-offset-4 focus-visible:outline-2 focus-visible:outline-indigo-600"
          tabIndex={0} role="group" aria-label="가림 위치 편집. 방향키로 이동, Shift와 방향키로 크기 조절"
          onPointerDown={event => {
            if (!selected || disabled) return;
            const rect = event.currentTarget.getBoundingClientRect();
            onChange(editMask(draft, selected.id, { x: Math.round((event.clientX - rect.left) * 100 / rect.width - selected.bounds.width / 2),
              y: Math.round((event.clientY - rect.top) * 100 / rect.height - selected.bounds.height / 2) }));
            event.currentTarget.focus();
          }} onKeyDown={event => {
            const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
            if (!delta[event.key] || !selected || disabled) return;
            event.preventDefault(); const [x, y] = delta[event.key];
            onChange(editMask(draft, selected.id, event.shiftKey ? { width: selected.bounds.width + x, height: selected.bounds.height + y }
              : { x: selected.bounds.x + x, y: selected.bounds.y + y }));
          }}>
          <GuideScreen step={step} showTarget={false} className="!rounded-none" />
          {masks.map((mask, index) => <span key={mask.id} aria-hidden="true" className={`pointer-events-none absolute border-2 text-xs font-bold ${mask.id === selected?.id ? "border-indigo-600" : "border-purple-400"} ${mask.enabled ? "bg-purple-200/70" : "border-dashed bg-white/50"}`}
            style={{ left: `${mask.bounds.x}%`, top: `${mask.bounds.y}%`, width: `${mask.bounds.width}%`, height: `${mask.bounds.height}%` }}>{index + 1}</span>)}
        </div>
        <p className="text-xs text-muted-foreground">영역을 고른 뒤 화면을 눌러 이동하세요. 방향키로 이동하고 Shift+방향키로 크기를 바꿀 수 있습니다. 숫자로도 조정할 수 있어요.</p>
        <div className="flex flex-wrap gap-2">{masks.map((mask, index) => <Button key={mask.id} variant={mask.id === selected?.id ? "default" : "outline"} aria-pressed={mask.id === selected?.id} onClick={() => setSelectedId(mask.id)}>영역 {index + 1}{mask.enabled ? "" : " (꺼짐)"}</Button>)}</div>
        {selected && <fieldset disabled={disabled} className="space-y-3 rounded-xl border p-3">
          <legend className="px-1 text-sm font-semibold">선택 영역 위치·크기 (%)</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{(["x", "y", "width", "height"] as const).map((field, index) => <label key={field} className="text-xs">{["왼쪽", "위쪽", "너비", "높이"][index]}<Input type="number" min={field === "width" || field === "height" ? 1 : 0} max={100} step={1} value={selected.bounds[field]}
            onChange={event => { if (event.target.value !== "") onChange(editMask(draft, selected.id, { [field]: Number(event.target.value) })); }} /></label>)}</div>
          <div className="flex flex-wrap gap-2"><Button variant="outline" aria-pressed={selected.enabled} onClick={() => onChange(editMask(draft, selected.id, "toggle"))}>{selected.enabled ? "이 영역 가림 끄기" : "이 영역 가림 켜기"}</Button>
            <Button variant="outline" onClick={() => onChange(editMask(draft, selected.id, "remove"))}><Trash2 className="size-4" />영역 삭제</Button></div>
        </fieldset>}
        <Button variant="outline" disabled={disabled || masks.length >= 20} onClick={() => {
          const id = `mask:${crypto.randomUUID()}`; onChange(addMask(draft, id)); setSelectedId(id);
        }}><Plus className="size-4" />가림 영역 추가</Button>
        <p className="text-xs text-muted-foreground">최대 20개. 글자 가장자리까지 포함해 넉넉하게 지정하세요. 꺼진 영역과 선택하지 않은 내용은 그대로 남습니다.</p>
        {!masks.some(mask => mask.enabled) && <p className="text-sm text-amber-800">켜진 가림 영역이 없어 처리본에도 원본 내용이 그대로 보입니다.</p>}
        <Button disabled={disabled || previewDisabled || !identity || !base || loading} onClick={() => { void showPreview(); }}>{loading ? "가림 이미지 만드는 중…" : "저장된 가림 이미지 확인"}</Button>
        {previewDisabled && <p role="status" className="text-sm">자동 저장 완료 후 처리본을 확인할 수 있어요. 저장 실패나 충돌은 편집기에서 먼저 해결해 주세요.</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {shown && <section ref={resultView} className="space-y-3 rounded-xl border bg-slate-50 p-3" aria-label="픽셀에 가림을 반영한 처리본">
          <p className="text-sm font-bold">실제 처리본 · 비공개</p>
          <img src={shown.frame} alt="가림 처리된 전체 화면" className="w-full" onError={imageFailed} />
          <p className="text-xs">같은 처리본에서 만든 썸네일</p><img src={shown.thumbnail} alt="가림 처리된 썸네일" className="max-w-full" onError={imageFailed} />
          <p className="text-xs leading-5">이 이미지의 선택 영역은 원본과 무관한 픽셀 무늬로 대체됐습니다. 원본은 비공개 편집용으로 유지됩니다. 개인정보 검토 완료나 공개 승인을 뜻하지 않습니다.</p>
        </section>}
        {open && identity && base && <PrivacyReviewPanel identity={identity} base={base} stepId={draft.id}
          disabled={previewDisabled} previewVerified={Boolean(shown)} onSaved={onPrivacySaved} onBusy={setReviewBusy} />}
      </DialogContent>
    </Dialog>
  </>;
}
