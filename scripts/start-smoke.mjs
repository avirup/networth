import { spawn } from "node:child_process";

const mode = process.argv[2];
const port = process.argv[3];
if (!["missing", "preview"].includes(mode) || !["3100", "3101"].includes(port)) {
  throw new Error("Unsupported smoke-test configuration.");
}

// Explicit empty values prevent Next from loading actual local secrets for these servers.
const env = {
  ...process.env,
  NODE_ENV: "production", VERCEL: "", VERCEL_ENV: "",
  DATABASE_URL: "", DATABASE_ADMIN_URL: "", LOCAL_RUNTIME: "", AUTH_SECRET: "", BOOTSTRAP_SECRET: "", APP_URL: "",
  INNGEST_EVENT_KEY: "", INNGEST_SIGNING_KEY: "", INNGEST_SIGNING_KEY_FALLBACK: "", INNGEST_DEV: "0",
  TEST_DATABASE_URL: "", LOCAL_UI_PREVIEW: "1",
};
if (mode === "missing") env.APP_URL = `http://127.0.0.1:${port}`;
if (mode === "preview") Object.assign(env, {
  VERCEL: "1", VERCEL_ENV: "preview",
  // Syntactically configured, deliberately unreachable DB proves previews never query it.
  DATABASE_URL: "postgresql://fixture:preview-secret-marker@127.0.0.1:1/networth?sslmode=verify-full",
  AUTH_SECRET: "preview-secret-marker-that-must-stay-server-only",
  APP_URL: "https://preview.example.test",
  INNGEST_EVENT_KEY: "preview-event-secret-marker", INNGEST_SIGNING_KEY: "preview-signing-secret-marker",
});
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", port], {
  env, stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => { process.exitCode = code ?? 1; });
