export type GuideIntent = { goal: string; audience: string; notes: string };

export const INTENT_LIMITS = { goal: 120, audience: 120, notes: 1000 } as const;
export const EMPTY_INTENT: GuideIntent = { goal: "", audience: "", notes: "" };
export const DEFAULT_GUIDE_TITLE = "새 화면 안내서";

export function readGuideIntent(value: unknown): GuideIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_INTENT };
  const candidate = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(INTENT_LIMITS).map(([key, limit]) => [
    key, typeof candidate[key] === "string" ? candidate[key].trim().slice(0, limit) : "",
  ])) as GuideIntent;
}

export function validateGuideIntent(value: GuideIntent): string | null {
  if (!value.goal.trim()) return "무엇을 알려주고 싶은지 한 문장으로 적어 주세요.";
  for (const key of Object.keys(INTENT_LIMITS) as (keyof GuideIntent)[]) {
    if (value[key].length > INTENT_LIMITS[key]) return "입력할 수 있는 글자 수를 초과했어요.";
  }
  return null;
}

export function titleForGuide(intent: GuideIntent, fallback?: string): string {
  return intent.goal.trim().slice(0, INTENT_LIMITS.goal) || fallback?.trim().slice(0, 120) || DEFAULT_GUIDE_TITLE;
}
