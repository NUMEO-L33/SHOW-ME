import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import type { DraftIdentity, DraftSnapshot } from "@/lib/draft-client";
import { privacyWrite, requestPrivacyReview, type PrivacyReview, type PrivacyReviewAction } from "@/lib/privacy-review";

const kinds = { phone: "전화번호", account: "계좌", identity: "신원 정보", address: "주소", email: "이메일", balance: "잔액", password: "비밀번호", other: "기타" };
export function PrivacyReviewPanel({ identity, base, stepId, disabled, previewVerified, onSaved, onBusy }: {
  identity: DraftIdentity; base: DraftSnapshot; stepId: string; disabled: boolean; previewVerified: boolean;
  onSaved: (before: DraftSnapshot, saved: DraftSnapshot) => boolean; onBusy: (busy: boolean) => void;
}) {
  const [review, setReview] = useState<PrivacyReview | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController(); request.current?.abort(); request.current = abort;
    setReview(null); setError(""); setBusy(false); onBusy(false);
    if (!disabled && base.persisted) void requestPrivacyReview(identity, base, undefined, abort.signal).then(value => {
      if (!abort.signal.aborted) setReview(value.review);
    }).catch(() => { if (!abort.signal.aborted) setError("확인 상태를 불러오지 못했어요. 최신 저장본을 확인한 뒤 다시 열어 주세요."); });
    return () => { abort.abort(); };
  }, [identity.guideId, base.revision, disabled, refresh]);
  useEffect(() => () => { request.current?.abort(); onBusy(false); }, []);
  const act = async (action: PrivacyReviewAction) => {
    if (!review || disabled || busy || review.revision !== base.revision) return;
    const abort = new AbortController(); request.current?.abort(); request.current = abort;
    setBusy(true); onBusy(true); setError("");
    try {
      const value = await requestPrivacyReview(identity, base, privacyWrite(base, review, action), abort.signal);
      if (!abort.signal.aborted && !onSaved(base, value.draft)) throw new Error("EDITOR_CHANGED");
    } catch { if (!abort.signal.aborted) setError("저장을 확인하지 못했어요. 입력은 유지했습니다. 편집기의 ‘최신 저장본 불러오기’로 확인해 주세요."); }
    finally { if (!abort.signal.aborted) setBusy(false); onBusy(false); }
  };
  const step = review?.steps.find(s => s.stepId === stepId), content = base.document.steps.find(s => s.id === stepId);
  const blocked = disabled || busy || !step;
  return <section className="min-w-0 space-y-3 rounded-xl border p-3 [&_button]:h-auto [&_button]:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal" aria-label="개인정보 직접 확인">
    <h3 className="font-bold">개인정보 직접 확인</h3>
    <p className="text-xs leading-5">확인은 자동 탐지나 안전 보장이 아닙니다. 화면·가림·문구·새 후보가 바뀌면 관련 확인이 취소됩니다. 확인해도 공개되거나 AI로 전송되지 않습니다.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {!review && <Button variant="outline" disabled={disabled || busy} onClick={() => setRefresh(v => v + 1)}>확인 상태 다시 읽기</Button>}
    {step && <>
      <p className="text-sm">AI 후보 {step.candidates.length}개 {step.candidates.length === 0 && "· 후보가 없어도 직접 확인이 필요합니다."}</p>
      {step.candidates.map((candidate, index) => <div key={candidate.id} className="space-y-2 rounded-lg bg-slate-50 p-3 text-sm">
        <p>후보 {index + 1} · {kinds[candidate.kind]} · {candidate.status === "pending" ? "미확인" : candidate.status === "masked" ? "가림 선택" : "해당 없음 선택"}</p>
        <p className="text-xs">위치 {candidate.bounds.x}%, {candidate.bounds.y}% · 크기 {candidate.bounds.width}% × {candidate.bounds.height}%</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={blocked || !candidate.coveringMaskIds.length} onClick={() => void act({ type: "candidate", stepId, candidateId: candidate.id, status: "masked", maskId: candidate.coveringMaskIds[0] })}>가림 영역으로 처리</Button>
          <Button variant="outline" disabled={blocked} onClick={() => void act({ type: "candidate", stepId, candidateId: candidate.id, status: "dismissed", maskId: null })}>개인정보 아님</Button>
          {candidate.status !== "pending" && <Button variant="ghost" disabled={blocked} onClick={() => void act({ type: "candidate", stepId, candidateId: candidate.id, status: "pending", maskId: null })}>판단 취소</Button>}
        </div>
        {!candidate.coveringMaskIds.length && <p className="text-xs">가리려면 이 후보 전체를 덮는 영역을 추가하고 자동 저장을 기다려 주세요.</p>}
      </div>)}
      <p className="text-sm">이 단계 화면: {step.imageConfirmed ? "확인 저장됨" : "직접 확인 필요"}</p>
      <Button variant="outline" disabled={blocked || !step.imageConfirmed && (!previewVerified || step.candidates.some(c => c.status === "pending"))}
        onClick={() => void act({ type: "image", stepId, confirmed: !step.imageConfirmed })}>{step.imageConfirmed ? "화면 확인 취소" : "실제 처리본을 직접 확인했어요"}</Button>
      {!step.imageConfirmed && !previewVerified && <p className="text-xs">위의 ‘저장된 가림 이미지 확인’을 먼저 눌러 실제 처리본을 살펴보세요.</p>}
      <div className="rounded-lg bg-slate-50 p-3 text-sm"><p>{content?.shortLabel}</p><p className="mt-2 whitespace-pre-wrap">{content?.instruction}</p></div>
      <Button variant="outline" disabled={blocked} onClick={() => void act({ type: "text", stepId, confirmed: !step.textConfirmed })}>{step.textConfirmed ? "이 단계 문구 확인 취소" : "이 단계 문구의 개인정보를 확인했어요"}</Button>
      <p className="text-sm break-words">가이드 제목: {base.document.title}</p>
      <Button variant="outline" disabled={blocked} onClick={() => void act({ type: "title", confirmed: !review!.titleConfirmed })}>{review?.titleConfirmed ? "제목 확인 취소" : "제목의 개인정보를 확인했어요"}</Button>
      <p role="status" className="text-sm">{busy ? "확인 저장 중…" : review?.complete ? "모든 단계의 직접 확인이 저장됐어요. ‘게시·공유 관리’에서 공개 준비 상태를 확인하세요." : "아직 직접 확인할 항목이 남아 있어요."}</p>
    </>}
  </section>;
}
