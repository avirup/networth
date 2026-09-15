export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { inspectEnvironment } = await import("@/lib/config/environment");
  const { logSafeEvent } = await import("@/lib/config/logging");
  const report = inspectEnvironment();
  const fields = [...new Set([...report.missing, ...report.invalid])];
  if (fields.length) logSafeEvent({ event: "configuration_unavailable", fields });
}
