import type { NextConfig } from "next";

const config: NextConfig = {
  // Keep the project's deliberately authored AGENTS.md unchanged on `next dev`.
  agentRules: false,
  // The CLI path uses a detached child process whose captured stdout is unavailable
  // in some self-hosted runtimes. TypeScript 5.9 exposes the equivalent compiler API.
  experimental: { useTypeScriptCli: false },
  poweredByHeader: false,
  outputFileTracingIncludes: { "/api/identity/*": ["./db/migrations/*.sql"] },
  serverExternalPackages: ["@node-rs/argon2", "pg"],
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
};

export default config;
