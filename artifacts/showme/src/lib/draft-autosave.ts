import { draftFailure, type DraftSnapshot, type EditorDocument } from "./draft-client.js";

export const DRAFT_AUTOSAVE_DELAY_MS = 1_000;
export type DraftAutosaveStatus = { saving: boolean; error: string | null };
type Write = { base: DraftSnapshot; document: EditorDocument };

/** One writer per open guide. A failed write must be reconciled before newer edits. */
export class DraftAutosave {
  private base: DraftSnapshot;
  private document: EditorDocument | null = null;
  private signature: string | null = null;
  private validation: string | null = null;
  private error: string | null = null;
  private pausedByFailure = false;
  private failedWrite: Write | null = null;
  private request: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private changedAt = 0;
  private suspended = false;
  private disposed = false;

  constructor(private readonly options: {
    initial: DraftSnapshot;
    write: (base: DraftSnapshot, document: EditorDocument, signal: AbortSignal) => Promise<DraftSnapshot>;
    onSaved: (snapshot: DraftSnapshot) => void;
    onStatus: (status: DraftAutosaveStatus) => void;
  }) {
    this.base = structuredClone(options.initial);
  }

  update(document: EditorDocument | null, validation: string | null = null): void {
    if (this.disposed) return;
    const signature = document ? JSON.stringify(document) : null;
    if (signature === this.signature && validation === this.validation) return;
    this.document = document ? structuredClone(document) : null;
    this.signature = signature;
    this.validation = validation;
    this.changedAt = Date.now();
    this.clearTimer();
    // Editing after a network/access/conflict failure is not permission to retry.
    if (!this.pausedByFailure) this.error = null;
    this.publish();
    this.schedule();
  }

  suspend(value: boolean): void {
    if (this.disposed || this.suspended === value) return;
    this.suspended = value;
    this.clearTimer();
    if (!value) {
      this.changedAt = Date.now();
      this.schedule();
    }
  }

  /** Explicit retry replays the exact uncertain request before saving newer input. */
  retry(): void {
    if (this.disposed || this.request || this.suspended) return;
    this.clearTimer();
    this.error = null;
    this.pausedByFailure = false;
    void this.save();
  }

  get saving(): boolean { return this.request !== null; }

  pause(error: unknown): void {
    this.clearTimer();
    this.pausedByFailure = true;
    this.error = draftFailure(error);
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.request?.abort();
  }

  private dirty(): boolean {
    return !this.base.persisted || this.signature !== JSON.stringify(this.base.document);
  }

  private publish(): void {
    if (!this.disposed) this.options.onStatus({ saving: Boolean(this.request), error: this.error });
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.disposed || this.suspended || this.request || this.error || this.failedWrite || !this.dirty()) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, Math.max(0, DRAFT_AUTOSAVE_DELAY_MS - (Date.now() - this.changedAt)));
  }

  private async save(): Promise<void> {
    if (this.disposed || this.suspended || this.request) return;
    const write = this.failedWrite ?? (this.document && this.dirty()
      ? { base: this.base, document: this.document } : null);
    if (!write) {
      this.error = this.validation;
      this.publish();
      return;
    }
    const abort = new AbortController();
    this.request = abort;
    this.publish();
    try {
      const saved = await this.options.write(write.base, write.document, abort.signal);
      if (this.disposed || abort.signal.aborted) return;
      this.base = structuredClone(saved);
      this.failedWrite = null;
      this.pausedByFailure = false;
      this.error = null;
      // Only advance the acknowledged base; never replace the user's live input.
      this.options.onSaved(saved);
    } catch (error) {
      if (this.disposed || abort.signal.aborted) return;
      this.failedWrite = write;
      this.pausedByFailure = true;
      this.error = draftFailure(error);
    } finally {
      if (this.request === abort) this.request = null;
      this.publish();
      this.schedule();
    }
  }
}
