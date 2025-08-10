import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDatabase } from "./db";
import { devices } from "./db/schema";
import { TuyaApiService } from "./services/tuya-api";
import { EnergyProcessor } from "./services/energy-processor";
import { eq } from "drizzle-orm";

interface Bindings {
    DB: D1Database;
    TUYA_CLIENT_ID: string;
    TUYA_SECRET: string;
    TUYA_DEVICE_ID: string;
    TUYA_BASE_URL: string;
}

const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS for all routes
app.use(
    "*",
    cors({
        origin: "*", // Allow all origins
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
    })
);

// Home route
app.get("/", (c) => {
    return c.text("Energy Monitor API - Powered by Hono 🔥");
});

// Route for manually triggering the process (for testing)
app.get("/run-manual", async (c) => {
    try {
        const db = createDatabase(c.env.DB);
        const tuyaApi = new TuyaApiService({
            clientId: c.env.TUYA_CLIENT_ID,
            secret: c.env.TUYA_SECRET,
            deviceId: c.env.TUYA_DEVICE_ID,
            baseUrl: c.env.TUYA_BASE_URL,
        });

        const processor = new EnergyProcessor(db, tuyaApi);
        const result = await processor.processEnergyLogs(c.env.TUYA_DEVICE_ID);

        return c.text(result);
    } catch (error) {
        console.error("Manual processing failed:", error);
        return c.text("Processing failed: " + (error as Error).message, 500);
    }
});

// Route for getting consumption for a specific period and device
app.get("/consumption/:deviceId", async (c) => {
    const deviceId = c.req.param("deviceId");
    const start = c.req.query("start");
    const end = c.req.query("end");

    if (!start || !end) {
        return c.text('Missing "start" or "end" query parameters.', 400);
    }

    try {
        const db = createDatabase(c.env.DB);
        const tuyaApi = new TuyaApiService({
            clientId: c.env.TUYA_CLIENT_ID,
            secret: c.env.TUYA_SECRET,
            deviceId: c.env.TUYA_DEVICE_ID,
            baseUrl: c.env.TUYA_BASE_URL,
        });

        const processor = new EnergyProcessor(db, tuyaApi);
        const result = await processor.getConsumption(deviceId, start, end);

        return c.json(result);
    } catch (error) {
        console.error("Failed to fetch consumption data:", error);
        return c.text("Error fetching data: " + (error as Error).message, 500);
    }
});

// Route for getting total consumption for all devices
app.get("/consumption", async (c) => {
    const start = c.req.query("start");
    const end = c.req.query("end");

    if (!start || !end) {
        return c.text('Missing "start" or "end" query parameters.', 400);
    }

    try {
        const db = createDatabase(c.env.DB);
        const tuyaApi = new TuyaApiService({
            clientId: c.env.TUYA_CLIENT_ID,
            secret: c.env.TUYA_SECRET,
            deviceId: c.env.TUYA_DEVICE_ID,
            baseUrl: c.env.TUYA_BASE_URL,
        });

        const processor = new EnergyProcessor(db, tuyaApi);
        const result = await processor.getAllConsumption(start, end);

        return c.json(result);
    } catch (error) {
        console.error("Failed to fetch consumption data:", error);
        return c.text("Error fetching data: " + (error as Error).message, 500);
    }
});

// Route to manage devices
app.post("/devices", async (c) => {
    try {
        const { id, name } = await c.req.json();

        if (!id || !name) {
            return c.text('Missing "id" or "name" in request body.', 400);
        }

        const db = createDatabase(c.env.DB);

        const newDevice = await db
            .insert(devices)
            .values({
                id,
                name,
            })
            .returning();

        return c.json(newDevice[0]);
    } catch (error) {
        console.error("Failed to create device:", error);
        return c.text(
            "Error creating device: " + (error as Error).message,
            500
        );
    }
});

app.get("/devices", async (c) => {
    try {
        const db = createDatabase(c.env.DB);
        const allDevices = await db.select().from(devices);
        return c.json(allDevices);
    } catch (error) {
        console.error("Failed to fetch devices:", error);
        return c.text(
            "Error fetching devices: " + (error as Error).message,
            500
        );
    }
});

app.get("/devices/:id", async (c) => {
    try {
        const deviceId = c.req.param("id");
        const db = createDatabase(c.env.DB);

        const device = await db
            .select()
            .from(devices)
            .where(eq(devices.id, deviceId))
            .get();

        if (!device) {
            return c.text("Device not found", 404);
        }

        return c.json(device);
    } catch (error) {
        console.error("Failed to fetch device:", error);
        return c.text(
            "Error fetching device: " + (error as Error).message,
            500
        );
    }
});

// The main handler that executes for every event
export default {
    // Handler for scheduled events (CRON)
    async scheduled(
        event: ScheduledEvent,
        env: Bindings,
        ctx: ExecutionContext
    ) {
        console.log(`Triggered by CRON: ${event.cron}`);

        const db = createDatabase(env.DB);
        const tuyaApi = new TuyaApiService({
            clientId: env.TUYA_CLIENT_ID,
            secret: env.TUYA_SECRET,
            deviceId: env.TUYA_DEVICE_ID,
            baseUrl: env.TUYA_BASE_URL,
        });

        const processor = new EnergyProcessor(db, tuyaApi);

        ctx.waitUntil(
            processor.processEnergyLogs(env.TUYA_DEVICE_ID).catch((error) => {
                console.error("Scheduled processing failed:", error);
            })
        );
    },

    // Handler for HTTP requests
    async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
        return app.fetch(request, env, ctx);
    },
};
