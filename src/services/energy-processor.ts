import { Database } from "../db";
import { dailyConsumption } from "../db/schema";
import { TuyaApiService, TuyaLogEntry } from "./tuya-api";
import { eq, and, max, sum, sql } from "drizzle-orm";

interface TariffRules {
    isLowTariff(date: Date): boolean;
}

export class NorthMacedoniaTariffRules implements TariffRules {
    /**
     * Checks if a given date falls within the low tariff period.
     * Uses the tariff rules for North Macedonia.
     * @param date - The date object to check.
     * @returns Returns true if it's a low tariff period, otherwise false.
     */
    isLowTariff(date: Date): boolean {
        // IMPORTANT: We are working with the local time for Skopje.
        // The Unix timestamps from Tuya are in UTC, so we convert them.
        const localDate = new Date(
            date.toLocaleString("en-US", {
                timeZone: "Europe/Skopje",
            })
        );

        const day = localDate.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
        const hour = localDate.getHours();

        // Check for weekend low tariff (from Saturday 22:00 to Monday 07:00)
        if (
            (day === 6 && hour >= 22) || // Saturday after 22:00
            day === 0 || // All of Sunday
            (day === 1 && hour < 7)
        ) {
            // Monday before 07:00
            return true;
        }

        // Check for daily low tariff (13:00 - 15:00)
        if (hour >= 13 && hour < 15) {
            return true;
        }

        // Check for nightly low tariff (22:00 - 07:00)
        if (hour >= 22 || hour < 7) {
            return true;
        }

        // If no conditions are met, it's a high tariff period
        return false;
    }
}

export class EnergyProcessor {
    private db: Database;
    private tuyaApi: TuyaApiService;
    private tariffRules: TariffRules;

    constructor(
        db: Database,
        tuyaApi: TuyaApiService,
        tariffRules: TariffRules = new NorthMacedoniaTariffRules()
    ) {
        this.db = db;
        this.tuyaApi = tuyaApi;
        this.tariffRules = tariffRules;
    }

    async processEnergyLogs(deviceId: string): Promise<string> {
        console.log(
            "Starting scheduled task: processEnergyLogs for device:",
            deviceId
        );

        // --- STEP 1: Get the timestamp of the last processed log ---
        let lastProcessedTimestamp = 0;
        try {
            const result = await this.db
                .select({
                    lastTs: max(dailyConsumption.lastProcessedTimestamp),
                })
                .from(dailyConsumption)
                .where(eq(dailyConsumption.deviceId, deviceId))
                .get();

            if (result && result.lastTs) {
                lastProcessedTimestamp = result.lastTs;
            }
        } catch (e) {
            console.error(
                "D1 DB error or table not found. Assuming first run.",
                e
            );
        }

        console.log(`Last processed timestamp: ${lastProcessedTimestamp}`);

        // --- STEP 2: Call the Tuya API to get new logs ---
        try {
            const apiResponse = await this.tuyaApi.getDeviceLogConvenience(
                deviceId,
                {
                    start:
                        lastProcessedTimestamp > 0
                            ? Math.floor(lastProcessedTimestamp / 1000)
                            : -7, // Convert to seconds or 7 day ago
                    end: 0, // now
                    evtype: "7", // data point reports (add_ele events)
                    size: 5000,
                }
            );

            const newLogs = apiResponse.result.logs.filter(
                (log) => log.code === "add_ele"
            );

            if (newLogs.length === 0) {
                console.log("No new 'add_ele' logs to process.");
                return "No new logs.";
            }

            // --- STEP 3: Aggregate the data by day and tariff ---
            const dailyAggregates: Record<
                string,
                { lowTariffKwh: number; highTariffKwh: number }
            > = {};
            let maxTimestamp = lastProcessedTimestamp;

            for (const log of newLogs) {
                const timestamp = log.event_time;
                const valueKwh = parseFloat(log.value) / 1000;

                if (timestamp > maxTimestamp) {
                    maxTimestamp = timestamp;
                }

                const date = new Date(timestamp);
                // Format the date as YYYY-MM-DD to use as the database key
                const dateKey = date.toISOString().split("T")[0];

                // Initialize if an entry for this day doesn't exist yet
                if (!dailyAggregates[dateKey]) {
                    dailyAggregates[dateKey] = {
                        lowTariffKwh: 0,
                        highTariffKwh: 0,
                    };
                }

                // Classify the consumption based on the tariff
                if (this.tariffRules.isLowTariff(date)) {
                    dailyAggregates[dateKey].lowTariffKwh += valueKwh;
                } else {
                    dailyAggregates[dateKey].highTariffKwh += valueKwh;
                }
            }

            console.log(
                "Aggregated data:",
                JSON.stringify(dailyAggregates, null, 2)
            );

            // --- STEP 4: Write the aggregated data to the D1 database ---
            for (const [dateKey, data] of Object.entries(dailyAggregates)) {
                try {
                    // First, try to get existing record
                    const existing = await this.db
                        .select()
                        .from(dailyConsumption)
                        .where(
                            and(
                                eq(dailyConsumption.date, dateKey),
                                eq(dailyConsumption.deviceId, deviceId)
                            )
                        )
                        .get();

                    if (existing) {
                        // Update existing record
                        await this.db
                            .update(dailyConsumption)
                            .set({
                                lowTariffKwh:
                                    existing.lowTariffKwh + data.lowTariffKwh,
                                highTariffKwh:
                                    existing.highTariffKwh + data.highTariffKwh,
                                lastProcessedTimestamp: maxTimestamp,
                                updatedAt: new Date(),
                            })
                            .where(eq(dailyConsumption.id, existing.id));
                    } else {
                        // Insert new record
                        await this.db.insert(dailyConsumption).values({
                            date: dateKey,
                            deviceId,
                            lowTariffKwh: data.lowTariffKwh,
                            highTariffKwh: data.highTariffKwh,
                            lastProcessedTimestamp: maxTimestamp,
                        });
                    }
                } catch (e) {
                    console.error(`Failed to upsert data for ${dateKey}:`, e);
                    throw e;
                }
            }

            console.log(
                `Successfully processed and saved ${
                    Object.keys(dailyAggregates).length
                } daily aggregate(s).`
            );
            return "Scheduled task completed successfully.";
        } catch (e) {
            console.error("Failed to process energy logs:", e);
            throw e;
        }
    }

    async getConsumption(deviceId: string, startDate: string, endDate: string) {
        try {
            const result = await this.db
                .select({
                    totalLow: sum(dailyConsumption.lowTariffKwh),
                    totalHigh: sum(dailyConsumption.highTariffKwh),
                })
                .from(dailyConsumption)
                .where(
                    and(
                        eq(dailyConsumption.deviceId, deviceId),
                        // Use sql for date range queries since drizzle doesn't have gte/lte for text
                        sql`${dailyConsumption.date} >= ${startDate}`,
                        sql`${dailyConsumption.date} <= ${endDate}`
                    )
                )
                .get();

            return result;
        } catch (e) {
            console.error("Failed to query consumption data:", e);
            throw e;
        }
    }

    async getAllConsumption(startDate: string, endDate: string) {
        try {
            const result = await this.db
                .select({
                    totalLow: sum(dailyConsumption.lowTariffKwh),
                    totalHigh: sum(dailyConsumption.highTariffKwh),
                })
                .from(dailyConsumption)
                .where(
                    and(
                        sql`${dailyConsumption.date} >= ${startDate}`,
                        sql`${dailyConsumption.date} <= ${endDate}`
                    )
                )
                .get();

            return result;
        } catch (e) {
            console.error("Failed to query consumption data:", e);
            throw e;
        }
    }
}
