import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

if (process.env.VERCEL || process.env.NODE_ENV === "production") {
  throw new Error("Local setup is disabled in hosted/production environments.");
}

const origin = "postgresql://networth_local:local-development-only@127.0.0.1:15432";
const contents = [
  "# Local development only. Generated secrets; never commit this file.",
  `DATABASE_URL=postgresql://networth_app:local-runtime-only@127.0.0.1:15432/networth_local`,
  `DATABASE_ADMIN_URL=${origin}/networth_local`,
  `TEST_DATABASE_URL=${origin}/networth_test`,
  `AUTH_SECRET=${randomBytes(32).toString("hex")}`,
  `BOOTSTRAP_SECRET=${randomBytes(32).toString("hex")}`,
  "APP_URL=http://127.0.0.1:3000",
  "INNGEST_DEV=1",
  "",
].join("\n");

try {
  await writeFile(new URL("../.env.local", import.meta.url), contents, { flag: "wx", mode: 0o600 });
  console.info("Created .env.local with local database settings and independent secrets.");
} catch (error) {
  if (error.code !== "EEXIST") throw new Error("Unable to create local configuration.");
  console.info(".env.local already exists; preserved without changes.");
}
