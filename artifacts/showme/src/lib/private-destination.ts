const localHost = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

/** Private media and credentials never follow a configured or recovered foreign origin. */
export function privateDestination(value: string, pageOrigin = typeof window === "undefined" ? undefined : window.location.origin): URL | null {
  try {
    if (/\s|\\/.test(value)) return null;
    const target = new URL(value);
    if (target.username || target.password || target.hash) return null;
    if (target.protocol !== "https:" && !(target.protocol === "http:" && localHost(target.hostname))) return null;
    if (pageOrigin) {
      if (target.origin !== new URL(pageOrigin).origin) return null;
    } else if (!localHost(target.hostname)) {
      // Non-browser fixture tests may use loopback, never an external service.
      return null;
    }
    return target;
  } catch { return null; }
}

export function privateProcessorOrigin(value: string, pageOrigin?: string): string | null {
  const target = privateDestination(value, pageOrigin);
  return target && target.pathname === "/" && !target.search ? target.origin : null;
}

export function privateApiDestination(value: string): string | null {
  const target = privateDestination(value);
  return target && /^\/api\/guides(?:\/|$)/.test(target.pathname) && !target.search ? target.href : null;
}
