import type { EnvironmentReport } from "./environment";
import { environmentIsValid } from "./environment";

export const FINANCIAL_SCHEMA = 9;
export const SUPPORTED_SCHEMA = { min: 1, max: 9 } as const;

export type InstallationState = { schemaVersion: number; setupCompleted: boolean } | null;

export function schemaIsCompatible(version: number | null) {
  return version !== null && Number.isInteger(version)
    && version >= SUPPORTED_SCHEMA.min && version <= SUPPORTED_SCHEMA.max;
}

export function canUseDatabase(report: EnvironmentReport) {
  return report.deployment !== "preview" && !!report.values.DATABASE_URL
    && !report.invalid.includes("DATABASE_URL");
}

export function canServeWorkflows(report: EnvironmentReport) {
  if (report.deployment === "preview" || !environmentIsValid(report)) return false;
  return report.deployment === "local"
    ? report.values.INNGEST_DEV === "1"
    : !!report.values.INNGEST_EVENT_KEY && !!report.values.INNGEST_SIGNING_KEY;
}

export function financialWriteStatus(report: EnvironmentReport, installation: InstallationState, workflowVerified: boolean) {
  if (report.deployment === "preview") return "preview_disabled";
  if (!environmentIsValid(report)) return "configuration_unavailable";
  if (!installation || installation.schemaVersion !== FINANCIAL_SCHEMA) return "schema_incompatible";
  if (!installation.setupCompleted) return "setup_incomplete";
  if (!canServeWorkflows(report) || !workflowVerified) return "workflow_unavailable";
  return "ready";
}
