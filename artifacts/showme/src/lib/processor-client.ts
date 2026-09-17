import type { GuideStep } from "@/lib/showme-data";

export type ProcessorStatus =
  | "uploading"
  | "queued"
  | "probing"
  | "extracting"
  | "ready"
  | "failed";

export type ProcessorGuide = {
  id: string;
  title: string;
  status: ProcessorStatus;
  progress: number;
  statusMessage: string;
  errorMessage?: string | null;
  retryable?: boolean;
  media?: {
    durationMs: number;
    width: number;
    height: number;
    orientation: "portrait" | "landscape" | "square";
    rotation: number;
  } | null;
  steps: GuideStep[];
  assetExpiresAt?: number;
};

export type CreatedGuide = {
  guideId: string;
  status: ProcessorStatus;
};

export type UploadIdentity = {
  guideId: string;
  editToken: string;
};

export class ProcessorClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ProcessorClientError";
  }
}

export const RECOVERABLE_CREDENTIAL_KEY_PREFIX = "showme:processing-job:";

export function recoverableCredentialKey(guideId: string): string {
  if (!guideId) throw new TypeError("guideId is required");
  return `${RECOVERABLE_CREDENTIAL_KEY_PREFIX}${encodeURIComponent(guideId)}`;
}

export function persistRecoverableCredentials(
  storage: Pick<Storage, "setItem" | "getItem" | "removeItem">,
  key: string,
  value: string,
): void {
  let previous: string | null = null;
  try {
    previous = storage.getItem(key);
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) throw new Error("Browser storage read-back mismatch");
  } catch {
    try {
      if (previous === null) storage.removeItem(key);
      else storage.setItem(key, previous);
    } catch { /* best-effort rollback */ }
    throw new ProcessorClientError(
      "이 브라우저에 복구 키를 안전하게 저장할 수 없어 업로드를 시작하지 않았어요. 사이트 저장 공간을 허용한 뒤 다시 시도해 주세요.",
      undefined,
      "CREDENTIAL_PERSISTENCE_REQUIRED",
    );
  }
}

function normalizedBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

export function configuredProcessorUrl() {
  const configured = import.meta.env.VITE_SHOWME_PROCESSOR_URL?.trim();
  if (configured) {
    try {
      const target = new URL(configured);
      if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) return null;
      if (typeof window !== "undefined") {
        const pageIsLocal = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
        const targetIsLocal = ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
        if (!pageIsLocal && targetIsLocal) return null;
        if (window.location.protocol === "https:" && target.protocol !== "https:") return null;
      }
      return normalizedBaseUrl(target.toString());
    } catch {
      return null;
    }
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "";
}

export function createUploadIdentity(): UploadIdentity {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  const editToken = window.btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return { guideId: window.crypto.randomUUID(), editToken };
}

function errorFromPayload(status: number, payload: unknown) {
  if (payload && typeof payload === "object") {
    const body = payload as { error?: unknown; code?: unknown };
    if (typeof body.error === "string") {
      return new ProcessorClientError(
        body.error,
        status,
        typeof body.code === "string" ? body.code : undefined,
      );
    }
  }
  return new ProcessorClientError("영상 처리 서버에 연결하지 못했어요.", status);
}

export function createGuide(
  baseUrl: string,
  file: File,
  identity: UploadIdentity,
  onUploadProgress: (percent: number) => void,
  signal?: AbortSignal,
) {
  return new Promise<CreatedGuide>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const form = new FormData();
    form.append("video", file, file.name);

    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });

    request.open("POST", `${normalizedBaseUrl(baseUrl)}/api/guides`);
    request.setRequestHeader("Authorization", `Bearer ${identity.editToken}`);
    request.setRequestHeader("X-ShowMe-Guide-Id", identity.guideId);
    request.responseType = "json";
    request.timeout = 20 * 60 * 1000;
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onUploadProgress((event.loaded / event.total) * 100);
    });
    request.addEventListener("load", () => {
      signal?.removeEventListener("abort", abort);
      const body = request.response as unknown;
      if (request.status >= 200 && request.status < 300) {
        resolve(body as CreatedGuide);
      } else {
        reject(errorFromPayload(request.status, body));
      }
    });
    request.addEventListener("error", () => {
      signal?.removeEventListener("abort", abort);
      reject(new ProcessorClientError("영상 처리 서버에 연결하지 못했어요."));
    });
    request.addEventListener("timeout", () => {
      signal?.removeEventListener("abort", abort);
      reject(new ProcessorClientError("영상 업로드 시간이 초과됐어요. 다시 시도해 주세요."));
    });
    request.addEventListener("abort", () => {
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("업로드를 취소했습니다.", "AbortError"));
    });
    request.send(form);
  });
}

async function readJson(response: Response) {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) throw errorFromPayload(response.status, payload);
  return payload;
}

function invalidResponse(): never {
  throw new ProcessorClientError("작업 서버의 응답 형식을 확인할 수 없어요.", undefined, "INVALID_RESPONSE");
}

// Include body reading in the deadline; a connected but stalled response must
// not leave the UI in an unbounded wait. Never expose request URLs or tokens.
export async function boundedRequest<T>(url: string, options: RequestInit, read: (response: Response) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  if (options.signal?.aborted) abort.abort();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, 15_000);
  try {
    return await read(await fetch(url, { ...options, signal: abort.signal, redirect: "error" }));
  } catch (error) {
    if (timedOut) throw new ProcessorClientError("서버 응답 시간이 초과됐어요.", undefined, "REQUEST_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

function withAbsoluteAssetUrls(baseUrl: string, guide: ProcessorGuide): ProcessorGuide {
  return {
    ...guide,
    steps: guide.steps.map((step) => ({
      ...step,
      frameUrl: step.frameUrl
        ? `${normalizedBaseUrl(baseUrl)}${step.frameUrl}`
        : undefined,
      thumbnailUrl: step.thumbnailUrl
        ? `${normalizedBaseUrl(baseUrl)}${step.thumbnailUrl}`
        : undefined,
    })),
  };
}

export async function getGuide(baseUrl: string, guideId: string, editToken: string, signal?: AbortSignal) {
  return boundedRequest(`${normalizedBaseUrl(baseUrl)}/api/guides/${encodeURIComponent(guideId)}`, {
    headers: { Authorization: `Bearer ${editToken}` },
    cache: "no-store",
    signal,
  }, async (response) => {
    const payload = (await readJson(response)) as { guide?: ProcessorGuide; assetExpiresAt?: number } | null;
    const guide = payload?.guide;
    if (!guide || guide.id !== guideId || !Array.isArray(guide.steps) ||
      !["uploading", "queued", "probing", "extracting", "ready", "failed"].includes(guide.status) ||
      !Number.isFinite(guide.progress) || guide.progress < 0 || guide.progress > 100 ||
      (guide.status === "ready" && guide.steps.length === 0)) invalidResponse();
    return {
      ...withAbsoluteAssetUrls(baseUrl, guide),
      assetExpiresAt: payload?.assetExpiresAt,
    };
  });
}

export async function retryGuide(baseUrl: string, guideId: string, editToken: string, signal?: AbortSignal) {
  const response = await fetch(`${normalizedBaseUrl(baseUrl)}/api/guides/${encodeURIComponent(guideId)}/retry`, {
    method: "POST",
    headers: { Authorization: `Bearer ${editToken}` },
    signal,
  });
  return (await readJson(response)) as { status: ProcessorStatus };
}

export async function deleteGuide(baseUrl: string, guideId: string, editToken: string, signal?: AbortSignal) {
  return boundedRequest(`${normalizedBaseUrl(baseUrl)}/api/guides/${encodeURIComponent(guideId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${editToken}` },
    signal,
  }, async (response) => {
    if (response.status === 204) return { pending: false };
    // The server deliberately uses the same 404 for an absent guide and a bad
    // credential. It is NOT proof of deletion: preserve the recovery key.
    const payload = await readJson(response) as { status?: unknown } | null;
    if (response.status === 202 && payload?.status === "deleting") return { pending: true };
    return invalidResponse();
  });
}
