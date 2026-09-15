import { readdir, readFile } from "node:fs/promises";
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd(), true);
const keys = ["AUTH_SECRET", "BOOTSTRAP_SECRET", "DATABASE_URL", "INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY", "INNGEST_SIGNING_KEY_FALLBACK"];
const secrets = keys.flatMap((key) => {
  const value = process.env[key];
  return value && value.length >= 8 ? [value, encodeURIComponent(value)] : [];
});
if (secrets.length === 0) throw new Error("No configured secrets available for the client-bundle check.");

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await scan(path);
    else {
      const content = await readFile(path, "utf8");
      if (secrets.some((secret) => content.includes(secret))) {
        throw new Error("A server-only value was found in client output. Do not publish this build.");
      }
    }
  }
}
await scan(".next/static");
console.info("Configured server-only values are absent from client static output.");
