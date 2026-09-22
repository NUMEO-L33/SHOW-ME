import { useEffect, useRef, useState } from "react";
import type { DraftIdentity, DraftSnapshot } from "@/lib/draft-client";
import { requestPrivacyReview, type PrivacyReview } from "@/lib/privacy-review";
import { canPublishSnapshot, PublicationSession, type PublicationView } from "@/lib/publication-session";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

const empty: PublicationView = { status: null, busy: false, error: "", unresolved: false };
const labels = { unpublished: "아직 공개하지 않았어요", publishing: "게시 이미지 준비 중", published: "링크로 공유 중", revoked: "공유가 중지됐어요", expired: "공유 기간이 끝났어요" };
export function PublicationWorkflow({ identity, base, blocked }: { identity: DraftIdentity; base?: DraftSnapshot; blocked: boolean }) {
  const [open, setOpen] = useState(false), [view, setView] = useState(empty);
  const session = useRef<PublicationSession | null>(null);
  const [review, setReview] = useState<{ value: PrivacyReview; key: string } | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null), [stopConfirmed, setStopConfirmed] = useState(false);
  const [refresh, setRefresh] = useState(0), [copied, setCopied] = useState(false);
  const key = JSON.stringify([identity.guideId, base?.revision, base?.inputFingerprint, blocked]);
  const currentReview = review?.key === key ? review.value : null;
  const confirmed = confirmedKey === key;
  useEffect(() => {
    const unavailable = { getItem() { throw new Error(); }, setItem() { throw new Error(); }, removeItem() { throw new Error(); } };
    let storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = unavailable;
    try { storage = window.localStorage; } catch { /* read-only status/withdraw still work */ }
    const value = new PublicationSession(identity, storage); session.current = value;
    const unsubscribe = value.subscribe(setView);
    return () => { unsubscribe(); value.dispose(); session.current = null; };
  }, [identity.guideId, identity.baseUrl, identity.editToken]);
  useEffect(() => {
    if (open) void session.current?.refresh();
  }, [open, refresh, identity.guideId]);
  useEffect(() => {
    setConfirmedKey(null); setReview(null); setReviewError("");
    if (!open || blocked || !base?.persisted) return;
    const abort = new AbortController();
    void requestPrivacyReview(identity, base, undefined, abort.signal).then(result => {
      if (!abort.signal.aborted) setReview({ value: result.review, key });
    }).catch(() => { if (!abort.signal.aborted) setReviewError("개인정보 확인 상태를 읽지 못했어요. 최신 저장본을 불러와 다시 확인해 주세요."); });
    return () => abort.abort();
  }, [open, key, refresh]);
  useEffect(() => {
    if (!open || view.busy || view.error || !view.status || !view.status.pendingJobId && !view.status.publicPath) return;
    const delay = view.status.pendingJobId ? 2000 : Math.min(15_000, Math.max(1, Date.parse(view.status.expiresAt!) - Date.now()));
    const timer = setTimeout(() => void session.current?.refresh(), delay);
    return () => clearTimeout(timer);
  }, [open, view]);
  useEffect(() => { setStopConfirmed(false); setCopied(false); }, [view.status?.headVersion, view.status?.pendingJobId, view.status?.publicPath]);
  const status = view.status;
  const ready = canPublishSnapshot(base, currentReview, blocked);
  const canSend = ready && confirmed && !view.busy && !view.error && status?.canRequest && !session.current?.newRequestBlocked;
  const link = status?.publicPath && status.expiresAt && Date.parse(status.expiresAt) > Date.now()
    ? new URL(`${import.meta.env.BASE_URL.replace(/\/$/, "")}${status.publicPath}`, window.location.origin).href : null;
  return <>
    <Button className="min-h-11 rounded-xl" onClick={() => { setCopied(false); setOpen(true); }}>게시·공유 관리</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto [&_button]:min-h-11 [&_button]:whitespace-normal">
      <DialogHeader><DialogTitle>게시·공유 관리</DialogTitle><DialogDescription>게시하면 링크를 아는 사람은 누구나 볼 수 있어요. 원본 영상은 공유하지 않습니다.</DialogDescription></DialogHeader>
      <p role="status" className="font-bold">{view.busy ? "서버 상태 확인 중…" : status ? labels[status.state] : "공유 상태를 확인해 주세요"}</p>
      {status?.pendingJobId && <p className="text-sm">가림 처리 이미지가 모두 준비된 뒤 링크가 확정됩니다. 이전 게시본이 있으면 그동안 유지돼요.</p>}
      {status?.job?.status === "failed" && <p role="alert" className="text-sm text-red-700">새 게시를 완료하지 못했어요. 최신 저장본과 개인정보 확인을 점검하세요. 기존 게시본이 있다면 유지됩니다.</p>}
      {view.error && <p role="alert" className="text-sm text-red-700">{view.error}</p>}
      {session.current?.recoveryUnavailable && <p role="alert" className="text-sm">브라우저의 게시 요청 기록을 확인할 수 없어 새 게시를 막았습니다. 기존 공유 조회·중지는 가능합니다.</p>}
      {view.unresolved && <p className="text-sm">이전 요청의 접수 여부를 확인 중입니다. 새 게시를 만들지 않고 같은 요청을 조회합니다.</p>}
      <Button variant="outline" disabled={view.busy} onClick={() => setRefresh(v => v + 1)}>게시 상태 다시 확인</Button>
      {link && <section className="space-y-3 rounded-xl border bg-slate-50 p-3" aria-label="공유 링크">
        <p className="text-sm break-all">{link}</p>
        <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { void navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? "링크 복사됨" : "링크 복사"}</Button>
          <a href={link} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="inline-flex min-h-11 items-center rounded-xl border px-4 text-sm font-bold">받는 화면 열기</a></div>
        <p className="text-sm">공유 종료: {new Date(status!.expiresAt!).toLocaleString("ko-KR")}</p>
      </section>}
      {status?.canWithdraw && <section className="space-y-3 rounded-xl border p-3">
        <label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" checked={stopConfirmed} onChange={e => setStopConfirmed(e.target.checked)} className="mt-1 size-5 shrink-0" />현재 링크와 진행 중 게시를 중지할게요. 이미 내려받은 자료는 회수할 수 없습니다.</label>
        <Button variant="outline" disabled={view.busy || Boolean(view.error) || !stopConfirmed} onClick={() => { setStopConfirmed(false); void session.current?.withdraw(); }}>공유 중지</Button>
      </section>}
      <section className="space-y-3 border-t pt-4" aria-label="새 게시 확인">
        <p className="text-sm leading-6">편집은 비공개 초안에만 저장돼요. 다시 게시해야 공유 내용이 바뀝니다. 공유는 첫 게시부터 15일이며 다시 게시해도 연장되지 않아요.</p>
        {blocked || !base?.persisted ? <p className="text-sm">최신 초안의 저장 완료를 먼저 확인해 주세요. 편집할 수 없는 작업도 기존 공유는 중지할 수 있어요.</p>
          : reviewError ? <p role="alert" className="text-sm text-red-700">{reviewError}</p>
          : !currentReview ? <p className="text-sm">개인정보 확인 상태를 읽고 있어요.</p>
          : !ready ? <p className="text-sm">각 단계의 ‘가림 영역 편집’에서 실제 처리본·문구·제목을 직접 확인해 주세요. 확인하지 않은 항목이 남아 있어요.</p>
          : <p className="text-sm text-green-800">현재 저장본의 모든 개인정보 직접 확인이 저장됐어요.</p>}
        {status && !status.canRequest && !status.pendingJobId && <p className="text-sm">지금은 새 게시를 시작할 수 없어요. 공개 기능 준비 상태 또는 보관 기간을 확인해 주세요.</p>}
        <label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" checked={confirmed && ready} disabled={!ready || view.busy} onChange={e => setConfirmedKey(e.target.checked ? key : null)} className="mt-1 size-5 shrink-0" />현재 저장본의 문구와 처리 이미지를 링크를 아는 사람에게 공유하는 데 동의해요. 개인정보 누락 여부도 직접 확인했어요.</label>
        <Button disabled={!canSend} onClick={() => { if (base) void session.current?.publish(base, currentReview, blocked, confirmed); setConfirmedKey(null); }}>{status?.activePublicationId ? "현재 저장본으로 다시 게시" : "확인한 내용 게시"}</Button>
      </section>
    </DialogContent></Dialog>
  </>;
}
