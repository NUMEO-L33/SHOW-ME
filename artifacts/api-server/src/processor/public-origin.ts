/** Operator configuration only. Never derive URLs from Host, forwarded headers or user input. */
export function publicPageOrigin(raw: string | undefined, allowLoopback: boolean): string | undefined {
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.origin === "null" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (raw !== url.origin && raw !== `${url.origin}/`) ||
      (url.protocol !== "https:" && !(allowLoopback && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))))
    throw new Error("SHOWME_PUBLIC_ORIGIN must be an HTTPS origin (HTTP loopback is allowed only outside production).");
  return url.origin;
}
