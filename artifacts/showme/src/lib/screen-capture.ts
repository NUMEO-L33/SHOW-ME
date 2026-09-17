export type CaptureState = "idle" | "requesting" | "recording" | "stopping";
export const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
export const MAX_CAPTURE_MS = 4 * 60_000;
const FINISH_TIMEOUT_MS = 3_000;

/** Owns exactly one consented stream. Has no network, storage or download API. */
export class ScreenCapture {
  private phase: CaptureState = "idle";
  private generation = 0;
  private disposed = false;
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private bytes = 0;
  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private endedListeners: Array<() => void> = [];

  constructor(private readonly options: {
    getStream: () => Promise<MediaStream>;
    makeRecorder: (stream: MediaStream) => MediaRecorder;
    onState: (state: CaptureState) => void;
    onElapsed: (milliseconds: number) => void;
    onRecorded: (file: File) => void;
    onError: (message: string) => void;
  }) {}

  private state(phase: CaptureState) {
    this.phase = phase;
    if (!this.disposed) this.options.onState(phase);
  }

  private stopTracks(stream: MediaStream | null) {
    for (const track of stream?.getTracks() ?? []) { try { track.stop(); } catch { /* attempt every track */ } }
  }

  private clearTimers() {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.finishTimer !== null) clearTimeout(this.finishTimer);
    this.timer = null; this.finishTimer = null;
  }

  private clear() {
    this.clearTimers();
    for (const remove of this.endedListeners) remove();
    this.endedListeners = [];
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder) {
      recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null;
      try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* release tracks below */ }
    }
    this.stopTracks(this.stream);
    this.stream = null;
    this.chunks = []; this.bytes = 0;
  }

  /** Discard/pagehide/unmount never deliver a file after a late prompt/stop event. */
  cancel() { this.generation++; this.clear(); this.state("idle"); }
  dispose() { this.disposed = true; this.cancel(); }
  private fail(message: string) { this.cancel(); if (!this.disposed) this.options.onError(message); }

  async start() {
    if (this.disposed || this.phase !== "idle") return;
    const generation = ++this.generation;
    this.state("requesting");
    this.options.onElapsed(0);
    try {
      const stream = await this.options.getStream();
      if (this.disposed || generation !== this.generation) { this.stopTracks(stream); return; }
      this.stream = stream;
      if (stream.getAudioTracks().length || !stream.getVideoTracks().length) {
        this.fail("소리 없는 화면 녹화만 허용해요. 화면 공유를 중단했습니다."); return;
      }
      const recorder = this.options.makeRecorder(stream);
      this.recorder = recorder;
      const current = () => !this.disposed && generation === this.generation && this.recorder === recorder;
      recorder.ondataavailable = event => {
        if (!current() || !event.data.size) return;
        this.bytes += event.data.size;
        if (this.bytes > MAX_CAPTURE_BYTES) {
          this.fail("64MB 안전 한도를 넘어 녹화를 중단하고 임시 영상을 버렸어요. 더 짧게 녹화해 주세요."); return;
        }
        this.chunks.push(event.data);
        if (Date.now() - this.startedAt >= MAX_CAPTURE_MS) this.stop();
      };
      recorder.onerror = () => { if (current()) this.fail("녹화 오류로 화면 공유를 중단하고 임시 영상을 버렸어요."); };
      recorder.onstop = () => {
        if (!current()) return;
        this.stopTracks(this.stream);
        const type = recorder.mimeType || "video/webm";
        let file: File | null = null;
        try {
          if (this.bytes) file = new File(this.chunks, `showme-recording-${new Date().toISOString().replace(/[:.]/g, "-")}.${type.includes("mp4") ? "mp4" : "webm"}`, { type: type.split(";", 1)[0] });
        } catch { /* clear references before reporting conversion failure */ }
        this.cancel();
        if (file) this.options.onRecorded(file);
        else this.options.onError("녹화 파일을 만들지 못했어요. 화면 공유는 중단했고 임시 데이터는 버렸습니다.");
      };
      for (const track of stream.getVideoTracks()) {
        const ended = () => { if (current()) this.stop(); };
        track.addEventListener("ended", ended, { once: true });
        this.endedListeners.push(() => track.removeEventListener("ended", ended));
      }
      this.startedAt = Date.now();
      recorder.start(1_000);
      if (!current()) return;
      this.state("recording");
      this.timer = setInterval(() => this.checkElapsed(), 250);
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.fail(error instanceof DOMException && error.name === "NotAllowedError"
        ? "화면 선택이 취소됐어요. 준비되면 다시 녹화를 눌러 주세요."
        : "화면 녹화를 시작하지 못했어요. 캡처와 임시 데이터를 정리했습니다.");
    }
  }

  checkElapsed() {
    if (this.phase !== "recording" || this.disposed) return;
    const elapsed = Date.now() - this.startedAt;
    this.options.onElapsed(elapsed);
    if (elapsed >= MAX_CAPTURE_MS) this.stop();
  }

  stop() {
    if (this.disposed || this.phase === "idle" || this.phase === "stopping") return;
    if (this.phase === "requesting") { this.cancel(); return; }
    const recorder = this.recorder;
    this.state("stopping");
    this.clearTimers();
    this.finishTimer = setTimeout(() => this.fail("녹화 종료 응답이 늦어 임시 영상을 버렸어요. 화면 공유는 이미 중단했습니다."), FINISH_TIMEOUT_MS);
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch {
      this.fail("녹화를 완료하지 못해 임시 영상을 버렸어요. 화면 공유는 중단했습니다.");
    } finally {
      // Do not wait for asynchronous onstop to release the actual capture.
      this.stopTracks(this.stream);
      this.stream = null;
    }
  }
}
