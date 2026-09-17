/** SDK/media errors may contain signed URLs, filenames, metadata or credentials. */
export function privateLogError(error: unknown): string {
  // Keep the surrounding event/code for operations; never stringify inner errors.
  return error instanceof Error ? "Error details withheld for privacy." : "Failure details withheld for privacy.";
}
