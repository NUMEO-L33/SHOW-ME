import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Environment = Readonly<Record<string, string | undefined>>;
type SettingState = "missing" | "invalid" | "configured";
type SettingCheck = { name: string; label: string; state: SettingState; next: string };
const setting = (env: Environment, name: string) => env[name]?.trim() ?? "";

function isDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol) && Boolean(url.hostname) && url.pathname.length > 1 && !url.hash;
  } catch { return false; }
}
function isPublicOrigins(value: string): boolean {
  return value.split(",").every((part) => {
    try {
      const url = new URL(part.trim());
      return url.protocol === "https:" && Boolean(url.hostname) && !url.hostname.includes("*") && !url.username && !url.password &&
        url.pathname === "/" && !url.search && !url.hash;
    } catch { return false; }
  });
}
function isStoragePrefix(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return Boolean(normalized) && !normalized.includes("\0") &&
    normalized.split("/").every((part) => part && part !== "." && part !== "..");
}

/** Offline inventory ONLY. No config/startup import, client creation, connection, mutation or readiness issuance. */
export function inspectAnalysisPreflight(env: Environment) {
  const checks: SettingCheck[] = [];
  function check(name: string, label: string, valid: (value: string) => boolean, next: string) {
    const value = setting(env, name);
    checks.push({ name, label, state: !value ? "missing" : valid(value) ? "configured" : "invalid", next });
  }
  check("DATABASE_URL", "DB 연결 설정", isDatabaseUrl,
    "ShowMe 프로젝트의 Database 화면에서 개발/운영 대상을 확인하고 연결 정보는 Secrets에만 보관하세요.");
  check("SHOWME_STORAGE", "영속 파일 저장소 설정", (value) => value.toLowerCase() === "replit",
    "ShowMe 프로젝트의 App Storage를 준비한 후 SHOWME_STORAGE=replit을 설정하세요. local은 운영용이 아닙니다.");
  check("CORS_ORIGINS", "허용할 사이트 주소", isPublicOrigins,
    "게시된 ShowMe 사이트의 정확한 HTTPS origin을 설정하세요. 와일드카드·비밀번호·경로를 넣지 마세요.");
  check("ASSET_TICKET_SECRET", "비공개 이미지 서명 키", (value) => /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").length >= 32,
    "32바이트 이상의 무작위 base64url 키를 Secrets에 보관하세요. 기존 운영 키를 임의로 교체하지 마세요.");
  check("EXPECTED_MEDIA_VERSION", "미디어 실행 버전 설정", (value) => /^\d+\.\d+\.\d+$/.test(value),
    "서버의 ffmpeg/ffprobe 버전과 지원 여부를 확인한 뒤 정확한 버전을 설정하세요. 값을 추측하지 마세요.");
  check("GEMINI_API_KEY", "Gemini 키 설정", (value) => /^[\x21-\x7e]{10,4096}$/.test(value),
    "키는 서버 Secrets에만 보관하세요. 값이 있다는 사실은 키 유효성·프로젝트·무료 등급의 증거가 아닙니다.");
  if (setting(env, "REPLIT_OBJECT_STORAGE_PREFIX")) check("REPLIT_OBJECT_STORAGE_PREFIX", "저장소 경로 설정", isStoragePrefix,
    "안전한 상대 경로를 사용하세요. 기존 객체의 경로를 임의로 바꾸지 마세요.");

  // Intentionally no API for accepting imported success flags, screenshots, probe JSON or env consent as live evidence.
  return {
    kind: "offline-analysis-preflight" as const, version: 1 as const,
    ready: false as const, enablesAnalysis: false as const, networkCalls: 0 as const, changesApplied: false as const,
    settingsShapeValid: checks.every((item) => item.state === "configured"), checks,
    storageBucketSelection: setting(env, "REPLIT_OBJECT_STORAGE_BUCKET_ID") ? "explicit-unverified" as const : "default-unverified" as const,
    unverified: [
      { code: "DATABASE_RUNTIME", label: "DB 접속·현재 스키마·권한·보안 연결" },
      { code: "PRIVATE_STORAGE_RUNTIME", label: "저장소 대상·인증·비공개 파일 접근" },
      { code: "MEDIA_RUNTIME", label: "실제 ffmpeg/ffprobe 버전·실행" },
      { code: "APPROVED_INPUT", label: "현재 합성 자료의 전송 승인·파일 일치·철회 상태" },
      { code: "EXACT_INPUT_BOUND", label: "현재 전체 요청의 입력량 상한 근거" },
      { code: "FREE_PROJECT_AND_QUOTA", label: "키의 프로젝트·무료 등급·공유 요청 한도 범위" },
      { code: "HOSTING_ALLOWANCE", label: "서버·DB·저장소의 포함 사용량 및 추가 비용 조건" },
      { code: "LIVE_READINESS", label: "위 조건을 확인하는 실제 분석 준비 검증기" },
    ],
  };
}
export type AnalysisPreflightReport = ReturnType<typeof inspectAnalysisPreflight>;

export function preflightOutputMode(args: readonly string[]): "text" | "json" | "help" {
  if (!args.length) return "text";
  if (args.length === 1 && args[0] === "--json") return "json";
  if (args.length === 1 && args[0] === "--help") return "help";
  throw new Error("PREFLIGHT_ARGUMENTS_INVALID");
}
export function formatAnalysisPreflight(report: AnalysisPreflightReport): string {
  const labels = { missing: "없음", invalid: "설정 확인 필요", configured: "형식 확인됨·실연결 미검증" };
  return ["ShowMe 분석 연결 사전 점검 — 외부 연결/파일 변경 없음", "",
    ...report.checks.flatMap((item) => [`- ${item.label} (${item.name}): ${labels[item.state]}`,
      ...(item.state === "configured" ? [] : [`  다음: ${item.next}`])]), "",
    "실제 검증이 남은 항목:", ...report.unverified.map((item) => `- ${item.label}`), "",
    "결과: 분석 활성화 불가. 설정 형식 확인은 운영 연결 성공이나 전송 승인이 아닙니다.",
    "현재 실행 환경만 검사했습니다. 이 PC의 결과로 Replit Secrets의 상태를 판단하지 않습니다.",
    "키·연결 문자열·서명 키 값은 출력하지 않습니다. 서버 시작·DB 변경·Storage/Gemini 호출도 하지 않습니다.",
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = preflightOutputMode(process.argv.slice(2));
    if (mode === "help") console.log("npm run processor:preflight [-- --json]\n설정 형식만 점검합니다. 외부 전송/DB 변경/서버 시작 옵션은 없습니다.\n미검증 상태의 종료 코드는 2입니다.");
    else {
      const report = inspectAnalysisPreflight(process.env);
      console.log(mode === "json" ? JSON.stringify(report, null, 2) : formatAnalysisPreflight(report));
      process.exitCode = 2; // Always non-ready: a complete .env is not live runtime evidence.
    }
  } catch {
    console.error(JSON.stringify({ code: "PREFLIGHT_ARGUMENTS_INVALID", ready: false }));
    process.exitCode = 1;
  }
}
