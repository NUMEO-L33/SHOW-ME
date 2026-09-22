import type { DraftIdentity, DraftSnapshot } from "./draft-client.js";
import type { PrivacyReview } from "./privacy-review.js";
import { getPublicationStatus, publishGuide, unpublishGuide, publicationFailure, type PublicationStatus } from "./publication-client.js";

type Journal = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type PublicationView = { status: PublicationStatus | null; busy: boolean; error: string; unresolved: boolean };
export function canPublishSnapshot(base: DraftSnapshot | undefined, review: PrivacyReview | null, blocked: boolean) {
  return !blocked && Boolean(base?.persisted && base.revision > 0 && review?.complete && review.titleConfirmed &&
    review.steps.length === base.document.steps.length && new Set(review.steps.map(s => s.stepId)).size === review.steps.length && review.steps.every(s => s.imageConfirmed && s.textConfirmed &&
      base.document.steps.some(d => d.id === s.stepId && d.activeFrameStepId === s.frameStepId) &&
      s.candidates.every(c => c.status !== "pending")) && review.guideId === base.guideId &&
    review.revision === base.revision && review.inputFingerprint === base.inputFingerprint);
}

/** Explicit mutations only; uncertainty survives reload as an ID, never as an automatic retry. */
export class PublicationSession {
  private controller: AbortController | null = null;
  private disposed = false;
  private pending: string | undefined;
  private journalFailed = false;
  private listeners = new Set<(state: PublicationView) => void>();
  private key: string;
  state: PublicationView = { status: null, busy: false, error: "", unresolved: false };
  constructor(private identity: DraftIdentity, private journal: Journal) {
    this.identity = { ...identity };
    this.key = `showme:publication-request:${identity.guideId}`;
    try {
      const value = journal.getItem(this.key);
      if (value !== null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new Error();
      this.pending = value ?? undefined;
      this.state.unresolved = Boolean(this.pending);
    } catch {
      this.journalFailed = true;
      this.state.error = "이 브라우저에서 게시 요청 기록을 확인할 수 없어요. 새 게시를 막았습니다. 기존 공유 상태 조회·중지는 가능합니다.";
    }
  }
  subscribe(listener: (state: PublicationView) => void) {
    this.listeners.add(listener); listener(this.state);
    return () => { this.listeners.delete(listener); };
  }
  private emit(update: Partial<PublicationView>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...update }; for (const listener of this.listeners) listener(this.state);
  }
  private accept(status: PublicationStatus) {
    if (this.disposed) return;
    if (this.pending && status.job?.publicationId === this.pending) {
      if (!["queued", "running"].includes(status.job.status)) {
        try { if (this.journal.getItem(this.key) === this.pending) this.journal.removeItem(this.key); }
        catch { this.journalFailed = true; }
        this.pending = undefined;
      }
      this.emit({ unresolved: false });
    }
    this.emit({ status });
  }
  private async run(action: (signal: AbortSignal) => Promise<PublicationStatus>) {
    if (this.disposed || this.state.busy) return;
    const abort = new AbortController(); this.controller = abort;
    this.emit({ busy: true, error: "" });
    try { const status = await action(abort.signal); if (!abort.signal.aborted) this.accept(status); }
    catch (error) { if (!abort.signal.aborted) this.emit({ error: publicationFailure(error) }); }
    finally { if (this.controller === abort) this.controller = null; this.emit({ busy: false }); }
  }
  refresh() { return this.run(signal => getPublicationStatus(this.identity, this.pending, signal)); }
  async publish(base: DraftSnapshot, review: PrivacyReview | null, blocked: boolean, confirmed: boolean) {
    if (this.disposed || this.state.busy || this.pending || this.journalFailed || this.state.error ||
        base.guideId !== this.identity.guideId || !this.state.status?.canRequest || !confirmed || !canPublishSnapshot(base, review, blocked)) return;
    const publicationId = crypto.randomUUID();
    try {
      // Another tab's unresolved request must be read, not replaced.
      const previous = this.journal.getItem(this.key);
      if (previous !== null) throw new Error();
      this.journal.setItem(this.key, publicationId);
      if (this.journal.getItem(this.key) !== publicationId) throw new Error();
    } catch {
      this.journalFailed = true;
      this.emit({ error: "게시 요청을 복구할 기록을 저장하지 못했어요. 새로고침 후 같은 작업의 상태를 확인해 주세요." }); return;
    }
    this.pending = publicationId; this.emit({ unresolved: true });
    const body = { publicationId, baseDraftRevision: base.revision, inputFingerprint: base.inputFingerprint,
      reviewFingerprint: review!.fingerprint, originalSharingEnabled: false as const, publicSharing: true as const };
    await this.run(signal => publishGuide(this.identity, body, signal));
  }
  withdraw() {
    const status = this.state.status;
    if (this.disposed || this.state.busy || this.state.error || !status?.canWithdraw) return Promise.resolve();
    // Never refresh/rebase inside this explicit mutation. A 409 requires another user decision.
    return this.run(signal => unpublishGuide(this.identity, { expectedHeadVersion: status.headVersion, expectedJobId: status.pendingJobId }, signal));
  }
  get newRequestBlocked() { return this.journalFailed || Boolean(this.pending) || this.state.unresolved; }
  get recoveryUnavailable() { return this.journalFailed; }
  dispose() { this.disposed = true; this.controller?.abort(); this.listeners.clear(); }
}
