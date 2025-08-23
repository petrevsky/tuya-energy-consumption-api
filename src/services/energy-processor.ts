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
        // Get the hour and day in Macedonia timezone using Intl API
        const hour = parseInt(
            date.toLocaleString("en-US", {
                timeZone: "Europe/Skopje",
                hour: "2-digit",
                hour12: false,
            })
        );

        const dayStr = date.toLocaleDateString("en-US", {
            timeZone: "Europe/Skopje",
            weekday: "short",
        });

        // Convert day string to numeric (0=Sunday, 1=Monday, ..., 6=Saturday)
        const dayMap: { [key: string]: number } = {
            Sun: 0,
            Mon: 1,
            Tue: 2,
            Wed: 3,
            Thu: 4,
            Fri: 5,
            Sat: 6,
        };
        const day = dayMap[dayStr] || 0;

        // Debug logging
        console.log(
            `Tariff check - UTC: ${date.toISOString()}, Macedonia: ${date.toLocaleString(
                "en-US",
                { timeZone: "Europe/Skopje" }
            )}, Day: ${day} (${dayStr}), Hour: ${hour}`
        );

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

    async processEnergyLogs(
        deviceId: string,
        forceStartTimestamp?: number
    ): Promise<string> {
        console.log(
            "Starting scheduled task: processEnergyLogs for device:",
            deviceId
        );

        // --- STEP 1: Get the timestamp of the last processed log ---
        let lastProcessedTimestamp = forceStartTimestamp || 0;

        if (!forceStartTimestamp) {
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

            const allAddEleLogs = apiResponse.result.logs.filter(
                (log) => log.code === "add_ele"
            );

            const newLogs =
                forceStartTimestamp === 0
                    ? allAddEleLogs
                    : allAddEleLogs.filter(
                          (log) => log.event_time > lastProcessedTimestamp
                      );

            if (allAddEleLogs.length > newLogs.length) {
                console.log(
                    `Found ${allAddEleLogs.length} 'add_ele' logs, processing ${newLogs.length} after timestamp filtering`
                );
            } else {
                console.log(
                    `Found ${allAddEleLogs.length} 'add_ele' logs to process`
                );
            }

            if (newLogs.length === 0) {
                console.log("No new 'add_ele' logs to process.");
                return "No new logs.";
            }

            // --- STEP 3: Aggregate the data by day and tariff ---
            const dailyAggregates: Record<
                string,
                {
                    lowTariffKwh: number;
                    highTariffKwh: number;
                    lastProcessedTimestamp: number;
                }
            > = {};

            for (const log of newLogs) {
                let timestamp = log.event_time;
                const valueKwh = parseFloat(log.value) / 1000;

                // Fix for timestamp format issue: Ensure timestamp is in milliseconds
                // If timestamp is less than 1e12 (year 2001), it's likely in seconds
                if (timestamp < 1e12) {
                    timestamp = timestamp * 1000;
                    console.log(
                        `Converted timestamp from seconds to milliseconds: ${log.event_time} -> ${timestamp}`
                    );
                }

                // Convert timestamp to Macedonia timezone and get date
                // timestamp is now guaranteed to be in milliseconds
                const date = new Date(timestamp);

                // Validate that the date is reasonable (not in 1970 or far future)
                const currentYear = new Date().getFullYear();
                const dateYear = date.getFullYear();
                if (dateYear < 2020 || dateYear > currentYear + 1) {
                    console.warn(
                        `⚠️ Suspicious timestamp detected: ${
                            log.event_time
                        } -> ${date.toISOString()} (year ${dateYear})`
                    );
                    continue; // Skip this log entry
                }

                const dateKey = date.toLocaleDateString("en-CA", {
                    timeZone: "Europe/Skopje",
                }); // en-CA gives YYYY-MM-DD format

                // Initialize if an entry for this day doesn't exist yet
                if (!dailyAggregates[dateKey]) {
                    dailyAggregates[dateKey] = {
                        lowTariffKwh: 0,
                        highTariffKwh: 0,
                        lastProcessedTimestamp: 0,
                    };
                }

                // Update the last processed timestamp for this day if this log is newer
                if (
                    timestamp > dailyAggregates[dateKey].lastProcessedTimestamp
                ) {
                    dailyAggregates[dateKey].lastProcessedTimestamp = timestamp;
                }

                // Classify the consumption based on the tariff
                const isLow = this.tariffRules.isLowTariff(date);
                // Debug logging to understand tariff classification
                console.log(
                    `Original: ${
                        log.event_time
                    }, Final: ${timestamp}, Macedonia time: ${date.toLocaleString(
                        "en-US",
                        { timeZone: "Europe/Skopje" }
                    )}, isLowTariff: ${isLow}, kWh: ${valueKwh}`
                );

                if (isLow) {
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
            // Sort dates chronologically before insertion to ensure consistent ID order
            const sortedEntries = Object.entries(dailyAggregates).sort(
                ([dateA], [dateB]) => dateA.localeCompare(dateB)
            );

            for (const [dateKey, data] of sortedEntries) {
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
                        const newLow =
                            existing.lowTariffKwh + data.lowTariffKwh;
                        const newHigh =
                            existing.highTariffKwh + data.highTariffKwh;

                        await this.db
                            .update(dailyConsumption)
                            .set({
                                lowTariffKwh: newLow,
                                highTariffKwh: newHigh,
                                lastProcessedTimestamp:
                                    data.lastProcessedTimestamp,
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
                            lastProcessedTimestamp: data.lastProcessedTimestamp,
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
                } daily aggregate(s) with per-day timestamps.`
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

    async getDailyConsumption(
        deviceId: string,
        startDate: string,
        endDate: string
    ) {
        try {
            // Fetch daily consumption data, ordered by date
            const result = await this.db
                .select({
                    date: dailyConsumption.date,
                    lowTariffKwh: dailyConsumption.lowTariffKwh,
                    highTariffKwh: dailyConsumption.highTariffKwh,
                })
                .from(dailyConsumption)
                .where(
                    and(
                        eq(dailyConsumption.deviceId, deviceId),
                        sql`${dailyConsumption.date} >= ${startDate}`,
                        sql`${dailyConsumption.date} <= ${endDate}`
                    )
                )
                .orderBy(sql`${dailyConsumption.date} DESC`)
                .limit(30); // Maximum 30 days

            // Transform the data for better graph compatibility
            return {
                deviceId,
                period: { start: startDate, end: endDate },
                dailyData: result.map((row) => ({
                    date: row.date,
                    low: row.lowTariffKwh,
                    high: row.highTariffKwh,
                    total: row.lowTariffKwh + row.highTariffKwh,
                })),
                totalDays: result.length,
                summary: {
                    totalLow: result.reduce(
                        (sum, row) => sum + row.lowTariffKwh,
                        0
                    ),
                    totalHigh: result.reduce(
                        (sum, row) => sum + row.highTariffKwh,
                        0
                    ),
                    grandTotal: result.reduce(
                        (sum, row) =>
                            sum + row.lowTariffKwh + row.highTariffKwh,
                        0
                    ),
                    averageLow:
                        result.length > 0
                            ? result.reduce(
                                  (sum, row) => sum + row.lowTariffKwh,
                                  0
                              ) / result.length
                            : 0,
                    averageHigh:
                        result.length > 0
                            ? result.reduce(
                                  (sum, row) => sum + row.highTariffKwh,
                                  0
                              ) / result.length
                            : 0,
                    averageTotal:
                        result.length > 0
                            ? result.reduce(
                                  (sum, row) =>
                                      sum +
                                      row.lowTariffKwh +
                                      row.highTariffKwh,
                                  0
                              ) / result.length
                            : 0,
                },
            };
        } catch (e) {
            console.error("Failed to query daily consumption data:", e);
            throw e;
        }
    }

    async getAllDailyConsumption(startDate: string, endDate: string) {
        try {
            // Fetch daily consumption data for all devices, ordered by date
            const result = await this.db
                .select({
                    date: dailyConsumption.date,
                    deviceId: dailyConsumption.deviceId,
                    lowTariffKwh: dailyConsumption.lowTariffKwh,
                    highTariffKwh: dailyConsumption.highTariffKwh,
                })
                .from(dailyConsumption)
                .where(
                    and(
                        sql`${dailyConsumption.date} >= ${startDate}`,
                        sql`${dailyConsumption.date} <= ${endDate}`
                    )
                )
                .orderBy(sql`${dailyConsumption.date} DESC`)
                .limit(30); // Maximum 30 days across all devices

            // Group by date and aggregate across all devices
            const dailyAggregates: Record<
                string,
                { low: number; high: number; devices: string[] }
            > = {};

            for (const row of result) {
                if (!dailyAggregates[row.date]) {
                    dailyAggregates[row.date] = {
                        low: 0,
                        high: 0,
                        devices: [],
                    };
                }
                dailyAggregates[row.date].low += row.lowTariffKwh;
                dailyAggregates[row.date].high += row.highTariffKwh;
                if (!dailyAggregates[row.date].devices.includes(row.deviceId)) {
                    dailyAggregates[row.date].devices.push(row.deviceId);
                }
            }

            // Convert to array and sort by date
            const dailyData = Object.entries(dailyAggregates)
                .map(([date, data]) => ({
                    date,
                    low: data.low,
                    high: data.high,
                    total: data.low + data.high,
                    devicesCount: data.devices.length,
                }))
                .sort((a, b) => b.date.localeCompare(a.date)); // Sort by date descending

            return {
                period: { start: startDate, end: endDate },
                dailyData,
                totalDays: dailyData.length,
                summary: {
                    totalLow: dailyData.reduce((sum, row) => sum + row.low, 0),
                    totalHigh: dailyData.reduce(
                        (sum, row) => sum + row.high,
                        0
                    ),
                    grandTotal: dailyData.reduce(
                        (sum, row) => sum + row.total,
                        0
                    ),
                    averageLow:
                        dailyData.length > 0
                            ? dailyData.reduce((sum, row) => sum + row.low, 0) /
                              dailyData.length
                            : 0,
                    averageHigh:
                        dailyData.length > 0
                            ? dailyData.reduce(
                                  (sum, row) => sum + row.high,
                                  0
                              ) / dailyData.length
                            : 0,
                    averageTotal:
                        dailyData.length > 0
                            ? dailyData.reduce(
                                  (sum, row) => sum + row.total,
                                  0
                              ) / dailyData.length
                            : 0,
                },
            };
        } catch (e) {
            console.error("Failed to query all daily consumption data:", e);
            throw e;
        }
    }
}
