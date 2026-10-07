import assert from "node:assert/strict";
import { test } from "node:test";
import { publicGuideKeyboardStep } from "./public-guide-navigation.js";

const key = { key: "ArrowRight", altKey: false, ctrlKey: false, metaKey: false,
  shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false };
const ready = { index: 1, stepCount: 3, zoomed: false, ready: true, complete: false, interactiveTarget: false };

test("ready unzoomed viewer moves one step with left or right arrows", () => {
  assert.equal(publicGuideKeyboardStep(key, ready), 2);
  assert.equal(publicGuideKeyboardStep({ ...key, key: "ArrowLeft" }, ready), 0);
});
test("zoomed image keeps both horizontal arrows for native scrolling", () => {
  for (const direction of ["ArrowLeft", "ArrowRight"])
    assert.equal(publicGuideKeyboardStep({ ...key, key: direction }, { ...ready, zoomed: true }), null);
});
test("no step shortcut while loading or rechecking the current image", () => {
  assert.equal(publicGuideKeyboardStep(key, { ...ready, ready: false }), null);
});
test("completion screen keeps its explicit restart action", () => {
  assert.equal(publicGuideKeyboardStep({ ...key, key: "ArrowLeft" }, { ...ready, complete: true }), null);
});
test("browser shortcuts and text selection keep modifier arrow keys", () => {
  for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const)
    assert.equal(publicGuideKeyboardStep({ ...key, [modifier]: true }, ready), null);
});
test("a held arrow cannot skip several steps", () => {
  assert.equal(publicGuideKeyboardStep({ ...key, repeat: true }, ready), null);
});
test("IME and already-handled keys are not consumed", () => {
  assert.equal(publicGuideKeyboardStep({ ...key, isComposing: true }, ready), null);
  assert.equal(publicGuideKeyboardStep({ ...key, defaultPrevented: true }, ready), null);
});
test("focused controls retain their own keyboard behavior", () => {
  assert.equal(publicGuideKeyboardStep(key, { ...ready, interactiveTarget: true }), null);
});
test("boundaries and non-horizontal keys keep native behavior", () => {
  assert.equal(publicGuideKeyboardStep(key, { ...ready, index: 2 }), null);
  assert.equal(publicGuideKeyboardStep({ ...key, key: "ArrowLeft" }, { ...ready, index: 0 }), null);
  assert.equal(publicGuideKeyboardStep(key, { ...ready, stepCount: 0 }), null);
  for (const direction of ["ArrowUp", "ArrowDown", "Tab", "Enter", "Escape"])
    assert.equal(publicGuideKeyboardStep({ ...key, key: direction }, ready), null);
});
