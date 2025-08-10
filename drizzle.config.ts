import { defineConfig } from "drizzle-kit";

export default defineConfig({
    schema: "./src/db/schema.ts",
    out: "./migrations",
    dialect: "sqlite",
    driver: "d1-http",
    dbCredentials: {
        databaseId: "energy-monitor-db",
        token: process.env.CLOUDFLARE_API_TOKEN!,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    },
});
