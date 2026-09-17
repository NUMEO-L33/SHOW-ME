import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JobProgress, type JobProgressProps } from "../components/job-progress.js";
import { IntentFields } from "../components/intent-fields.js";
import { EMPTY_INTENT } from "./guide-intent.js";
import { jobIssueFor, UPLOAD_RECOVERY_GRACE_MS } from "./job-feedback.js";
import { ProcessorClientError } from "./processor-client.js";

const props: JobProgressProps = {
  phase: "processing", fileName: "synthetic.mp4", progress: 12,
  issue: null, errorMessage: null, onCancel: () => {}, onCheck: () => {}, retrying: false, canCancel: true,
};
const render = (changes: Partial<JobProgressProps>) => renderToStaticMarkup(createElement(JobProgress, { ...props, ...changes }));

test("deletion uses a dedicated view without stale percent, creation stages or a repeat-delete button", () => {
  const html = render({ phase: "deleting", progress: 12 });
  assert.match(html, /원본 영상과 추출 화면을 삭제/);
  assert.doesNotMatch(html, /12%|<progress|가이드 만드는 중|화면을 단계로 나누기|설명과 누를 위치 만들기|<button/);
});

test("missing and disconnected guides hide progress and never claim ongoing scene processing", () => {
  for (const error of [new TypeError("Failed to fetch"), new ProcessorClientError("missing", 404)]) {
    const html = render({ issue: jobIssueFor(error, 0, UPLOAD_RECOVERY_GRACE_MS + 1) });
    assert.doesNotMatch(html, /12%|<progress|영상에서 장면을 추출하고 있어요/);
    assert.match(html, /role="alert"/);
  }
});

test("404 reconciliation is bounded and access errors stop automatic polling", () => {
  const missing = new ProcessorClientError("missing", 404);
  assert.equal(jobIssueFor(missing, 100, 101).autoRetry, true);
  assert.equal(jobIssueFor(missing, 100, 100 + UPLOAD_RECOVERY_GRACE_MS).autoRetry, false);
  assert.equal(jobIssueFor(missing, 100, 99).autoRetry, false);
  for (const status of [401, 403]) assert.equal(jobIssueFor(new ProcessorClientError("access", status), 0).autoRetry, false);
  assert.equal(jobIssueFor(new ProcessorClientError("html", undefined, "INVALID_RESPONSE"), 0).autoRetry, false);
});

test("timeout and network failures do not reveal private inner error text", () => {
  const issue = jobIssueFor(new Error("https://private.invalid?token=secret"), 0);
  assert.equal(issue.autoRetry, true);
  assert.doesNotMatch(JSON.stringify(issue), /private.invalid|token=secret/);
  assert.equal(jobIssueFor(new ProcessorClientError("timeout", undefined, "REQUEST_TIMEOUT"), 0).autoRetry, true);
});

test("deletion errors never masquerade as success, and manual check is explicitly labelled", () => {
  const issue = jobIssueFor(new ProcessorClientError("auth", 403), 0);
  const html = render({ phase: "deleting", issue });
  assert.match(html, /삭제 완료를 확인하지 못했어요/);
  assert.match(html, /삭제 다시 확인/);
  assert.doesNotMatch(html, /삭제했어요|12%|<progress/);
});

test("checking and failed states omit old progress; upload progress is explicitly transmission only", () => {
  assert.doesNotMatch(render({ phase: "checking" }), /<progress|12%/);
  assert.doesNotMatch(render({ phase: "failed", errorMessage: "처리 실패" }), /<progress|12%/);
  const uploading = render({ phase: "uploading", progress: 100 });
  assert.match(uploading, /파일 전송/);
  assert.match(uploading, /서버 접수 완료를 의미하지는 않습니다/);
});

test("intent form has labelled bounded fields, describes private draft storage and does not claim AI use", () => {
  const html = renderToStaticMarkup(createElement(IntentFields, { prefix: "test", value: { ...EMPTY_INTENT, goal: "<script>bad()</script>" }, onChange: () => {} }));
  assert.match(html, /for="test-goal"/);
  assert.match(html, /maxLength="120"/i);
  assert.match(html, /maxLength="1000"/i);
  assert.match(html, /비공개 서버 초안에 저장할 수 있어요/);
  assert.match(html, /AI 전송·설명 생성은 아직 실행하지 않습니다/);
  assert.doesNotMatch(html, /<script>/);
});
