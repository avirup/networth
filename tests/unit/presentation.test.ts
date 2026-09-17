import { describe, expect, it } from "vitest";
import { currentMonth, formatMoney, validMonth } from "@/lib/presentation/format";
import { localPreviewEnabled } from "@/lib/preview/access";

describe("decimal-string presentation", () => {
  it.each([
    ["0", 0, "₹0"], ["12450000", 0, "₹1,24,50,000"], ["-142800.500000000001", 12, "−₹1,42,800.500000000001"],
    ["12345678901234567890123456.123456789012", 12, "₹1,23,45,67,89,01,23,45,67,89,01,23,456.123456789012"],
    ["0001.99", 0, "₹1"], ["-0.01", 0, "₹0"], ["1.2", 2, "₹1.20"],
  ])("formats %s without converting money to Number", (value, digits, expected) => expect(formatMoney(value, digits)).toBe(expected));
  it("rejects malformed amounts instead of displaying zero", () => {
    for (const value of ["", "NaN", "1e6", "₹10", "Infinity"]) expect(() => formatMoney(value)).toThrow();
  });
  it("changes month at midnight in the household timezone", () => {
    expect(currentMonth(new Date("2026-08-31T18:29:59Z"))).toBe("2026-08");
    expect(currentMonth(new Date("2026-08-31T18:30:00Z"))).toBe("2026-09");
    expect(validMonth("2026-10", "2026-09")).toBe(false);
    expect(validMonth("2026-00", "2026-09")).toBe(false);
  });
});

describe("local sample preview gate", () => {
  const local = { LOCAL_UI_PREVIEW: "1", APP_URL: "http://127.0.0.1:3000" };
  it("requires explicit opt-in and a loopback origin", () => {
    expect(localPreviewEnabled(local)).toBe(true);
    expect(localPreviewEnabled({ ...local, LOCAL_UI_PREVIEW: "" })).toBe(false);
    for (const origin of ["", "invalid", "https://example.com", "http://localhost.example.com", "http://localhost/path", "http://a:b@localhost"]) {
      expect(localPreviewEnabled({ ...local, APP_URL: origin })).toBe(false);
    }
  });
  it("rejects every Vercel context even with opt-in", () => {
    for (const hosted of [{ VERCEL: "1" }, { VERCEL_ENV: "preview" }, { VERCEL_ENV: "production" }, { VERCEL_ENV: "unknown" }]) {
      expect(localPreviewEnabled({ ...local, ...hosted })).toBe(false);
    }
  });
});
