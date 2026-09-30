import { expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { Inngest } from "inngest";
import { serve } from "inngest/next";
const key = "signkey-prod-" + "a".repeat(64), fallback = "signkey-prod-" + "b".repeat(64);
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const client = new Inngest({ id: "synthetic-signature-test", isDev: false, logger, signingKey: key, signingKeyFallback: fallback });
const handlers = serve({ client, functions: [] });
function request(signedWith?: string, stale = false) {
  const body = "{}", timestamp = String(Math.floor(Date.now() / 1000) - (stale ? 86400 : 0));
  const signature = signedWith ? `t=${timestamp}&s=${createHmac("sha256", signedWith.replace(/^signkey-\w+-/, "")).update(body + timestamp).digest("hex")}` : "";
  return new NextRequest("https://synthetic.example.test/api/inngest", { method: "POST", body, headers: { "Content-Type": "application/json", ...(signature ? { "x-inngest-signature": signature } : {}) } });
}
it("rejects missing, wrong and expired signatures in production", async () => {
  for (const req of [request(), request("signkey-prod-" + "c".repeat(64)), request(key, true)]) expect((await handlers.POST(req, undefined)).status).toBe(401);
});
it("accepts current and fallback signatures before validating invocation shape", async () => {
  // Empty bodies cannot invoke work, but valid authentication must get past the 401 boundary.
  for (const signing of [key, fallback]) {
    const response = await handlers.POST(request(signing), undefined);
    expect(response.status).not.toBe(401); expect(response.status).toBeGreaterThanOrEqual(400);
  }
});
