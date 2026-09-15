import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    ".next/**", ".cache/**", "next-env.d.ts", "coverage/**", "playwright-report/**",
    "test-results/**", "ui-mockup/**", "ui-mockup-backup/**",
    ".impeccable/**", ".agents/**", ".codex/**", ".claude/**",
  ]),
]);
