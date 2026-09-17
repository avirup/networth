export const previewStates = ["ready", "loading", "empty", "error", "incomplete", "stale", "paused", "edge"] as const;
export type PreviewState = typeof previewStates[number];
