import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/passwords";

describe("native Argon2id runtime", () => {
  it("uses independent salts and encoded parameters, and verifies passwords", async () => {
    const password = "synthetic password fixture";
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(first).not.toBe(second);
    expect(await verifyPassword(first, password)).toBe(true);
    expect(await verifyPassword(first, "incorrect password fixture")).toBe(false);
    expect(await verifyPassword("broken hash", password)).toBe(false);
  });
  it("supports long password-manager values and rejects excessive or short input", async () => {
    const password = "A".repeat(128);
    expect(await verifyPassword(await hashPassword(password), password)).toBe(true);
    await expect(hashPassword("short")).rejects.toThrow("length requirements");
    await expect(hashPassword("A".repeat(1025))).rejects.toThrow("length requirements");
  });
});
