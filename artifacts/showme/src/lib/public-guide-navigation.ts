type ViewerKey = Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "repeat" | "isComposing" | "defaultPrevented">;
type ViewerNavigation = Readonly<{
  index: number;
  stepCount: number;
  zoomed: boolean;
  ready: boolean;
  complete: boolean;
  interactiveTarget: boolean;
}>;

/** Return a step only when the viewer should consume a horizontal arrow key. */
export function publicGuideKeyboardStep(event: ViewerKey, state: ViewerNavigation): number | null {
  // Zoom owns the arrow keys for native image scrolling. Do not turn an IME,
  // selection, held-key or already-consumed event into a change of instructions.
  if (state.zoomed || !state.ready || state.complete || state.interactiveTarget ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      event.repeat || event.isComposing || event.defaultPrevented) return null;
  const next = event.key === "ArrowLeft" ? state.index - 1 : event.key === "ArrowRight" ? state.index + 1 : null;
  return next !== null && next >= 0 && next < state.stepCount ? next : null;
}
