// Allowlist OS plumbing, not application credentials or Node preload options.
// This does not constitute network isolation; CI can additionally disable egress.
const allowed = new Set([
  "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT",
  "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TZ",
  "SHOWME_TEST_FFMPEG_PATH", "SHOWME_TEST_FFPROBE_PATH",
]);

export function testEnvironment(source) {
  const env = Object.fromEntries(Object.entries(source)
    .filter(([key, value]) => allowed.has(key.toUpperCase()) && typeof value === "string"));
  return { ...env, NODE_ENV: "test", TSX_DISABLE_CACHE: "1" };
}

export function testGroups(args) {
  if (args.length === 0) return ["migration", "server", "client"];
  if (args.length === 1 && ["migration", "server", "client", "images"].includes(args[0])) return args;
  throw new Error("Use no argument, or one of: migration, server, client, images. PostgreSQL is opt-in and separate.");
}
