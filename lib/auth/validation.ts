import { z } from "zod";
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(12).max(1024);
export const nameSchema = z.string().trim().min(1).max(100);
export const setupSchema = z.object({ setupCode: z.string().min(32).max(256), name: nameSchema, email: emailSchema, password: passwordSchema, householdName: nameSchema.default("My household") }).strict();
export const invitationSchema = z.object({ email: emailSchema, role: z.enum(["editor", "viewer"]) }).strict();
export const acceptSchema = z.object({ token: z.string().length(64), email: emailSchema, name: nameSchema, password: passwordSchema }).strict();
export const recoverSchema = z.object({ email: emailSchema, code: z.string().min(20).max(100), password: passwordSchema, method: z.enum(["code", "reset"]) }).strict();
export const securitySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), password: passwordSchema }),
  z.object({ action: z.literal("password"), password: passwordSchema }),
  z.object({ action: z.literal("codes") }),
  z.object({ action: z.literal("revokeSessions") }),
  z.object({ action: z.literal("member"), userId: z.uuid(), role: z.enum(["owner", "editor", "viewer"]), state: z.enum(["active", "disabled"]) }),
  z.object({ action: z.literal("reset"), userId: z.uuid() }),
  z.object({ action: z.literal("revokeInvite"), invitationId: z.uuid() }),
]);
export type Role = "owner" | "editor" | "viewer";
export type Permission = "read" | "import" | "export" | "classify" | "admin";
export function hasPermission(role: Role, permission: Permission) {
  return permission === "read" || role === "owner" || (role === "editor" && ["import", "classify"].includes(permission));
}
