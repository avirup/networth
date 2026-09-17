import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
export function newToken() { return randomBytes(32).toString("hex"); }
export function sessionDigest(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function protectedDigest(purpose: string, value: string, secret: string) { return createHmac("sha256", secret).update(`${purpose}\0${value}`).digest("hex"); }
export function secretMatches(value: string, expected: string) { return timingSafeEqual(createHash("sha256").update(value).digest(), createHash("sha256").update(expected).digest()); }
export function makeRecoveryCodes() { return Array.from({ length: 8 }, () => randomBytes(16).toString("hex").match(/.{8}/g)!.join("-")); }
export function normalizeCode(code: string) { return code.replace(/[\s-]/g, "").toLowerCase(); }
