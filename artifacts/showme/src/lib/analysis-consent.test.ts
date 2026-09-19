import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalysisConsentNotice } from "../components/analysis-consent-notice.js";

const render = (frameCount: number) => renderToStaticMarkup(createElement(AnalysisConsentNotice, { frameCount }));
const text = (html: string) => html.replace(/<[^>]*>/g, "");

test("customer consent omits model and hosting brands without hiding the recipient or material risks", () => {
  const html = render(3);
  const visible = text(html.split("<details")[0]);
  for (const disclosure of ["전체 화면 3장", "외부 AI 처리업체 Google", "원본 영상과 음성은 보내지 않습니다",
    "삭제하거나 합친 장면도 전송 대상", "가림은 아직 전송 이미지에 반영되지 않습니다",
    "제품 개선", "사람이 검토", "개인·민감·기밀", "승인된 합성 자료만",
    "이미 전송된 데이터를 회수할 수는 없습니다", "기존 편집에 덮어쓰지"]) {
    assert.ok(visible.includes(disclosure), disclosure);
  }
  assert.doesNotMatch(text(html), /Gemini|Replit|FFmpeg|모델 버전|API 키/);
  assert.match(html, /href="https:\/\/ai\.google\.dev\/gemini-api\/terms#unpaid-services"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /referrerPolicy="no-referrer"/i);
});

test("optional details keep exact transfer scope, cost and cancellation limits accessible", () => {
  const html = render(3);
  assert.match(html, /<details[^>]*><summary[^>]*>전송 항목·비용·취소 자세히 보기<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:=|\s|>)/);
  const details = text(html.slice(html.indexOf("<details")));
  for (const disclosure of ["전체 원본 화면", "순서·시각·크기", "사용량을 계산하는 단계에서도 화면이 전송",
    "제목·제작 의도·직접 쓴 설명은 보내거나 분석에 적용하지 않습니다", "유료로 자동 전환하지 않습니다",
    "서비스 전체가 무료라는 뜻은 아닙니다", "즉시 멈춘다고 보장할 수는 없습니다"]) assert.ok(details.includes(disclosure), disclosure);
});

test("unknown frame count is not represented as zero transferable images", () => {
  const rendered = text(render(0));
  assert.ok(rendered.includes("추출된 전체 화면을 외부 AI 처리업체 Google에 전송합니다"));
  assert.doesNotMatch(rendered, /0장|undefined|NaN/);
});
