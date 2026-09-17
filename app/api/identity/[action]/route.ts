import { identity, checkRequest, boundedBody, sessionReference, json, failure } from "@/lib/auth/runtime";
import { securitySchema } from "@/lib/auth/validation";
import { AccessError } from "@/lib/auth/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  try {
    checkRequest(request, true);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AccessError(415, "JSON is required.");
    let input: unknown;
    try { input = JSON.parse(await boundedBody(request)); } catch (error) { if (error instanceof AccessError) throw error; throw new AccessError(400, "Invalid request."); }
    const { action } = await context.params;
    const service = identity();
    if (action === "setup") return json(await service.setup(input));
    if (action === "invite-accept") return json({ recoveryCodes: await service.acceptInvitation(input, "shared") });
    if (action === "recover") { await service.recover(input, "shared"); return json({ ok: true }); }
    const reference = await sessionReference(request.headers);
    if (action === "invite") return json({ token: await service.invite(reference, input) });
    if (action !== "security") throw new AccessError(404, "Not found.");
    const parsed = securitySchema.safeParse(input);
    if (!parsed.success) throw new AccessError(400, "Check the submitted fields.");
    const data = parsed.data;
    switch (data.action) {
      case "confirm": await service.confirmPassword(reference, data.password, "shared"); break;
      case "password": await service.changePassword(reference, data.password); break;
      case "codes": return json({ recoveryCodes: await service.regenerateCodes(reference) });
      case "revokeSessions": await service.revokeSessions(reference); break;
      case "member": await service.changeMember(reference, data.userId, data.role, data.state); break;
      case "reset": return json({ token: await service.issueReset(reference, data.userId) });
      case "revokeInvite": await service.revokeInvitation(reference, data.invitationId); break;
    }
    return json({ ok: true });
  } catch (error) { return failure(error); }
}
