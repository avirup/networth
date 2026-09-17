import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getToken } from "next-auth/jwt";
import { createIdentityService } from "@/db/auth/service";
import { inspectEnvironment } from "@/lib/config/environment";
import { canUseDatabase } from "@/lib/config/policy";
import { AccessError } from "./errors";
import type { Permission } from "./validation";

export function authEnvironment() {
  const env = inspectEnvironment();
  if (!canUseDatabase(env) || !env.values.AUTH_SECRET || !env.values.APP_URL || env.invalid.some(key => ["DATABASE_URL", "AUTH_SECRET", "APP_URL"].includes(key))) throw new AccessError(503, "Authentication is not configured. Check the server configuration.");
  return { secret: env.values.AUTH_SECRET, origin: new URL(env.values.APP_URL).origin, secure: env.values.APP_URL.startsWith("https:"), database: env.values.DATABASE_URL!, bootstrapSecret: env.values.BOOTSTRAP_SECRET };
}
export function identity() {
  const env = authEnvironment();
  return createIdentityService({ secret: env.secret, bootstrapSecret: env.bootstrapSecret, runtimeRole: decodeURIComponent(new URL(env.database).username) });
}
export async function sessionReference(requestHeaders: Headers) {
  const env = authEnvironment();
  const token = await getToken({ req: { headers: requestHeaders }, secret: env.secret, secureCookie: env.secure });
  if (typeof token?.sid !== "string") throw new AccessError(401, "Please sign in again.");
  return token.sid;
}
export async function requireActor(permission: Permission = "read", statusOnly = false) {
  try {
    const reference = await sessionReference(await headers());
    return { actor: statusOnly ? await identity().resolveStatus(reference) : await identity().resolve(reference, permission), reference };
  } catch (error) {
    if (!statusOnly && error instanceof AccessError && error.status === 503 && error.message.includes("upgrade")) redirect("/status");
    if (error instanceof AccessError && error.status === 403) redirect(statusOnly ? "/login" : "/dashboard");
    redirect("/login");
  }
}
export function checkRequest(request: Request, mutation = false) {
  const { origin } = authEnvironment();
  if (request.headers.get("host") !== new URL(origin).host) throw new AccessError(403, "Untrusted application origin.");
  if (mutation && request.headers.get("origin") !== origin) throw new AccessError(403, "Reload this page before continuing.");
}
export async function boundedBody(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 32768) throw new AccessError(413, "Request is too large.");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 32768) { await reader.cancel(); throw new AccessError(413, "Request is too large."); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { "Cache-Control": "no-store" } }); }
export function failure(error: unknown) {
  if (error instanceof AccessError) return json({ error: error.message }, error.status);
  const code = error && typeof error === "object" && "cause" in error ? (error.cause as { code?: string })?.code : undefined;
  if (code === "23514") return json({ error: "This change would remove the last active owner or violate an account rule." }, 409);
  return json({ error: "The request could not be completed. Try again or check the installation." }, 503);
}
