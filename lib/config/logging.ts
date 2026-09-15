import "server-only";
import type { EnvironmentField } from "./environment";

type SafeEvent =
  | { event: "configuration_unavailable"; fields: EnvironmentField[] }
  | { event: "database_unavailable" }
  | { event: "workflow_unavailable" };

// Explicit allowlist: never serialize Error objects, request data, or arbitrary metadata.
export function logSafeEvent(event: SafeEvent) {
  const entry = event.event === "configuration_unavailable"
    ? { event: event.event, fields: event.fields }
    : { event: event.event };
  console.warn(JSON.stringify(entry));
}
