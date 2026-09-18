import { defineConfig } from "drizzle-kit";

// Schema generation is offline. There is deliberately no automatic migration/push command.
export default defineConfig({ dialect: "postgresql", schema: ["./db/schema/index.ts", "./db/schema/finance.ts"], out: "./db/migrations", strict: true });
