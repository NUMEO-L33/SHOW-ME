// Shared by the private reader and its caller. No startup registration or env override.
export const ANALYSIS_IMAGE_BUDGET = Object.freeze({
  ioMs: 4_500,
  maxIoMs: 5_000,
  decodeMs: 10_000,
  maxTotalMs: 15_000,
});
