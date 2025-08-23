import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDatabase } from "./db";
import { devices, households, invoicePeriods } from "./db/schema";
import { TuyaApiService } from "./services/tuya-api";
import { EnergyProcessor } from "./services/energy-processor";
import { eq, desc } from "drizzle-orm";

interface Bindings {
    DB: D1Database;
    TUYA_CLIENT_ID: string;
    TUYA_SECRET: string;
    TUYA_DEVICE_ID: string;
    TUYA_BASE_URL: string;
    ADMIN_PASSWORD: string;
}

const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS for all routes
app.use(
    "*",
    cors({
        origin: "*", // Allow all origins
        allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization", "X-Admin-Password"],
    })
);

// Authentication middleware for admin operations
const requireAuth = async (c: any, next: any) => {
    const headerPassword = c.req.header("X-Admin-Password");

    if (!headerPassword || headerPassword !== c.env.ADMIN_PASSWORD) {
        return c.text(
            "Unauthorized. Provide correct password via X-Admin-Password header.",
            401
        );
    }

    await next();
};

// Home route
app.get("/", (c) => {
    return c.text("Energy Monitor API - Powered by Hono 🔥");
});

// Check authentication endpoint
app.get("/check-auth", requireAuth, async (c) => {
    return c.json({
        authenticated: true,
        message: "Authentication successful",
    });
});

// Route to check system status and cron schedule
app.get("/status", async (c) => {
    const currentTime = new Date();
    const macedoniaTime = currentTime.toLocaleString("en-US", {
        timeZone: "Europe/Skopje",
    });

    return c.json({
        status: "online",
        current_utc_time: currentTime.toISOString(),
        current_macedonia_time: macedoniaTime,
        cron_schedule: "0 */2 * * *", // Every 2 hours at minute 0
        cron_description: "Runs every 2 hours (00:00, 02:00, 04:00, etc.) UTC",
        timezone_info: {
            server_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            macedonia_timezone: "Europe/Skopje",
            utc_offset: "+02:00 (CEST) or +01:00 (CET)",
        },
        environment: {
            has_tuya_credentials: !!(
                c.env.TUYA_CLIENT_ID &&
                c.env.TUYA_SECRET &&
                c.env.TUYA_DEVICE_ID
            ),
            has_database: !!c.env.DB,
            has_admin_password: !!c.env.ADMIN_PASSWORD,
        },
    });
});

// Route for manually triggering the process (for testing)
app.get("/run-manual", async (c) => {
    console.log(`🔧 MANUAL TASK TRIGGERED`);
    console.log(`🕒 Current UTC time: ${new Date().toISOString()}`);
    console.log(
        `🕒 Current Macedonia time: ${new Date().toLocaleString("en-US", {
            timeZone: "Europe/Skopje",
        })}`
    );
    console.log(`🌐 HTTP request context`);

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

        console.log(`✅ Manual processing completed successfully`);
        return c.text(result);
    } catch (error) {
        console.error("❌ Manual processing failed:", error);
        return c.text("Processing failed: " + (error as Error).message, 500);
    }
});

// Route for getting daily consumption breakdown for a specific period and device (max 30 days)
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
        const result = await processor.getDailyConsumption(
            deviceId,
            start,
            end
        );

        return c.json(result);
    } catch (error) {
        console.error("Failed to fetch consumption data:", error);
        return c.text("Error fetching data: " + (error as Error).message, 500);
    }
});

// Route for getting daily consumption breakdown for all devices (max 30 days)
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
        const result = await processor.getAllDailyConsumption(start, end);

        return c.json(result);
    } catch (error) {
        console.error("Failed to fetch consumption data:", error);
        return c.text("Error fetching data: " + (error as Error).message, 500);
    }
});

// Helper function to get or create default household "Doma"
async function getOrCreateDefaultHousehold(db: any): Promise<number> {
    // Try to find existing "Doma" household
    const existing = await db
        .select()
        .from(households)
        .where(eq(households.name, "Doma"))
        .get();

    if (existing) {
        return existing.id;
    }

    // Create "Doma" household if it doesn't exist
    const newHousehold = await db
        .insert(households)
        .values({ name: "Doma" })
        .returning();

    return newHousehold[0].id;
}

// Route to manage devices
app.post("/devices", requireAuth, async (c) => {
    try {
        const { id, name, householdId } = await c.req.json();

        if (!id || !name) {
            return c.text('Missing "id" or "name" in request body.', 400);
        }

        const db = createDatabase(c.env.DB);

        // Use provided householdId or default to "Doma" household
        const finalHouseholdId =
            householdId || (await getOrCreateDefaultHousehold(db));

        const newDevice = await db
            .insert(devices)
            .values({
                id,
                name,
                householdId: finalHouseholdId,
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

        // Get all devices with their household information
        const allDevices = await db
            .select({
                id: devices.id,
                name: devices.name,
                householdId: devices.householdId,
                householdName: households.name,
                createdAt: devices.createdAt,
            })
            .from(devices)
            .leftJoin(households, eq(devices.householdId, households.id));

        // For each device, get its household's invoice periods in descending order
        const devicesWithPeriods = await Promise.all(
            allDevices.map(async (device) => {
                if (!device.householdId) {
                    return {
                        ...device,
                        periods: [] as { from: string; to: string }[],
                    };
                }

                const periods = await db
                    .select({
                        from: invoicePeriods.fromDate,
                        to: invoicePeriods.toDate,
                    })
                    .from(invoicePeriods)
                    .where(eq(invoicePeriods.householdId, device.householdId))
                    .orderBy(desc(invoicePeriods.toDate));

                return {
                    ...device,
                    periods,
                };
            })
        );

        return c.json(devicesWithPeriods);
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
            .select({
                id: devices.id,
                name: devices.name,
                householdId: devices.householdId,
                householdName: households.name,
                createdAt: devices.createdAt,
            })
            .from(devices)
            .leftJoin(households, eq(devices.householdId, households.id))
            .where(eq(devices.id, deviceId))
            .get();

        if (!device) {
            return c.text("Device not found", 404);
        }

        // Get invoice periods for this device's household
        let periods: { from: string; to: string }[] = [];
        if (device.householdId) {
            periods = await db
                .select({
                    from: invoicePeriods.fromDate,
                    to: invoicePeriods.toDate,
                })
                .from(invoicePeriods)
                .where(eq(invoicePeriods.householdId, device.householdId))
                .orderBy(desc(invoicePeriods.toDate));
        }

        return c.json({
            ...device,
            periods,
        });
    } catch (error) {
        console.error("Failed to fetch device:", error);
        return c.text(
            "Error fetching device: " + (error as Error).message,
            500
        );
    }
});

app.put("/devices/:id", requireAuth, async (c) => {
    try {
        const deviceId = c.req.param("id");
        const { name, householdId } = await c.req.json();

        if (!name) {
            return c.text('Missing "name" in request body.', 400);
        }

        const db = createDatabase(c.env.DB);

        // Use provided householdId or keep existing, or default to "Doma" household
        let finalHouseholdId = householdId;
        if (!finalHouseholdId) {
            // Get current device to preserve existing householdId
            const currentDevice = await db
                .select()
                .from(devices)
                .where(eq(devices.id, deviceId))
                .get();

            finalHouseholdId =
                currentDevice?.householdId ||
                (await getOrCreateDefaultHousehold(db));
        }

        const updatedDevice = await db
            .update(devices)
            .set({ name, householdId: finalHouseholdId })
            .where(eq(devices.id, deviceId))
            .returning();

        if (updatedDevice.length === 0) {
            return c.text("Device not found", 404);
        }

        return c.json(updatedDevice[0]);
    } catch (error) {
        console.error("Failed to update device:", error);
        return c.text(
            "Error updating device: " + (error as Error).message,
            500
        );
    }
});

app.delete("/devices/:id", requireAuth, async (c) => {
    try {
        const deviceId = c.req.param("id");
        const db = createDatabase(c.env.DB);

        const deletedDevice = await db
            .delete(devices)
            .where(eq(devices.id, deviceId))
            .returning();

        if (deletedDevice.length === 0) {
            return c.text("Device not found", 404);
        }

        return c.json({ message: "Device deleted successfully" });
    } catch (error) {
        console.error("Failed to delete device:", error);
        return c.text(
            "Error deleting device: " + (error as Error).message,
            500
        );
    }
});

// CRUD endpoints for households

app.post("/households", requireAuth, async (c) => {
    try {
        const { name } = await c.req.json();

        if (!name) {
            return c.text('Missing "name" in request body.', 400);
        }

        const db = createDatabase(c.env.DB);
        const newHousehold = await db
            .insert(households)
            .values({ name })
            .returning();

        return c.json(newHousehold[0]);
    } catch (error) {
        console.error("Failed to create household:", error);
        return c.text(
            "Error creating household: " + (error as Error).message,
            500
        );
    }
});

app.get("/households", async (c) => {
    try {
        const db = createDatabase(c.env.DB);
        const allHouseholds = await db.select().from(households);
        return c.json(allHouseholds);
    } catch (error) {
        console.error("Failed to fetch households:", error);
        return c.text(
            "Error fetching households: " + (error as Error).message,
            500
        );
    }
});

app.get("/households/:id", async (c) => {
    try {
        const householdId = parseInt(c.req.param("id"));
        const db = createDatabase(c.env.DB);

        const household = await db
            .select()
            .from(households)
            .where(eq(households.id, householdId))
            .get();

        if (!household) {
            return c.text("Household not found", 404);
        }

        return c.json(household);
    } catch (error) {
        console.error("Failed to fetch household:", error);
        return c.text(
            "Error fetching household: " + (error as Error).message,
            500
        );
    }
});

app.put("/households/:id", requireAuth, async (c) => {
    try {
        const householdId = parseInt(c.req.param("id"));
        const { name } = await c.req.json();

        if (!name) {
            return c.text('Missing "name" in request body.', 400);
        }

        const db = createDatabase(c.env.DB);
        const updatedHousehold = await db
            .update(households)
            .set({ name })
            .where(eq(households.id, householdId))
            .returning();

        if (updatedHousehold.length === 0) {
            return c.text("Household not found", 404);
        }

        return c.json(updatedHousehold[0]);
    } catch (error) {
        console.error("Failed to update household:", error);
        return c.text(
            "Error updating household: " + (error as Error).message,
            500
        );
    }
});

app.delete("/households/:id", requireAuth, async (c) => {
    try {
        const householdId = parseInt(c.req.param("id"));
        const db = createDatabase(c.env.DB);

        const deletedHousehold = await db
            .delete(households)
            .where(eq(households.id, householdId))
            .returning();

        if (deletedHousehold.length === 0) {
            return c.text("Household not found", 404);
        }

        return c.json({ message: "Household deleted successfully" });
    } catch (error) {
        console.error("Failed to delete household:", error);
        return c.text(
            "Error deleting household: " + (error as Error).message,
            500
        );
    }
});

// CRUD endpoints for invoice periods

app.post("/invoice-periods", requireAuth, async (c) => {
    try {
        const { householdId, fromDate, toDate } = await c.req.json();

        if (!householdId || !fromDate || !toDate) {
            return c.text(
                'Missing required fields: "householdId", "fromDate", or "toDate".',
                400
            );
        }

        const db = createDatabase(c.env.DB);
        const newPeriod = await db
            .insert(invoicePeriods)
            .values({ householdId, fromDate, toDate })
            .returning();

        return c.json(newPeriod[0]);
    } catch (error) {
        console.error("Failed to create invoice period:", error);
        return c.text(
            "Error creating invoice period: " + (error as Error).message,
            500
        );
    }
});

app.get("/invoice-periods", async (c) => {
    try {
        const householdId = c.req.query("householdId");
        const db = createDatabase(c.env.DB);

        let periods;

        if (householdId) {
            periods = await db
                .select()
                .from(invoicePeriods)
                .where(eq(invoicePeriods.householdId, parseInt(householdId)))
                .orderBy(desc(invoicePeriods.toDate));
        } else {
            periods = await db
                .select()
                .from(invoicePeriods)
                .orderBy(desc(invoicePeriods.toDate));
        }
        return c.json(periods);
    } catch (error) {
        console.error("Failed to fetch invoice periods:", error);
        return c.text(
            "Error fetching invoice periods: " + (error as Error).message,
            500
        );
    }
});

app.get("/invoice-periods/:id", async (c) => {
    try {
        const periodId = parseInt(c.req.param("id"));
        const db = createDatabase(c.env.DB);

        const period = await db
            .select()
            .from(invoicePeriods)
            .where(eq(invoicePeriods.id, periodId))
            .get();

        if (!period) {
            return c.text("Invoice period not found", 404);
        }

        return c.json(period);
    } catch (error) {
        console.error("Failed to fetch invoice period:", error);
        return c.text(
            "Error fetching invoice period: " + (error as Error).message,
            500
        );
    }
});

app.put("/invoice-periods/:id", requireAuth, async (c) => {
    try {
        const periodId = parseInt(c.req.param("id"));
        const { householdId, fromDate, toDate } = await c.req.json();

        if (!householdId || !fromDate || !toDate) {
            return c.text(
                'Missing required fields: "householdId", "fromDate", or "toDate".',
                400
            );
        }

        const db = createDatabase(c.env.DB);
        const updatedPeriod = await db
            .update(invoicePeriods)
            .set({ householdId, fromDate, toDate })
            .where(eq(invoicePeriods.id, periodId))
            .returning();

        if (updatedPeriod.length === 0) {
            return c.text("Invoice period not found", 404);
        }

        return c.json(updatedPeriod[0]);
    } catch (error) {
        console.error("Failed to update invoice period:", error);
        return c.text(
            "Error updating invoice period: " + (error as Error).message,
            500
        );
    }
});

app.delete("/invoice-periods/:id", requireAuth, async (c) => {
    try {
        const periodId = parseInt(c.req.param("id"));
        const db = createDatabase(c.env.DB);

        const deletedPeriod = await db
            .delete(invoicePeriods)
            .where(eq(invoicePeriods.id, periodId))
            .returning();

        if (deletedPeriod.length === 0) {
            return c.text("Invoice period not found", 404);
        }

        return c.json({ message: "Invoice period deleted successfully" });
    } catch (error) {
        console.error("Failed to delete invoice period:", error);
        return c.text(
            "Error deleting invoice period: " + (error as Error).message,
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
        console.log(`🔄 SCHEDULED TASK TRIGGERED`);
        console.log(`📅 Cron expression: ${event.cron}`);
        console.log(`🕒 Current UTC time: ${new Date().toISOString()}`);
        console.log(
            `🕒 Current Macedonia time: ${new Date().toLocaleString("en-US", {
                timeZone: "Europe/Skopje",
            })}`
        );
        console.log(
            `🌍 Scheduled event context: ${
                typeof event.scheduledTime !== "undefined"
                    ? new Date(event.scheduledTime).toISOString()
                    : "N/A"
            }`
        );

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
                console.error("❌ Scheduled processing failed:", error);
            })
        );
    },

    // Handler for HTTP requests
    async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
        return app.fetch(request, env, ctx);
    },
};
