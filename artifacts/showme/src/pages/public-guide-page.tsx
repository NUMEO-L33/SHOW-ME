import { useEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { configuredProcessorUrl } from "@/lib/processor-client";
import { getPublicGuide, getPublicFrame, publicGuideFailure, type PublicGuideSnapshot } from "@/lib/public-guide-client";

/** Live public route never reads the private editor, localStorage or bundled sample. */
export default function PublicGuidePage() {
  const { slug = "" } = useParams<{ slug: string }>();
  return <PublishedViewer key={slug} slug={slug} />;
}
export function PublishedViewer({ slug }: { slug: string }) {
  const [guide, setGuide] = useState<PublicGuideSnapshot | null>(null), [error, setError] = useState("");
  const [index, setIndex] = useState(0), [refresh, setRefresh] = useState(0), [zoom, setZoom] = useState(false);
  const [frame, setFrame] = useState<{ url: string; key: string } | null>(null);
  const [checking, setChecking] = useState(true), [complete, setComplete] = useState(false);
  const viewport = useRef<HTMLDivElement | null>(null), previousId = useRef<string | null>(null);
  const baseUrl = configuredProcessorUrl();
  useEffect(() => {
    const abort = new AbortController(); setChecking(true); setError("");
    if (!baseUrl) { setGuide(null); setError("공유 서버에 연결할 수 없어요."); setChecking(false); return; }
    void (async () => {
      try {
        const next = await getPublicGuide(baseUrl, slug, abort.signal);
        if (abort.signal.aborted) return;
        if (Date.parse(next.expiresAt) <= Date.now()) throw new Error("EXPIRED");
        if (previousId.current !== next.publicationId) { setIndex(0); setComplete(false); setZoom(false); }
        previousId.current = next.publicationId; setGuide(next);
      } catch (e) { if (!abort.signal.aborted) { setGuide(null); setError(publicGuideFailure(e)); } }
      finally { if (!abort.signal.aborted) setChecking(false); }
    })();
    return () => abort.abort();
  }, [baseUrl, slug, refresh]);
  useEffect(() => {
    const renew = () => { if (document.visibilityState !== "hidden") setRefresh(v => v + 1); };
    const timer = setInterval(renew, 15_000);
    window.addEventListener("focus", renew); document.addEventListener("visibilitychange", renew);
    return () => { clearInterval(timer); window.removeEventListener("focus", renew); document.removeEventListener("visibilitychange", renew); };
  }, []);
  useEffect(() => {
    if (!guide) return;
    const remaining = Date.parse(guide.expiresAt) - Date.now();
    const timer = setTimeout(() => { setGuide(null); setError("공유 기간이 끝났어요."); }, Math.max(0, Math.min(remaining, 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [guide]);
  const frameKey = `${guide?.publicationId}:${index}:${refresh}`;
  useEffect(() => {
    setFrame(null);
    if (!guide || !guide.steps[index] || !baseUrl || checking || complete) return;
    const abort = new AbortController(); let url: string | undefined;
    void getPublicFrame(baseUrl, slug, guide, index, abort.signal).then(blob => {
      if (abort.signal.aborted) return;
      url = URL.createObjectURL(blob); setFrame({ url, key: frameKey });
    }).catch(e => { if (!abort.signal.aborted) { setGuide(null); setError(publicGuideFailure(e)); } });
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [guide, baseUrl, slug, index, checking, complete, frameKey]);
  const step = guide?.steps[index], shown = !checking && frame?.key === frameKey ? frame.url : null;
  useEffect(() => {
    if (!zoom || !step || !viewport.current) return;
    const area = viewport.current, target = step.taps[0]?.center ?? { x: 50, y: 50 };
    area.scrollLeft = area.scrollWidth * target.x / 100 - area.clientWidth / 2;
    area.scrollTop = area.scrollHeight * target.y / 100 - area.clientHeight / 2;
  }, [zoom, step, shown]);
  const go = (next: number) => {
    if (!guide || next < 0 || next >= guide.steps.length) return;
    setIndex(next); setZoom(false); setComplete(false);
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement)?.closest("input,textarea,button,a")) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); go(index - 1); }
      if (event.key === "ArrowRight") { event.preventDefault(); go(index + 1); }
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  });
  if (!guide || !step) return <main className="grid min-h-[100dvh] place-items-center bg-[#f7f8fc] p-6 text-[#172033]">
    <section className="max-w-lg space-y-5 text-center"><p className="text-sm font-bold">ShowMe · 공유 안내서</p>
      <h1 className="text-2xl font-black">{checking ? "공유 내용을 확인하고 있어요" : "안내서를 열 수 없어요"}</h1>
      {error && <p role="alert" className="text-lg leading-7">{error}</p>}
      <Button disabled={checking} className="min-h-11" onClick={() => setRefresh(v => v + 1)}>다시 불러오기</Button>
    </section></main>;
  return <main className="min-h-[100dvh] bg-[#f7f8fc] text-[#172033]">
    <header className="border-b bg-white px-5 py-4"><div className="mx-auto max-w-4xl"><p className="text-sm font-bold text-[#4f6df5]">ShowMe · 공유 안내서</p><h1 className="mt-2 break-words text-xl font-black">{guide.title}</h1><p className="mt-1 text-sm">{index + 1} / {guide.steps.length}단계 · {new Date(guide.expiresAt).toLocaleDateString("ko-KR")}까지</p></div></header>
    <section className="mx-auto max-w-4xl space-y-5 p-5 sm:p-8">
      {complete ? <div className="space-y-5 rounded-3xl bg-white p-8 text-center"><h2 className="text-3xl font-black">모두 확인했어요</h2><p className="text-lg">원래 화면으로 돌아가 천천히 따라 해보세요.</p><Button className="min-h-11" onClick={() => go(0)}>처음부터 다시 보기</Button></div> : <>
        <div aria-live="polite"><p className="font-bold text-[#4f6df5]">{index + 1}단계 · {step.shortLabel}</p><h2 className="mt-2 whitespace-pre-wrap break-words text-[22px] font-bold leading-8">{step.instruction}</h2></div>
        <div ref={viewport} tabIndex={0} role="region" aria-label="처리된 안내 이미지. 확대하면 스크롤로 이동할 수 있어요" className="max-h-[65dvh] min-h-48 overflow-auto rounded-2xl bg-[#121a2a] p-3 focus-visible:outline-2 focus-visible:outline-indigo-600">
          {shown ? <div className="relative mx-auto" style={{ width: zoom ? "200%" : "100%" }}><img src={shown} alt={`${index + 1}단계 처리된 화면`} className="block h-auto w-full" onError={() => { setGuide(null); setError("처리 이미지를 표시하지 못했어요. 다시 불러와 주세요."); }} />
            {step.taps.map((tap, i) => <span key={i} aria-label="누를 위치" className="pointer-events-none absolute grid size-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white bg-[#ff694e]/70 shadow-lg" style={{ left: `${tap.center.x}%`, top: `${tap.center.y}%` }}><span className="size-3 rounded-full bg-white" /></span>)}</div>
            : <p role="status" className="p-8 text-center text-white">공유 이미지 확인 중…</p>}
        </div>
        <Button variant="outline" className="min-h-11" aria-pressed={zoom} disabled={!shown} onClick={() => setZoom(v => !v)}>{zoom ? "전체 보기" : "누를 위치 중심 확대"}</Button>
        <nav aria-label="안내 단계 이동" className="grid grid-cols-2 gap-3"><Button variant="outline" className="min-h-14 text-lg" disabled={index === 0 || checking} onClick={() => go(index - 1)}>이전</Button><Button className="min-h-14 text-lg" disabled={!shown} onClick={() => index === guide.steps.length - 1 ? setComplete(true) : go(index + 1)}>{index === guide.steps.length - 1 ? "다 했어요" : "다음"}</Button></nav>
      </>}
      <p className="text-sm leading-6 text-muted-foreground">게시자가 확인한 문구와 처리 이미지만 표시합니다. 원본 영상은 제공하지 않습니다.</p>
    </section>
  </main>;
}
