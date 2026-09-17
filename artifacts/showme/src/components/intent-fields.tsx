import React from "react";
import { INTENT_LIMITS, type GuideIntent } from "../lib/guide-intent";

export function IntentFields({ value, onChange, prefix, error }: {
  value: GuideIntent;
  onChange: (value: GuideIntent) => void;
  prefix: string;
  error?: string | null;
}) {
  const inputClass = "mt-2 block w-full rounded-xl border border-[#d7dce8] bg-white px-3 py-2.5 text-sm text-[#172033] outline-none focus:border-[#4f6df5] focus:ring-2 focus:ring-[#4f6df5]/20";
  return <fieldset className="space-y-4">
    <legend className="text-base font-extrabold text-[#172033]">어떤 안내서를 만들까요?</legend>
    <p className="text-sm leading-6 text-muted-foreground" id={`${prefix}-help`}>
      목적을 먼저 기록해 주세요. 입력 내용은 비공개 서버 초안에 저장할 수 있어요. AI 전송·설명 생성은 아직 실행하지 않습니다. 비밀번호·계좌번호 등 민감한 정보는 적지 마세요.
    </p>
    <div>
      <label htmlFor={`${prefix}-goal`} className="text-sm font-bold">무엇을 알려주고 싶나요? <span className="text-primary">필수</span></label>
      <input id={`${prefix}-goal`} value={value.goal} maxLength={INTENT_LIMITS.goal} required
        aria-describedby={`${prefix}-help${error ? ` ${prefix}-error` : ""}`} aria-invalid={Boolean(error)}
        className={inputClass} placeholder="예: 카카오톡에서 사진 여러 장 보내기"
        onChange={(event) => onChange({ ...value, goal: event.target.value })} />
      <p className="mt-1 text-right text-xs text-muted-foreground">{value.goal.length}/{INTENT_LIMITS.goal}</p>
    </div>
    <div>
      <label htmlFor={`${prefix}-audience`} className="text-sm font-bold">누가 따라 하나요? <span className="font-normal text-muted-foreground">선택</span></label>
      <input id={`${prefix}-audience`} value={value.audience} maxLength={INTENT_LIMITS.audience}
        className={inputClass} placeholder="예: 스마트폰이 익숙하지 않은 부모님"
        onChange={(event) => onChange({ ...value, audience: event.target.value })} />
    </div>
    <div>
      <label htmlFor={`${prefix}-notes`} className="text-sm font-bold">꼭 반영할 요청이 있나요? <span className="font-normal text-muted-foreground">선택</span></label>
      <textarea id={`${prefix}-notes`} value={value.notes} maxLength={INTENT_LIMITS.notes} rows={3}
        className={`${inputClass} resize-y`} placeholder="예: 어려운 용어 없이, 누를 버튼 위치를 자세히 설명해 주세요."
        onChange={(event) => onChange({ ...value, notes: event.target.value })} />
      <p className="mt-1 text-right text-xs text-muted-foreground">{value.notes.length}/{INTENT_LIMITS.notes}</p>
    </div>
    {error && <p id={`${prefix}-error`} role="alert" className="text-sm font-semibold text-[#a7463a]">{error}</p>}
  </fieldset>;
}
