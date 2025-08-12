import { defineConfig } from "drizzle-kit";

export default defineConfig({
    schema: "./src/db/schema.ts",
    out: "./migrations",
    dialect: "sqlite",
    driver: "d1-http",
    dbCredentials: {
        databaseId: "2f5e4889-e11e-43d8-87d4-34b968d3b377",
        token: process.env.CF_TOKEN!,
        accountId: process.env.CF_ID!,
    },
});
