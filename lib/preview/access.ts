import "server-only";
/** Explicit opt-in only, loopback origin, and never a Vercel deployment. No data access. */
export function localPreviewEnabled(env: Record<string, string | undefined> = process.env) {
  if (env.LOCAL_UI_PREVIEW !== "1" || env.VERCEL || env.VERCEL_ENV) return false;
  try {
    const url = new URL(env.APP_URL ?? "");
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch { return false; }
}
