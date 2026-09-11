"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Eye,
  FileVideo2,
  GitMerge,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MonitorSmartphone,
  MousePointerClick,
  Pencil,
  Plus,
  RefreshCcw,
  Share2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  Video,
} from "lucide-react";
import { toast } from "sonner";

import { GuideScreen } from "@/components/guide-screen";
import { PublicGuide } from "@/components/public-guide";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Toaster } from "@/components/ui/sonner";
import { GUIDE_TITLE, INITIAL_GUIDE_STEPS, type GuideStep } from "@/lib/showme-data";

type AppMode = "upload" | "processing" | "review" | "viewer" | "published";
type SaveState = "saved" | "saving";

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5 font-extrabold tracking-[-0.04em]" aria-label="ShowMe">
      <span className={`grid place-items-center rounded-[12px] bg-primary text-primary-foreground shadow-[0_8px_24px_rgba(255,105,78,.22)] ${compact ? "size-8" : "size-9"}`}>
        <MousePointerClick className={compact ? "size-[17px]" : "size-[19px]"} strokeWidth={2.4} />
      </span>
      <span className={compact ? "text-[18px]" : "text-[20px]"}>ShowMe</span>
    </span>
  );
}

function formatFileSize(bytes: number) {
  return `${Math.max(0.1, bytes / 1024 / 1024).toFixed(1)}MB`;
}

function UploadScreen({ onStart }: { onStart: (name: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  const chooseFile = (nextFile?: File) => {
    if (!nextFile) return;
    const supported = ["video/mp4", "video/quicktime", "video/webm"].includes(nextFile.type) || /\.(mp4|mov|webm)$/i.test(nextFile.name);
    if (!supported) {
      toast.error("MP4, MOV, WebM 영상만 올릴 수 있어요.");
      return;
    }
    if (nextFile.size > 500 * 1024 * 1024) {
      toast.error("영상 크기는 500MB 이하여야 해요.");
      return;
    }
    setFile(nextFile);
  };

  return (
    <main className="min-h-screen overflow-hidden bg-background text-foreground">
      <header className="mx-auto flex h-[76px] max-w-[1180px] items-center justify-between px-5 sm:px-8">
        <Logo />
        <div className="flex items-center gap-3">
          <button
            className="hidden h-10 items-center gap-2 rounded-full px-4 text-sm font-extrabold text-[#526078] transition-colors hover:bg-white sm:flex"
            onClick={() => onStart("showme-example.mp4")}
          >
            <Eye className="size-4" />
            예시로 둘러보기
          </button>
          <div className="hidden items-center gap-2 text-sm font-semibold text-muted-foreground lg:flex">
            <ShieldCheck className="size-4 text-[#257a61]" />
            로그인 없이 바로 만들어요
          </div>
        </div>
      </header>

      <section className="relative mx-auto grid max-w-[1180px] gap-8 px-5 pb-14 pt-8 sm:px-8 sm:pt-14 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-center lg:gap-14 lg:pt-20">
        <div className="pointer-events-none absolute -left-48 top-24 -z-0 size-[520px] rounded-full bg-[rgba(79,109,245,.075)] blur-[90px]" />
        <div className="relative z-10">
          <div className="mb-5 flex items-center gap-2 text-sm font-bold text-primary">
            <span className="rounded-full bg-primary/10 px-3 py-1.5">새 가이드</span>
            <span className="text-muted-foreground">녹화 한 번, 설명은 끝</span>
          </div>
          <h1 className="max-w-[700px] text-[clamp(2.35rem,4.3vw,4rem)] font-black leading-[1.04] tracking-[-0.06em] text-[#172033]">
            녹화 한 번이면,
            <br />
            <span className="text-primary">따라 하기 쉬운 안내서</span>로.
          </h1>
          <p className="mt-5 max-w-[610px] text-[17px] font-medium leading-7 text-muted-foreground sm:text-[18px]">
            중요한 장면과 누를 곳, 쉬운 설명을 AI가 알아서 정리합니다. <span className="whitespace-nowrap">완성된 링크만 카카오톡으로 보내세요.</span>
          </p>

          <div className="mt-9 rounded-[28px] border border-border/80 bg-card p-3 shadow-[0_28px_80px_rgba(20,32,61,.1)] sm:p-4">
            <input
              ref={inputRef}
              className="sr-only"
              type="file"
              tabIndex={-1}
              aria-label="화면 녹화 영상 선택"
              accept="video/mp4,video/quicktime,video/webm"
              onChange={(event) => chooseFile(event.target.files?.[0])}
            />
            <div
              className={`group relative flex min-h-[250px] cursor-pointer flex-col items-center justify-center rounded-[20px] border-2 border-dashed px-5 py-8 text-center transition-all ${dragging ? "border-primary bg-primary/[.055]" : file ? "border-[#5b78f2]/45 bg-[#f7f9ff]" : "border-[#d7dce8] bg-[#fafbfe] hover:border-primary/55 hover:bg-primary/[.025]"}`}
              onClick={() => inputRef.current?.click()}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                chooseFile(event.dataTransfer.files?.[0]);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
              }}
            >
              {file ? (
                <>
                  <span className="mb-4 grid size-14 place-items-center rounded-2xl bg-[#e9edff] text-[#4867eb]"><FileVideo2 className="size-7" /></span>
                  <p className="max-w-full truncate text-lg font-extrabold text-[#172033]">{file.name}</p>
                  <p className="mt-1 text-sm font-medium text-muted-foreground">{formatFileSize(file.size)} · 업로드 준비 완료</p>
                  <span className="mt-5 text-sm font-bold text-primary">다른 영상 고르기</span>
                </>
              ) : (
                <>
                  <span className="mb-4 grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary transition-transform group-hover:-translate-y-1"><UploadCloud className="size-7" /></span>
                  <p className="text-lg font-extrabold text-[#172033]">화면 녹화 영상을 여기에 놓으세요</p>
                  <p className="mt-2 text-sm font-medium text-muted-foreground">또는 눌러서 파일을 고르세요</p>
                  <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-xs font-bold text-[#64708a]">
                    <span className="rounded-full border bg-white px-3 py-1.5">MP4 · MOV · WebM</span>
                    <span className="rounded-full border bg-white px-3 py-1.5">최대 500MB</span>
                  </div>
                </>
              )}
            </div>
            {!file && (
              <button
                className="mx-auto mt-3 block min-h-11 px-3 text-sm font-extrabold text-[#5069d9] underline decoration-[#bfc8f3] underline-offset-4 sm:hidden"
                onClick={() => onStart("showme-example.mp4")}
              >
                예시 화면으로 둘러보기
              </button>
            )}
            <div className="flex flex-col gap-3 px-1 pb-1 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-muted-foreground">
                <ShieldCheck className="size-4 text-[#257a61]" />
                개인정보는 게시 전에 꼭 확인할 수 있어요
              </p>
              <Button
                size="lg"
                disabled={!file}
                className="h-12 rounded-[14px] px-6 text-[15px] font-extrabold shadow-[0_10px_24px_rgba(255,105,78,.22)]"
                onClick={() => file && onStart(file.name)}
              >
                가이드 만들기
                <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>

        <aside className="relative z-10 hidden lg:block" aria-label="가이드 생성 과정">
          <div className="absolute -right-12 -top-12 size-32 rounded-full border-[28px] border-primary/10" />
          <div className="relative rotate-[1.25deg] rounded-[30px] border border-[#dfe4ef] bg-white p-6 shadow-[0_26px_70px_rgba(24,35,64,.12)]">
            <div className="mb-7 flex items-center justify-between">
              <div><p className="text-xs font-bold text-muted-foreground">AI가 정리하는 중</p><p className="mt-1 text-lg font-black tracking-[-0.03em] text-[#172033]">5단계로 딱 맞게</p></div>
              <span className="grid size-11 place-items-center rounded-2xl bg-[#eef1ff] text-[#4f6df5]"><MonitorSmartphone className="size-5" /></span>
            </div>
            <div className="space-y-3">
              {["필요한 장면만 고르기", "누를 곳과 설명 표시", "개인정보 찾아 가리기"].map((label, index) => (
                <div key={label} className="flex items-center gap-3 rounded-2xl border border-[#e9ecf3] bg-[#fbfcff] p-3.5">
                  <span className={`grid size-8 shrink-0 place-items-center rounded-full text-sm font-black ${index === 2 ? "bg-primary text-white" : "bg-[#eaf6f1] text-[#257a61]"}`}>{index === 2 ? "3" : <Check className="size-4" strokeWidth={3} />}</span>
                  <span className="text-sm font-extrabold text-[#25304a]">{label}</span>
                </div>
              ))}
            </div>
            <div className="mt-5 rounded-2xl bg-[#172033] p-4 text-white">
              <p className="text-xs font-bold text-white/55">완성 예상 시간</p>
              <div className="mt-1 flex items-end justify-between">
                <p className="text-2xl font-black tracking-[-0.05em]">약 1분</p>
                <div className="flex items-center gap-1.5 text-xs font-bold text-[#aeb9ff]"><span className="size-1.5 rounded-full bg-[#7f95ff]" />자동 저장</div>
              </div>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

const PROCESSING_STEPS = [
  { label: "영상 확인", threshold: 10 },
  { label: "화면을 단계로 나누기", threshold: 28 },
  { label: "설명과 누를 위치 만들기", threshold: 54 },
  { label: "개인정보 가림 준비", threshold: 82 },
];

function ProcessingScreen({ progress, fileName, onCancel }: { progress: number; fileName: string; onCancel: () => void }) {
  const activeIndex = Math.min(PROCESSING_STEPS.length - 1, PROCESSING_STEPS.filter((item) => progress >= item.threshold).length);

  return (
    <main className="min-h-screen bg-[#f7f8fc] px-5 text-[#172033]">
      <header className="mx-auto flex h-[76px] max-w-[960px] items-center justify-between"><Logo /><span className="hidden text-sm font-bold text-muted-foreground sm:block">가이드 만드는 중</span></header>
      <section className="mx-auto grid max-w-[960px] place-items-center pb-16 pt-8 sm:pt-16">
        <div className="w-full max-w-[680px] rounded-[30px] border border-[#e1e5ed] bg-white p-5 shadow-[0_28px_80px_rgba(20,32,61,.09)] sm:p-9">
          <div className="flex flex-col gap-5 border-b border-[#eaedf2] pb-7 sm:flex-row sm:items-center">
            <div className="relative grid size-20 shrink-0 place-items-center rounded-[24px] bg-[#fff0ed] text-primary">
              <Video className="size-8" />
              <span className="absolute -right-1 -top-1 grid size-7 place-items-center rounded-full border-4 border-white bg-[#4f6df5] text-white"><Sparkles className="size-3" /></span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-[#758097]">{fileName}</p>
              <h1 className="mt-1 text-[clamp(1.65rem,5vw,2.25rem)] font-black tracking-[-0.045em]">AI가 화면을 살펴보고 있어요</h1>
              <p className="mt-2 text-[15px] font-medium leading-6 text-muted-foreground">창을 닫아도 작업은 이어집니다. 보통 1분 안에 끝나요.</p>
            </div>
          </div>

          <div className="py-7">
            <div className="mb-3 flex items-end justify-between"><p className="text-sm font-extrabold text-[#4f5a71]">전체 진행</p><p className="text-2xl font-black tabular-nums text-[#4f6df5]">{Math.round(progress)}%</p></div>
            <Progress value={progress} className="h-3 bg-[#e8ebf5] [&_[data-slot=progress-indicator]]:bg-[#4f6df5]" aria-label={`가이드 생성 ${Math.round(progress)}%`} />
          </div>

          <div className="space-y-2.5" aria-live="polite">
            {PROCESSING_STEPS.map((item, index) => {
              const done = index < activeIndex || progress >= 100;
              const active = index === activeIndex && progress < 100;
              return (
                <div key={item.label} className={`flex items-center gap-3 rounded-[16px] border px-4 py-3.5 transition-colors ${active ? "border-[#cfd7ff] bg-[#f5f7ff]" : "border-transparent"}`}>
                  <span className={`grid size-8 shrink-0 place-items-center rounded-full ${done ? "bg-[#e7f5ef] text-[#257a61]" : active ? "bg-[#4f6df5] text-white" : "bg-[#eef0f4] text-[#929bad]"}`}>
                    {done ? <Check className="size-4" strokeWidth={3} /> : active ? <LoaderCircle className="size-4 animate-spin" /> : <span className="text-xs font-black">{index + 1}</span>}
                  </span>
                  <span className={`text-[15px] font-extrabold ${done ? "text-[#597064]" : active ? "text-[#293a7a]" : "text-[#8a93a5]"}`}>{item.label}</span>
                  {active && <span className="ml-auto text-xs font-bold text-[#6a78bd]">처리 중</span>}
                  {done && <span className="ml-auto text-xs font-bold text-[#3f856e]">완료</span>}
                </div>
              );
            })}
          </div>

          <div className="mt-7 flex items-center justify-between rounded-[16px] bg-[#f6f7fa] px-4 py-3 text-sm">
            <p className="flex items-center gap-2 font-semibold text-[#6e788d]"><Clock3 className="size-4" />남은 시간 약 {progress > 78 ? "10초" : progress > 42 ? "25초" : "45초"}</p>
            <button className="font-extrabold text-[#68738b] hover:text-[#172033]" onClick={onCancel}>다른 영상 선택</button>
          </div>
        </div>
      </section>
    </main>
  );
}

type ReviewScreenProps = {
  title: string;
  setTitle: (title: string) => void;
  steps: GuideStep[];
  setSteps: React.Dispatch<React.SetStateAction<GuideStep[]>>;
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  onPreview: () => void;
  onPublished: () => void;
};

function ReviewScreen({ title, setTitle, steps, setSteps, activeIndex, setActiveIndex, onPreview, onPublished }: ReviewScreenProps) {
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [regenerating, setRegenerating] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [privacyConfirmed, setPrivacyConfirmed] = useState(false);
  const [shareOriginal, setShareOriginal] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeStep = steps[activeIndex] ?? steps[0];
  const enabledMasks = steps.reduce((sum, step) => sum + (step.privacyEnabled ? step.privacyCount : 0), 0);
  const disabledMasks = steps.reduce((sum, step) => sum + (!step.privacyEnabled ? step.privacyCount : 0), 0);

  const markSaving = () => {
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setSaveState("saved"), 650);
  };

  const updateActiveStep = (changes: Partial<GuideStep>, privacyChanged = false) => {
    setSteps((current) => current.map((step, index) => index === activeIndex ? { ...step, ...changes } : step));
    markSaving();
    if (privacyChanged) setPrivacyConfirmed(false);
  };

  const moveTarget = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(4, Math.min(96, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(4, Math.min(96, ((event.clientY - rect.top) / rect.height) * 100));
    updateActiveStep({ target: { x: Math.round(x), y: Math.round(y) } });
  };

  const moveTargetByKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const deltaByKey: Record<string, { x: number; y: number }> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const delta = deltaByKey[event.key];
    if (!delta) return;
    event.preventDefault();
    updateActiveStep({
      target: {
        x: Math.max(4, Math.min(96, activeStep.target.x + delta.x)),
        y: Math.max(4, Math.min(96, activeStep.target.y + delta.y)),
      },
    });
  };

  const removeStep = () => {
    if (steps.length <= 1) return;
    const removed = activeStep.shortLabel;
    setSteps((current) => current.filter((_, index) => index !== activeIndex));
    setActiveIndex(Math.max(0, activeIndex - 1));
    markSaving();
    toast.success(`‘${removed}’ 단계를 삭제했어요.`);
  };

  const mergeStep = () => {
    if (activeIndex === 0) {
      toast.info("첫 단계는 이전 단계와 합칠 수 없어요.");
      return;
    }
    const previous = steps[activeIndex - 1];
    setSteps((current) => current.map((step, index) => index === activeIndex - 1 ? {
      ...activeStep,
      id: previous.id,
      shortLabel: `${previous.shortLabel} · ${activeStep.shortLabel}`,
      privacyCount: previous.privacyCount + activeStep.privacyCount,
      privacyEnabled: previous.privacyEnabled || activeStep.privacyEnabled,
    } : step).filter((_, index) => index !== activeIndex));
    setActiveIndex(activeIndex - 1);
    markSaving();
    toast.success("두 단계를 하나로 합쳤어요.");
  };

  const regenerate = () => {
    setRegenerating(true);
    setTimeout(() => {
      const rewritten: Record<GuideStep["screen"], string> = {
        home: "홈 화면의 빠른 메뉴에서 ‘이체’를 누르세요.",
        account: "잔액을 확인한 뒤 돈을 보낼 계좌를 누르세요.",
        recipient: "은행을 고른 뒤, 받는 분 계좌번호를 입력하세요.",
        amount: "보낼 금액을 입력하고 화면 아래 ‘다음’을 누르세요.",
        confirm: "받는 분과 금액이 맞으면 ‘이체하기’를 누르세요.",
      };
      updateActiveStep({ instruction: rewritten[activeStep.screen] });
      setRegenerating(false);
      toast.success("이 단계의 설명과 누를 곳을 다시 만들었어요.");
    }, 1200);
  };

  return (
    <main className="min-h-screen bg-[#f4f6fa] text-[#172033]">
      <header className="sticky top-0 z-40 border-b border-[#dfe3eb] bg-white/95 px-4 backdrop-blur sm:px-5">
        <div className="mx-auto flex h-[68px] max-w-[1540px] items-center gap-3">
          <Logo compact />
          <span className="mx-2 hidden h-7 w-px bg-[#e3e6ed] sm:block" />
          <div className="hidden min-w-0 flex-1 sm:block">
            <Input
              value={title}
              onChange={(event) => { setTitle(event.target.value); markSaving(); }}
              className="h-10 max-w-[420px] border-transparent bg-transparent px-2 text-[15px] font-extrabold shadow-none hover:bg-[#f5f6f8] focus-visible:bg-white"
              aria-label="가이드 제목"
            />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-1.5 px-2 text-xs font-bold text-[#748096] md:flex" aria-live="polite">
              {saveState === "saving" ? <><LoaderCircle className="size-3.5 animate-spin" />저장 중</> : <><CheckCircle2 className="size-3.5 text-[#2f876b]" />저장됨</>}
            </span>
            <Button variant="outline" className="h-10 rounded-[12px] border-[#dce1ea] px-3 font-extrabold sm:px-4" onClick={onPreview}><Eye className="size-4" /><span className="hidden sm:inline">받는 화면</span></Button>
            <Button className="h-10 rounded-[12px] px-4 font-extrabold shadow-[0_8px_20px_rgba(255,105,78,.2)]" onClick={() => { setPrivacyConfirmed(false); setPublishOpen(true); }}>공개하기<ArrowRight className="size-4" /></Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid min-h-[calc(100vh-68px)] max-w-[1540px] lg:grid-cols-[210px_minmax(0,1fr)_300px] xl:grid-cols-[238px_minmax(0,1fr)_330px]">
        <aside className="border-b border-[#dfe3eb] bg-white lg:border-b-0 lg:border-r" aria-label="가이드 단계">
          <div className="hidden items-center justify-between px-4 pb-3 pt-5 lg:flex"><h2 className="text-sm font-black">단계 <span className="text-[#728097]">{steps.length}</span></h2><Button size="icon-sm" variant="ghost" aria-label="단계 추가" onClick={() => toast.info("새 단계는 영상에서 다시 만들 수 있어요.")}><Plus className="size-4" /></Button></div>
          <div className="scrollbar-none flex gap-2 overflow-x-auto px-3 py-3 lg:block lg:space-y-2 lg:overflow-visible lg:px-3 lg:py-0">
            {steps.map((step, index) => (
              <button
                key={step.id}
                aria-current={index === activeIndex ? "step" : undefined}
                className={`group flex min-w-[188px] items-center gap-3 rounded-[15px] border p-2 text-left transition-all lg:min-w-0 lg:w-full ${index === activeIndex ? "border-[#cfd6ff] bg-[#f3f5ff] shadow-[0_5px_15px_rgba(65,83,155,.08)]" : "border-transparent hover:border-[#e5e8ef] hover:bg-[#fafbfc]"}`}
                onClick={() => setActiveIndex(index)}
              >
                <span className="relative w-11 shrink-0 overflow-hidden rounded-[9px] bg-[#172033] p-1"><GuideScreen step={step} compact showTarget={false} /></span>
                <span className="min-w-0 flex-1">
                  <span className={`text-[11px] font-black ${index === activeIndex ? "text-[#4f6df5]" : "text-[#8992a4]"}`}>{index + 1}단계</span>
                  <span className="mt-0.5 block truncate text-[13px] font-extrabold text-[#303a50]">{step.shortLabel}</span>
                </span>
                {step.privacyCount > 0 && <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#f0ebf8] text-[#74539b]"><LockKeyhole className="size-3" /></span>}
              </button>
            ))}
          </div>
          <div className="mx-4 my-4 hidden rounded-[15px] bg-[#f5f7fa] p-3 lg:block">
            <p className="flex items-center gap-1.5 text-xs font-extrabold text-[#5e6980]"><Sparkles className="size-3.5 text-[#4f6df5]" />AI가 초안을 만들었어요</p>
            <p className="mt-1.5 text-[11px] font-semibold leading-4 text-[#8992a4]">고칠 곳만 확인하면 됩니다.</p>
          </div>
        </aside>

        <section className="min-w-0 bg-[#eef1f6] px-4 py-5 sm:px-6 lg:py-7">
          <div className="mx-auto flex h-full max-w-[800px] flex-col">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-white px-3 py-1.5 text-xs font-extrabold text-[#69748b] shadow-sm">휴대폰 화면 · 세로</span>
                <span className="hidden items-center gap-1.5 rounded-full bg-[#e6f4ee] px-3 py-1.5 text-xs font-extrabold text-[#287a61] sm:flex"><ShieldCheck className="size-3.5" />개인정보 확인 가능</span>
              </div>
              <p className="text-xs font-bold text-[#7c869a]">화면을 눌러 표시 위치를 옮기세요</p>
            </div>

            <div className="relative flex min-h-[540px] flex-1 items-center justify-center overflow-hidden rounded-[26px] bg-[#111827] px-7 py-7 shadow-[inset_0_0_0_1px_rgba(255,255,255,.06)] sm:min-h-[600px]">
              <div className="pointer-events-none absolute inset-0 opacity-20 [background-image:linear-gradient(rgba(255,255,255,.07)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.07)_1px,transparent_1px)] [background-size:32px_32px]" />
              <div className="absolute left-5 top-4 flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-bold text-white/70 backdrop-blur"><MousePointerClick className="size-3.5" />누를 곳</div>
              <div
                className="relative w-[min(68%,282px)] cursor-crosshair rounded-[8%]"
                onPointerDown={moveTarget}
                onKeyDown={moveTargetByKey}
                role="button"
                tabIndex={0}
                aria-label="누를 위치 옮기기. 방향키로 1퍼센트씩 이동"
              >
                <GuideScreen step={activeStep} />
              </div>
              {regenerating && (
                <div className="absolute inset-0 grid place-items-center bg-[#111827]/75 backdrop-blur-sm" aria-live="polite">
                  <div className="flex flex-col items-center text-white"><span className="grid size-14 place-items-center rounded-2xl bg-white/10"><Sparkles className="size-6 animate-pulse text-[#aeb9ff]" /></span><p className="mt-4 text-base font-black">이 단계를 다시 만드는 중</p><p className="mt-1 text-sm font-medium text-white/55">기존 내용은 안전하게 보관돼요</p></div>
                </div>
              )}
            </div>

            <div className="mt-3 flex items-center justify-between rounded-[16px] border border-[#dfe3eb] bg-white p-2 shadow-sm">
              <Button variant="ghost" size="icon" className="rounded-xl" disabled={activeIndex === 0} onClick={() => setActiveIndex(activeIndex - 1)} aria-label="이전 단계"><ChevronLeft className="size-5" /></Button>
              <p className="text-sm font-black tabular-nums"><span className="text-[#4f6df5]">{activeIndex + 1}</span><span className="mx-1 text-[#b2bac8]">/</span>{steps.length}</p>
              <Button variant="ghost" size="icon" className="rounded-xl" disabled={activeIndex === steps.length - 1} onClick={() => setActiveIndex(activeIndex + 1)} aria-label="다음 단계"><ChevronRight className="size-5" /></Button>
            </div>
          </div>
        </section>

        <aside className="border-t border-[#dfe3eb] bg-white lg:border-l lg:border-t-0" aria-label="선택한 단계 편집">
          <div className="border-b border-[#e8ebf1] px-5 py-5">
            <div className="flex items-center justify-between"><div><p className="text-xs font-black text-[#4f6df5]">{activeIndex + 1}단계</p><h2 className="mt-1 text-lg font-black tracking-[-0.03em]">설명 확인</h2></div><span className="grid size-9 place-items-center rounded-xl bg-[#eef1ff] text-[#4f6df5]"><Pencil className="size-4" /></span></div>
            <label className="mt-5 block text-xs font-extrabold text-[#68738b]" htmlFor="step-instruction">받는 사람에게 보일 말</label>
            <Textarea
              id="step-instruction"
              value={activeStep.instruction}
              onChange={(event) => updateActiveStep({ instruction: event.target.value })}
              className="mt-2 min-h-[104px] resize-none rounded-[14px] border-[#dfe3eb] bg-[#fafbfc] p-3 text-base font-bold leading-6 shadow-none"
            />
            <p className="mt-2 text-[11px] font-semibold leading-4 text-[#9098a8]">버튼 이름과 위치를 정확하게 쓰면 더 따라 하기 쉬워요.</p>
          </div>

          <div className="border-b border-[#e8ebf1] px-5 py-5">
            <div className="flex items-center justify-between"><div><p className="flex items-center gap-1.5 text-sm font-black"><LockKeyhole className="size-4 text-[#74539b]" />개인정보 가림</p><p className="mt-1 text-xs font-semibold text-[#8b94a6]">이 단계에서 {activeStep.privacyCount}곳 발견</p></div><span className={`rounded-full px-2.5 py-1 text-[11px] font-black ${activeStep.privacyEnabled ? "bg-[#ece8f5] text-[#6c4b91]" : "bg-[#fff0ed] text-[#bc503c]"}`}>{activeStep.privacyEnabled ? "적용 중" : "가림 해제"}</span></div>
            {activeStep.privacyCount > 0 ? (
              <div className="mt-4 flex items-center justify-between rounded-[14px] border border-[#e5e0ee] bg-[#faf8fd] p-3.5">
                <div><p className="text-[13px] font-extrabold text-[#423651]">계좌 정보 가리기</p><p className="mt-0.5 text-[11px] font-semibold text-[#897b99]">게시 이미지에 영구 적용</p></div>
                <Switch checked={activeStep.privacyEnabled} onCheckedChange={(checked) => updateActiveStep({ privacyEnabled: checked }, true)} aria-label="계좌 정보 가리기" className="data-[state=checked]:bg-[#76549d]" />
              </div>
            ) : (
              <div className="mt-4 flex items-center gap-2.5 rounded-[14px] bg-[#f5f7fa] p-3.5 text-xs font-semibold text-[#768197]"><BadgeCheck className="size-4 text-[#2b8568]" />개인정보로 보이는 내용이 없어요.</div>
            )}
            <Button variant="outline" className="mt-3 h-10 w-full rounded-[12px] border-dashed border-[#cfc5dc] font-extrabold text-[#6f538e]" onClick={() => updateActiveStep({ privacyCount: activeStep.privacyCount + 1, privacyEnabled: true }, true)}><Plus className="size-4" />가림 영역 추가</Button>
          </div>

          <div className="space-y-2 px-5 py-5">
            <Button variant="outline" className="h-11 w-full justify-start rounded-[12px] border-[#dfe3eb] font-extrabold" onClick={regenerate} disabled={regenerating}><RefreshCcw className="size-4 text-[#4f6df5]" />이 단계 다시 만들기</Button>
            <Button variant="ghost" className="h-11 w-full justify-start rounded-[12px] font-extrabold text-[#626d82]" onClick={mergeStep} disabled={activeIndex === 0}><GitMerge className="size-4" />이전 단계와 합치기</Button>
            <Button variant="ghost" className="h-11 w-full justify-start rounded-[12px] font-extrabold text-[#b64444] hover:bg-[#fff1f1] hover:text-[#a73838]" onClick={removeStep} disabled={steps.length <= 1}><Trash2 className="size-4" />이 단계 삭제</Button>
          </div>
        </aside>
      </div>

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent className="max-w-[540px] gap-0 overflow-hidden rounded-[24px] border-0 p-0 shadow-[0_30px_100px_rgba(11,18,34,.25)]">
          <div className="bg-[#172033] px-6 pb-6 pt-7 text-white sm:px-7">
            <span className="mb-4 grid size-11 place-items-center rounded-[15px] bg-white/10 text-[#c7d0ff]"><ShieldCheck className="size-5" /></span>
            <DialogHeader>
              <DialogTitle className="text-[24px] font-black tracking-[-0.04em] text-white">공개 전, 개인정보만 확인해 주세요</DialogTitle>
              <DialogDescription className="mt-1 text-[14px] font-medium leading-6 text-white/60">받는 사람은 링크만 열면 바로 이 가이드를 볼 수 있어요.</DialogDescription>
            </DialogHeader>
          </div>
          <div className="space-y-4 px-6 py-6 sm:px-7">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-[15px] border border-[#e1d9ea] bg-[#faf8fd] p-4"><p className="text-xs font-extrabold text-[#7b678e]">개인정보 가림</p><p className="mt-1 text-xl font-black text-[#49385d]">{enabledMasks}곳 적용</p></div>
              <div className={`rounded-[15px] border p-4 ${disabledMasks ? "border-[#f1cfca] bg-[#fff7f5]" : "border-[#dce8e2] bg-[#f5fbf8]"}`}><p className={`text-xs font-extrabold ${disabledMasks ? "text-[#a45f52]" : "text-[#54806f]"}`}>가림 해제</p><p className={`mt-1 text-xl font-black ${disabledMasks ? "text-[#8f4338]" : "text-[#356b57]"}`}>{disabledMasks}곳</p></div>
            </div>

            {disabledMasks > 0 && <div className="flex gap-3 rounded-[15px] border border-[#f1cec7] bg-[#fff7f5] p-4 text-sm font-semibold leading-5 text-[#84483e]"><CircleAlert className="mt-0.5 size-4 shrink-0" /><p>가림을 해제한 정보가 있어요. 공개 화면에 보여도 되는지 다시 확인하세요.</p></div>}

            <div className="flex items-center justify-between rounded-[15px] border border-[#e1e5ed] p-4">
              <div className="pr-4"><p className="text-sm font-extrabold">원본 영상 함께 공유</p><p className="mt-1 text-xs font-semibold leading-5 text-[#838da0]">기본값은 공유하지 않음이에요.</p></div>
              <Switch checked={shareOriginal} onCheckedChange={setShareOriginal} aria-label="원본 영상 함께 공유" />
            </div>
            {shareOriginal && <div className="flex gap-3 rounded-[15px] bg-[#fff5e9] p-4 text-xs font-semibold leading-5 text-[#8b6236]"><CircleAlert className="mt-0.5 size-4 shrink-0" />원본 영상에는 가리지 않은 개인정보가 남아 있을 수 있어요.</div>}

            <label className="flex cursor-pointer items-start gap-3 rounded-[15px] bg-[#f5f7fa] p-4">
              <Checkbox checked={privacyConfirmed} onCheckedChange={(checked) => setPrivacyConfirmed(checked === true)} className="mt-0.5 size-5" />
              <span className="text-sm font-extrabold leading-5 text-[#39445b]">공개될 화면을 직접 확인했고, 개인정보 가림 상태가 맞습니다.</span>
            </label>
          </div>
          <DialogFooter className="border-t border-[#e8ebf1] px-6 py-4 sm:px-7">
            <Button variant="ghost" className="h-11 rounded-[13px] px-5 font-extrabold" onClick={() => setPublishOpen(false)}>취소</Button>
            <Button
              className="h-11 rounded-[13px] px-6 font-extrabold"
              disabled={!privacyConfirmed}
              onClick={() => { setPublishOpen(false); onPublished(); }}
            >
              안전하게 공개하기
              <ArrowRight className="size-4" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function PublishedScreen({ title, onOpenGuide, onBackToEdit }: { title: string; onOpenGuide: () => void; onBackToEdit: () => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const publicPath = "/g/mobile-bank-7k2m";

  useEffect(() => setBaseUrl(window.location.origin), []);

  const publicLink = `${baseUrl}${publicPath}`;
  const editLink = `${baseUrl}/?edit=sk_live_x7m2p9`;
  const copyLink = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(message);
    } catch {
      toast.info("주소창의 링크를 직접 복사해 주세요.");
    }
  };

  const share = async () => {
    if (navigator.share) {
      try { await navigator.share({ title, text: "이 순서대로 따라 해보세요.", url: publicLink }); } catch { /* user closed the share sheet */ }
    } else copyLink(publicLink, "받는 사람용 링크를 복사했어요.");
  };

  return (
    <main className="min-h-screen bg-[#f7f8fc] px-5 pb-16 text-[#172033]">
      <header className="mx-auto flex h-[76px] max-w-[960px] items-center justify-between"><Logo /><Button variant="ghost" className="rounded-xl font-extrabold text-[#637087]" onClick={onBackToEdit}><Pencil className="size-4" />다시 편집</Button></header>
      <section className="mx-auto max-w-[760px] pt-8 sm:pt-14">
        <div className="text-center">
          <div className="relative mx-auto grid size-20 place-items-center rounded-full bg-[#e7f6ef] text-[#247a5f]"><Check className="size-9" strokeWidth={3} /><span className="absolute -right-1 top-0 grid size-7 place-items-center rounded-[10px] bg-[#fff0ed] text-primary"><Sparkles className="size-3.5" /></span></div>
          <p className="mt-5 text-sm font-black text-[#278066]">가이드 공개 완료</p>
          <h1 className="mt-2 text-[clamp(2rem,6vw,3.15rem)] font-black tracking-[-0.055em]">이제 링크만 보내세요</h1>
          <p className="mt-3 text-[17px] font-medium text-muted-foreground">받는 사람은 설치나 로그인 없이 바로 볼 수 있어요.</p>
        </div>

        <div className="mt-9 rounded-[26px] border border-[#dfe3eb] bg-white p-4 shadow-[0_24px_70px_rgba(20,32,61,.09)] sm:p-6">
          <div className="flex items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-[15px] bg-[#eef1ff] text-[#4f6df5]"><Link2 className="size-5" /></span>
            <div className="min-w-0 flex-1"><p className="text-sm font-black">받는 사람에게 보낼 링크</p><p className="mt-1 text-xs font-semibold text-[#8a93a4]">카카오톡 대화창에 붙여 넣으세요.</p></div>
          </div>
          <div className="mt-5 flex gap-2 rounded-[15px] border border-[#dfe3eb] bg-[#f8f9fb] p-2 pl-4">
            <input className="min-w-0 flex-1 bg-transparent text-sm font-bold text-[#536078] outline-none" value={publicLink || publicPath} readOnly aria-label="받는 사람용 링크" />
            <Button variant="outline" className="h-10 rounded-[11px] border-[#dce1ea] bg-white px-3 font-extrabold" onClick={() => copyLink(publicLink, "받는 사람용 링크를 복사했어요.")}><Copy className="size-4" /><span className="hidden sm:inline">복사</span></Button>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Button size="lg" className="h-13 rounded-[15px] text-base font-extrabold shadow-[0_10px_24px_rgba(255,105,78,.22)]" onClick={share}><Share2 className="size-5" />공유하기</Button>
            <Button size="lg" variant="outline" className="h-13 rounded-[15px] border-[#dce1ea] text-base font-extrabold" onClick={onOpenGuide}><Eye className="size-5" />받는 화면 열기</Button>
          </div>
        </div>

        <div className="mt-4 rounded-[22px] border border-[#e7e2ef] bg-[#fcfaff] p-5">
          <div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[#eee9f5] text-[#725295]"><LockKeyhole className="size-4" /></span><div><p className="text-sm font-black text-[#4a3b5a]">내 편집 링크</p><p className="mt-1 text-xs font-semibold leading-5 text-[#847690]">이 링크가 있으면 다시 편집할 수 있어요. 다른 사람에게 보내지 마세요.</p></div></div>
          <div className="mt-4 flex items-center gap-2 rounded-[13px] bg-white p-2 pl-3"><p className="min-w-0 flex-1 truncate text-xs font-bold text-[#756a80]">{editLink || "/?edit=sk_live_x7m2p9"}</p><Button variant="ghost" size="icon-sm" onClick={() => copyLink(editLink, "내 편집 링크를 복사했어요.")} aria-label="내 편집 링크 복사"><Copy className="size-3.5" /></Button></div>
        </div>
      </section>
    </main>
  );
}

export default function Home() {
  const [mode, setMode] = useState<AppMode>("upload");
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState("screen-recording.mp4");
  const [title, setTitle] = useState(GUIDE_TITLE);
  const [steps, setSteps] = useState<GuideStep[]>(INITIAL_GUIDE_STEPS);
  const [activeIndex, setActiveIndex] = useState(0);
  const previousMode = useRef<AppMode>("review");
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  useEffect(() => {
    if (mode !== "processing") return;
    const milestones = [
      { after: 350, value: 18 },
      { after: 900, value: 37 },
      { after: 1550, value: 58 },
      { after: 2300, value: 76 },
      { after: 3000, value: 91 },
      { after: 3650, value: 100 },
    ];
    const timers = milestones.map(({ after, value }) => setTimeout(() => setProgress(value), after));
    const finish = setTimeout(() => { setMode("review"); toast.success("가이드 초안이 완성됐어요."); }, 4250);
    return () => { timers.forEach(clearTimeout); clearTimeout(finish); };
  }, [mode]);

  useEffect(() => {
    type ToolDefinition = {
      name: string;
      title: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute: (input: unknown) => unknown;
    };
    const context = (document as Document & {
      modelContext?: {
        registerTool: (tool: ToolDefinition, options?: { signal?: AbortSignal }) => void | Promise<void>;
      };
    }).modelContext;
    if (!context?.registerTool) return;

    const lifecycle = new AbortController();
    const reportError = () => undefined;

    try {
      void Promise.resolve(context.registerTool({
        name: "start_sample_guide_creation",
        title: "예시 가이드 만들기",
        description: "예시 화면 녹화로 ShowMe 가이드 생성 흐름을 시작합니다.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input as object).length > 0) {
            throw new Error("입력은 빈 객체여야 합니다.");
          }
          setFileName("showme-example.mp4");
          setProgress(4);
          setMode("processing");
          return { status: "processing", fileName: "showme-example.mp4" };
        },
      }, { signal: lifecycle.signal })).catch(reportError);

      void Promise.resolve(context.registerTool({
        name: "open_review_step",
        title: "검토 단계 열기",
        description: "ShowMe 검토 화면에서 지정한 단계를 엽니다.",
        inputSchema: {
          type: "object",
          properties: { step: { type: "integer", minimum: 1, maximum: INITIAL_GUIDE_STEPS.length } },
          required: ["step"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          const step = (input as { step?: unknown } | null)?.step;
          const currentStepCount = stepsRef.current.length;
          if (!Number.isInteger(step) || Number(step) < 1 || Number(step) > currentStepCount) {
            throw new Error(`step은 1부터 ${currentStepCount} 사이의 정수여야 합니다.`);
          }
          setActiveIndex(Number(step) - 1);
          setMode("review");
          return { status: "review", activeStep: Number(step) };
        },
      }, { signal: lifecycle.signal })).catch(reportError);
    } catch {
      reportError();
    }

    return () => lifecycle.abort();
  }, []);

  const start = (name: string) => {
    setFileName(name);
    setProgress(4);
    setMode("processing");
  };

  const publishGuide = () => {
    try {
      window.localStorage.setItem("showme:published-guide", JSON.stringify({ title: title.trim() || GUIDE_TITLE, steps }));
    } catch {
      // The in-app preview still works when browser storage is unavailable.
    }
    setMode("published");
  };

  const previewTitle = useMemo(() => title.trim() || GUIDE_TITLE, [title]);

  if (mode === "viewer") {
    return <PublicGuide title={previewTitle} steps={steps} onExit={() => setMode(previousMode.current)} />;
  }

  return (
    <>
      {mode === "upload" && <UploadScreen onStart={start} />}
      {mode === "processing" && <ProcessingScreen progress={progress} fileName={fileName} onCancel={() => setMode("upload")} />}
      {mode === "review" && (
        <ReviewScreen
          title={title}
          setTitle={setTitle}
          steps={steps}
          setSteps={setSteps}
          activeIndex={activeIndex}
          setActiveIndex={setActiveIndex}
          onPreview={() => { previousMode.current = "review"; setMode("viewer"); }}
          onPublished={publishGuide}
        />
      )}
      {mode === "published" && (
        <PublishedScreen
          title={previewTitle}
          onOpenGuide={() => { previousMode.current = "published"; setMode("viewer"); }}
          onBackToEdit={() => setMode("review")}
        />
      )}
      <Toaster position="top-center" richColors closeButton />
    </>
  );
}
