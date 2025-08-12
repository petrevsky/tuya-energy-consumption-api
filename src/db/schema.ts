import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";

export const households = sqliteTable("Households", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .$default(() => new Date()),
});

export const invoicePeriods = sqliteTable("InvoicePeriods", {
    id: integer("id").primaryKey(),
    householdId: integer("household_id")
        .notNull()
        .references(() => households.id),
    fromDate: text("from_date").notNull(), // ISO date string (YYYY-MM-DD)
    toDate: text("to_date").notNull(), // ISO date string (YYYY-MM-DD)
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .$default(() => new Date()),
});

export const devices = sqliteTable("Devices", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    householdId: integer("household_id").references(() => households.id),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .$default(() => new Date()),
});

export const dailyConsumption = sqliteTable("DailyConsumption", {
    id: integer("id").primaryKey(),
    date: text("date").notNull(),
    deviceId: text("device_id")
        .notNull()
        .references(() => devices.id),
    lowTariffKwh: real("low_tariff_kwh").notNull().default(0),
    highTariffKwh: real("high_tariff_kwh").notNull().default(0),
    lastProcessedTimestamp: integer("last_processed_timestamp").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
        .notNull()
        .$default(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
        .notNull()
        .$default(() => new Date()),
});

// Create a unique index on date + device_id combination
export const dailyConsumptionUniqueIndex = {
    name: "unique_date_device",
    columns: [dailyConsumption.date, dailyConsumption.deviceId],
    unique: true,
};

export type Household = typeof households.$inferSelect;
export type NewHousehold = typeof households.$inferInsert;
export type InvoicePeriod = typeof invoicePeriods.$inferSelect;
export type NewInvoicePeriod = typeof invoicePeriods.$inferInsert;
export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type DailyConsumption = typeof dailyConsumption.$inferSelect;
export type NewDailyConsumption = typeof dailyConsumption.$inferInsert;
