import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  MousePointerClick,
  RotateCcw,
  Sparkles,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { GuideScreen } from "@/components/guide-screen";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { GUIDE_TITLE, INITIAL_GUIDE_STEPS, type GuideStep } from "@/lib/showme-data";

type PublicGuideProps = {
  onExit?: () => void;
  title?: string;
  steps?: GuideStep[];
};

export function PublicGuide({ onExit, title: suppliedTitle, steps: suppliedSteps }: PublicGuideProps) {
  const [storedGuide, setStoredGuide] = useState<{ title: string; steps: GuideStep[] }>({
    title: GUIDE_TITLE,
    steps: INITIAL_GUIDE_STEPS,
  });
  const [stepIndex, setStepIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [complete, setComplete] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const title = suppliedTitle ?? storedGuide.title;
  const steps = suppliedSteps ?? storedGuide.steps;
  const step = steps[stepIndex] ?? steps[0];
  const isLandscapeFrame = Boolean(step.frameWidth && step.frameHeight && step.frameWidth > step.frameHeight);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    const timer = window.setTimeout(() => {
      if (!suppliedSteps) {
        try {
          const saved = window.localStorage.getItem("showme:published-guide");
          if (saved) {
            const parsed = JSON.parse(saved) as { title?: unknown; steps?: unknown };
            if (typeof parsed.title === "string" && Array.isArray(parsed.steps) && parsed.steps.length > 0) {
              setStoredGuide({ title: parsed.title, steps: parsed.steps as GuideStep[] });
            }
          }
        } catch {
          // The bundled sample remains available when browser storage is blocked.
        }
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [suppliedSteps]);

  const goTo = (index: number) => {
    if (index < 0 || index >= steps.length) return;
    setStepIndex(index);
    setZoomed(false);
  };

  const goNext = () => {
    if (stepIndex === steps.length - 1) setComplete(true);
    else goTo(stepIndex + 1);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") goTo(stepIndex - 1);
      if (event.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (complete) {
    return (
      <main className="grid min-h-[100dvh] place-items-center bg-[#f7f8fc] px-5 py-12 text-[#172033]">
        <div className="w-full max-w-[520px] text-center">
          <div className="relative mx-auto mb-7 grid size-24 place-items-center rounded-full bg-[#eaf7f2] text-[#24775e]">
            <span className="absolute -right-2 top-1 grid size-8 place-items-center rounded-xl bg-[#fff0ed] text-primary"><Sparkles className="size-4" /></span>
            <Check className="size-11" strokeWidth={3} />
          </div>
          <p className="text-sm font-extrabold text-[#2a8067]">모두 확인했어요</p>
          <h1 className="mt-2 text-[clamp(2rem,7vw,3rem)] font-black tracking-[-0.055em]">가이드가 끝났어요</h1>
          <p className="mx-auto mt-4 max-w-[380px] text-[17px] font-medium leading-7 text-muted-foreground">이제 원래 화면으로 돌아가서 천천히 따라 해보세요.</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Button
              variant="outline"
              size="lg"
              className="h-13 rounded-[15px] border-[#dfe3ec] px-6 text-[15px] font-extrabold"
              onClick={() => {
                setComplete(false);
                goTo(0);
              }}
            >
              <RotateCcw className="size-4" />
              처음부터 다시 보기
            </Button>
            {onExit && (
              <Button size="lg" className="h-13 rounded-[15px] px-6 text-[15px] font-extrabold" onClick={onExit}>
                편집 화면으로
                <ArrowRight className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main
      className="flex min-h-[100dvh] flex-col overflow-hidden bg-white text-[#172033]"
      onTouchStart={(event) => {
        const touch = event.touches[0];
        touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
      }}
      onTouchEnd={(event) => {
        if (touchStart.current === null) return;
        const touch = event.changedTouches[0];
        const distanceX = touch.clientX - touchStart.current.x;
        const distanceY = touch.clientY - touchStart.current.y;
        if (Math.abs(distanceX) > 52 && Math.abs(distanceX) > Math.abs(distanceY) * 1.2) {
          if (distanceX < 0) goNext();
          else goTo(stepIndex - 1);
        }
        touchStart.current = null;
      }}
    >
      <header className="border-b border-[#e8ebf1] bg-white px-4 py-3.5 sm:px-6">
        <div className="mx-auto flex max-w-[760px] items-center gap-3">
          {onExit ? (
            <button className="grid size-11 shrink-0 place-items-center rounded-full text-[#5d687d] transition-colors hover:bg-[#f0f2f6]" onClick={onExit} aria-label="미리보기 닫기">
              <X className="size-5" />
            </button>
          ) : (
            <span className="grid size-10 shrink-0 place-items-center rounded-[13px] bg-primary text-white">
              <MousePointerClick className="size-5" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-extrabold tracking-[-0.02em] sm:text-base">{title}</h1>
            <div className="mt-2 flex items-center gap-3">
              <Progress value={((stepIndex + 1) / steps.length) * 100} className="h-1.5 flex-1 bg-[#edf0f5] [&_[data-slot=progress-indicator]]:bg-[#4f6df5]" aria-label={`전체 ${steps.length}단계 중 ${stepIndex + 1}단계`} />
              <span className="min-w-[38px] text-right text-xs font-black tabular-nums text-[#68738b]">{stepIndex + 1} / {steps.length}</span>
            </div>
          </div>
        </div>
      </header>

      <section className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col px-5 pb-2 pt-4 sm:px-8 sm:pt-5">
        <div aria-live="polite">
          <p className="text-sm font-black text-[#4f6df5]">{stepIndex + 1}단계</p>
          <h2 className="mt-1.5 text-[clamp(1.35rem,4.5vw,1.75rem)] font-black leading-[1.38] tracking-[-0.04em]">{step.instruction}</h2>
        </div>

        <div className="relative mt-4 flex min-h-[330px] flex-1 items-center justify-center overflow-hidden rounded-[28px] bg-[#121a2a] px-7 py-4 shadow-inner sm:min-h-[350px] sm:px-12 sm:py-5">
          <div className={`${isLandscapeFrame ? "viewer-landscape" : "viewer-phone"} transition-transform duration-300 ${zoomed ? "scale-[1.55]" : "scale-100"}`} style={{ transformOrigin: `${step.target.x}% ${step.target.y}%` }} onDoubleClick={() => setZoomed((current) => !current)}>
            <GuideScreen step={step} />
          </div>
          <button
            className="absolute bottom-3 right-3 flex h-11 items-center gap-2 rounded-full border border-white/10 bg-white/10 px-4 text-xs font-extrabold text-white backdrop-blur transition-colors hover:bg-white/20"
            onClick={() => setZoomed((current) => !current)}
            aria-pressed={zoomed}
          >
            {zoomed ? <ZoomOut className="size-4" /> : <ZoomIn className="size-4" />}
            {zoomed ? "전체 보기" : "확대"}
          </button>
        </div>

        <div className="flex items-center justify-center gap-2 py-3" aria-label="단계 선택">
          {steps.map((item, index) => (
            <button
              key={item.id}
              aria-label={`${index + 1}단계로 이동`}
              aria-current={index === stepIndex ? "step" : undefined}
              onClick={() => goTo(index)}
              className="group grid size-8 place-items-center rounded-full"
            >
              <span className={`h-2.5 rounded-full transition-all ${index === stepIndex ? "w-7 bg-[#4f6df5]" : "w-2.5 bg-[#dce1ea] group-hover:bg-[#aeb7c8]"}`} />
            </button>
          ))}
        </div>
      </section>

      <footer className="border-t border-[#e8ebf1] bg-white px-5 pb-[calc(14px+env(safe-area-inset-bottom))] pt-3 sm:px-8">
        <div className="mx-auto grid max-w-[760px] grid-cols-[1fr_1.45fr] gap-3">
          <Button
            variant="outline"
            size="lg"
            className="h-14 rounded-[16px] border-[#dbe0e9] text-base font-extrabold"
            disabled={stepIndex === 0}
            onClick={() => goTo(stepIndex - 1)}
          >
            <ArrowLeft className="size-5" />
            이전
          </Button>
          <Button size="lg" className="h-14 rounded-[16px] text-base font-extrabold shadow-[0_10px_24px_rgba(255,105,78,.22)]" onClick={goNext}>
            {stepIndex === steps.length - 1 ? "다 했어요" : "다음"}
            {stepIndex === steps.length - 1 ? <Check className="size-5" /> : <ArrowRight className="size-5" />}
          </Button>
        </div>
      </footer>
    </main>
  );
}
