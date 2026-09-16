"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CircleStop, LoaderCircle, MonitorUp, Radio } from "lucide-react";

// MediaRecorder exposes chunks as in-memory Blobs. Keep direct capture small
// enough for ordinary desktop tabs; longer recordings can use the 500 MiB
// file-upload path without risking a tab OOM.
const MAX_RECORDING_BYTES = 64 * 1024 * 1024;
const MAX_RECORDING_MS = 4 * 60_000;

type RecordingState = "idle" | "requesting" | "recording" | "stopping";

const subscribeToCapability = () => () => undefined;
const serverCapabilitySnapshot = () => false;
const browserCapabilitySnapshot = () =>
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
  typeof MediaRecorder !== "undefined";

function preferredMimeType(): string | undefined {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function recordingExtension(mimeType: string): "webm" | "mp4" {
  return mimeType.toLowerCase().includes("mp4") ? "mp4" : "webm";
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function ScreenRecorder({
  disabled = false,
  onRecorded,
  onError,
}: {
  disabled?: boolean;
  onRecorded: (file: File) => void;
  onError: (message: string) => void;
}) {
  const supported = useSyncExternalStore(
    subscribeToCapability,
    browserCapabilitySnapshot,
    serverCapabilitySnapshot,
  );
  const [state, setState] = useState<RecordingState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const rejectReasonRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const visibilityCleanupRef = useRef<(() => void) | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const releaseStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }, []);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    if (mountedRef.current) setState("stopping");
    clearTimer();
    recorder.stop();
  }, [clearTimer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      visibilityCleanupRef.current?.();
      visibilityCleanupRef.current = null;
      clearTimer();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.stop();
      }
      releaseStream();
    };
  }, [clearTimer, releaseStream]);

  const startRecording = async () => {
    if (disabled || state !== "idle" || !supported) return;
    setState("requesting");
    rejectReasonRef.current = null;
    chunksRef.current = [];
    bytesRef.current = 0;
    setElapsedMs(0);
    const generation = generationRef.current + 1;
    generationRef.current = generation;

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        // The current pipeline analyzes screen pixels only. Do not collect
        // unrelated calls, notifications, or room audio.
        audio: false,
      });
      if (!mountedRef.current || generationRef.current !== generation) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      const mimeType = preferredMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_800_000 })
        : new MediaRecorder(stream, { videoBitsPerSecond: 1_800_000 });
      recorderRef.current = recorder;

      const stopThisRecording = () => {
        if (
          generationRef.current !== generation ||
          recorderRef.current !== recorder ||
          recorder.state === "inactive"
        ) return;
        if (mountedRef.current) setState("stopping");
        clearTimer();
        recorder.stop();
      };

      recorder.ondataavailable = (event) => {
        if (generationRef.current !== generation) return;
        if (event.data.size === 0) return;
        chunksRef.current.push(event.data);
        bytesRef.current += event.data.size;
        if (bytesRef.current > MAX_RECORDING_BYTES) {
          rejectReasonRef.current = "브라우저 안전 한도인 64MB를 넘어 중단했어요. 더 짧게 녹화하거나 영상 파일을 올려 주세요.";
          stopThisRecording();
          return;
        }
        if (Date.now() - startedAtRef.current >= MAX_RECORDING_MS) stopThisRecording();
      };
      recorder.onstop = async () => {
        clearTimer();
        visibilityCleanupRef.current?.();
        visibilityCleanupRef.current = null;
        releaseStream();
        recorderRef.current = null;
        if (!mountedRef.current || generationRef.current !== generation) return;
        setState("idle");

        const rejection = rejectReasonRef.current;
        rejectReasonRef.current = null;
        if (rejection) {
          chunksRef.current = [];
          onError(rejection);
          return;
        }

        const outputType = recorder.mimeType || mimeType || "video/webm";
        const blob = new Blob(chunksRef.current, { type: outputType });
        chunksRef.current = [];
        if (blob.size === 0) {
          onError("녹화된 영상이 비어 있어요. 공유할 화면을 다시 선택해 주세요.");
          return;
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        onRecorded(
          new File([blob], `showme-recording-${timestamp}.${recordingExtension(outputType)}`, {
            type: outputType.split(";", 1)[0],
            lastModified: Date.now(),
          }),
        );
      };
      recorder.onerror = () => {
        rejectReasonRef.current = "브라우저에서 화면 녹화를 완료하지 못했어요. 영상 파일 업로드를 이용해 주세요.";
        stopThisRecording();
      };
      for (const track of stream.getVideoTracks()) {
        track.addEventListener("ended", stopThisRecording, { once: true });
      }

      startedAtRef.current = Date.now();
      recorder.start(1_000);
      setState("recording");
      const checkAfterVisibilityChange = () => {
        if (
          document.visibilityState === "visible" &&
          Date.now() - startedAtRef.current >= MAX_RECORDING_MS
        ) stopThisRecording();
      };
      document.addEventListener("visibilitychange", checkAfterVisibilityChange);
      visibilityCleanupRef.current = () => {
        document.removeEventListener("visibilitychange", checkAfterVisibilityChange);
      };
      timerRef.current = window.setInterval(() => {
        const nextElapsed = Date.now() - startedAtRef.current;
        setElapsedMs(nextElapsed);
        if (nextElapsed >= MAX_RECORDING_MS) stopThisRecording();
      }, 250);
    } catch (error) {
      if (!mountedRef.current || generationRef.current !== generation) return;
      releaseStream();
      recorderRef.current = null;
      setState("idle");
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        onError("화면 선택이 취소됐어요. 준비되면 다시 녹화를 눌러 주세요.");
      } else {
        onError("이 브라우저에서는 화면 녹화를 시작하지 못했어요. 영상 파일 업로드를 이용해 주세요.");
      }
    }
  };

  if (!supported) {
    return (
      <p className="text-center text-xs font-semibold text-muted-foreground">
        이 브라우저는 직접 화면 녹화를 지원하지 않아요. 위에서 녹화 파일을 선택해 주세요.
      </p>
    );
  }

  const recording = state === "recording" || state === "stopping";
  return (
    <div className="flex flex-col items-center justify-between gap-3 rounded-2xl border border-[#e2e6f0] bg-white px-4 py-3 sm:flex-row">
      <div className="flex min-w-0 items-center gap-3 text-left">
        <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${recording ? "bg-red-50 text-red-600" : "bg-[#eef1ff] text-[#4f6df5]"}`}>
          {recording ? <Radio className="size-5 animate-pulse" /> : <MonitorUp className="size-5" />}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-extrabold text-[#25304a]">
            {recording ? `녹화 중 ${formatElapsed(elapsedMs)}` : "지금 화면을 바로 녹화하기"}
          </p>
          <p className="mt-0.5 text-xs font-medium text-muted-foreground">
            {recording ? "공유 중인 창에서 작업한 뒤 녹화를 끝내세요." : "창·탭·전체 화면 · 직접 녹화는 최대 4분"}
          </p>
        </div>
      </div>
      <button
        type="button"
        disabled={disabled || state === "requesting" || state === "stopping"}
        onClick={recording ? stopRecording : startRecording}
        className={`inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl px-4 text-sm font-extrabold transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${recording ? "bg-red-600 text-white hover:bg-red-700" : "bg-[#172033] text-white hover:bg-[#25304a]"}`}
      >
        {state === "requesting" || state === "stopping" ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : recording ? (
          <CircleStop className="size-4" />
        ) : (
          <VideoIcon />
        )}
        {state === "requesting" ? "화면 선택 중" : state === "stopping" ? "영상 만드는 중" : recording ? "녹화 끝내기" : "화면 녹화"}
      </button>
    </div>
  );
}

function VideoIcon() {
  return <span className="size-2.5 rounded-full bg-red-400" aria-hidden="true" />;
}
