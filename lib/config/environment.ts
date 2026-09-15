import "server-only";
import { z } from "zod";

const secret = z.string().min(32);
const fields = {
  DATABASE_URL: z.url().refine((value) => value.startsWith("postgres:") || value.startsWith("postgresql:")),
  AUTH_SECRET: secret,
  BOOTSTRAP_SECRET: secret,
  APP_URL: z.url(),
  INNGEST_EVENT_KEY: z.string().min(1),
  INNGEST_SIGNING_KEY: z.string().min(1),
  INNGEST_SIGNING_KEY_FALLBACK: z.string().min(1),
  INNGEST_DEV: z.enum(["0", "1"]),
} as const;

export type EnvironmentField = keyof typeof fields;
export type Environment = Partial<Record<EnvironmentField, string>>;
export type Deployment = "local" | "preview" | "production";
export type EnvironmentReport = {
  values: Environment;
  missing: EnvironmentField[];
  invalid: EnvironmentField[];
  deployment: Deployment;
};

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function inspectEnvironment(source: Record<string, string | undefined> = process.env): EnvironmentReport {
  // Unknown hosted contexts fail closed as previews, never as local development.
  const deployment: Deployment = source.VERCEL_ENV === "production" ? "production"
    : source.VERCEL_ENV || source.VERCEL ? "preview"
      : source.NODE_ENV === "production" ? "production" : "local";
  const values: Environment = {};
  const invalid = new Set<EnvironmentField>();
  for (const key of Object.keys(fields) as EnvironmentField[]) {
    const raw = source[key];
    if (!raw) continue;
    const result = fields[key].safeParse(raw);
    if (result.success) values[key] = result.data;
    else invalid.add(key);
  }
  for (const key of Object.keys(fields) as EnvironmentField[]) {
    if (source[`NEXT_PUBLIC_${key}`]) invalid.add(key);
  }
  if (values.APP_URL) {
    const url = new URL(values.APP_URL);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || !(url.protocol === "https:" || (deployment === "local" && url.protocol === "http:" && loopback.has(url.hostname)))) {
      invalid.add("APP_URL");
    }
  }
  if (values.DATABASE_URL) {
    const url = new URL(values.DATABASE_URL);
    if (deployment !== "local" && url.searchParams.get("sslmode") !== "verify-full") {
      invalid.add("DATABASE_URL");
    }
  }
  if (values.INNGEST_DEV === "1" && deployment !== "local") invalid.add("INNGEST_DEV");
  const required: EnvironmentField[] = ["DATABASE_URL", "AUTH_SECRET"];
  if (deployment !== "local") required.push("APP_URL", "INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY");
  for (const key of invalid) delete values[key];
  return { values, invalid: [...invalid], missing: required.filter((key) => !source[key]), deployment };
}

export function environmentIsValid(report: EnvironmentReport) {
  return report.missing.length === 0 && report.invalid.length === 0;
}
