import { Auth, type AuthConfig } from "@auth/core";
import Credentials from "next-auth/providers/credentials";
import { authEnvironment, identity, checkRequest, boundedBody, failure } from "@/lib/auth/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handler(request: Request) {
  try {
    checkRequest(request, request.method === "POST");
    const environment = authEnvironment();
    const service = identity();
    const config: AuthConfig = {
      secret: environment.secret, trustHost: true, basePath: "/api/auth", useSecureCookies: environment.secure,
      pages: { signIn: "/login", error: "/login" },
      session: { strategy: "jwt", maxAge: 86400 },
      logger: { error() {}, warn() {}, debug() {} },
      providers: [Credentials({ credentials: { email: {}, password: { type: "password" } },
        async authorize(input) { return service.login(input.email, input.password, "shared"); },
      })],
      callbacks: {
        async jwt({ token, user }) {
          if (user && "reference" in user) return { sub: user.id, sid: user.reference };
          if (typeof token.sid !== "string") return null;
          try { const actor = await service.resolveSession(token.sid); if (actor.userId !== token.sub) return null; return token; } catch { return null; }
        },
        session({ session, token }) { return { expires: session.expires, user: { id: token.sub! } }; },
        redirect({ url }) { return url.startsWith("/") && !url.startsWith("//") ? `${environment.origin}${url}` : new URL(url).origin === environment.origin ? url : `${environment.origin}/dashboard`; },
      },
      events: { async signOut(message) { if ("token" in message && typeof message.token?.sid === "string") await service.signout(message.token.sid); } },
    };
    const canonical = new URL(new URL(request.url).pathname + new URL(request.url).search, environment.origin);
    const safeHeaders = new Headers(request.headers);
    safeHeaders.set("host", new URL(environment.origin).host);
    safeHeaders.set("x-forwarded-host", new URL(environment.origin).host);
    safeHeaders.set("x-forwarded-proto", environment.secure ? "https" : "http");
    const safeRequest = new Request(canonical, { method: request.method, headers: safeHeaders, ...(request.method === "POST" ? { body: await boundedBody(request) } : {}) });
    const response = await Auth(safeRequest, config);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) { return failure(error); }
}
export { handler as GET, handler as POST };
