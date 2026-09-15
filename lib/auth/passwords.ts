import "server-only";
import { hash, verify, type Options } from "@node-rs/argon2";
import { z } from "zod";

const passwordSchema = z.string().min(12).max(1024);

// Benchmark again on the actual deployment before enabling credentials login.
export const ARGON2_OPTIONS = {
  // Numeric enum values avoid ambient const-enum imports under isolatedModules.
  algorithm: 2, // Argon2id
  version: 1, // V0x13 (encoded as v=19)
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  outputLen: 32,
} satisfies Options;

export async function hashPassword(password: string) {
  if (!passwordSchema.safeParse(password).success) throw new Error("Password does not meet length requirements.");
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(encodedHash: string, password: string) {
  if (!passwordSchema.safeParse(password).success) return false;
  try {
    return await verify(encodedHash, password);
  } catch {
    return false;
  }
}
