import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CircleStop, LoaderCircle, MonitorUp, Radio } from "lucide-react";
import { ScreenCapture, type CaptureState } from "@/lib/screen-capture";

const subscribe = () => () => undefined;
const supported = () => typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function" && typeof MediaRecorder !== "undefined";
const unavailable = () => false;

export function ScreenRecorder({ disabled = false, onRecorded, onError }: {
  disabled?: boolean; onRecorded: (file: File) => void; onError: (message: string) => void;
}) {
  const canRecord = useSyncExternalStore(subscribe, supported, unavailable);
  const [state, setState] = useState<CaptureState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const session = useRef<ScreenCapture | null>(null);
  const callbacks = useRef({ onRecorded, onError });
  callbacks.current = { onRecorded, onError };
  useEffect(() => {
    const capture = new ScreenCapture({
      getStream: () => navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 } }, audio: false }),
      makeRecorder: stream => {
        const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find(type => MediaRecorder.isTypeSupported(type));
        return new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 1_800_000 });
      },
      onState: setState, onElapsed: setElapsedMs,
      onRecorded: file => callbacks.current.onRecorded(file), onError: message => callbacks.current.onError(message),
    });
    session.current = capture;
    const pagehide = () => capture.cancel();
    const visibility = () => capture.checkElapsed();
    window.addEventListener("pagehide", pagehide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("pagehide", pagehide);
      document.removeEventListener("visibilitychange", visibility);
      capture.dispose();
      if (session.current === capture) session.current = null;
    };
  }, []);
  if (!canRecord) return <p className="text-center text-xs font-semibold text-muted-foreground">이 브라우저는 직접 화면 녹화를 지원하지 않아요. 위에서 녹화 파일을 선택해 주세요.</p>;
  const recording = state === "recording" || state === "stopping";
  const seconds = Math.floor(elapsedMs / 1_000);
  const elapsed = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return <div className="flex flex-col items-center justify-between gap-3 rounded-2xl border border-[#e2e6f0] bg-white px-4 py-3 sm:flex-row">
    <div className="flex min-w-0 items-center gap-3 text-left">
      <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${recording ? "bg-red-50 text-red-600" : "bg-[#eef1ff] text-[#4f6df5]"}`}>
        {recording ? <Radio className="size-5 animate-pulse" /> : <MonitorUp className="size-5" />}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-extrabold text-[#25304a]">{state === "stopping" ? "캡처 중단 · 파일 정리 중" : recording ? `녹화 중 ${elapsed}` : "지금 화면을 바로 녹화하기"}</p>
        <p className="mt-0.5 text-xs font-medium text-muted-foreground">{recording ? "녹화 완료만으로는 서버에 전송하지 않아요." : "창·탭·전체 화면 · 소리 없이 최대 4분"}</p>
      </div>
    </div>
    <div className="flex gap-2">
      {state !== "idle" && <button type="button" className="h-10 px-2 text-sm font-bold text-[#626d82]" onClick={() => session.current?.cancel()}>녹화 취소·버리기</button>}
      <button type="button" disabled={(disabled && !recording) || state === "requesting" || state === "stopping"}
        onClick={() => recording ? session.current?.stop() : void session.current?.start()}
        className={`inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl px-4 text-sm font-extrabold transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${recording ? "bg-red-600 text-white hover:bg-red-700" : "bg-[#172033] text-white hover:bg-[#25304a]"}`}>
        {state === "requesting" || state === "stopping" ? <LoaderCircle className="size-4 animate-spin" /> : recording ? <CircleStop className="size-4" /> : <span className="size-2.5 rounded-full bg-red-400" aria-hidden="true" />}
        {state === "requesting" ? "화면 선택 중" : state === "stopping" ? "영상 만드는 중" : recording ? "녹화 끝내기" : "화면 녹화"}
      </button>
    </div>
  </div>;
}
