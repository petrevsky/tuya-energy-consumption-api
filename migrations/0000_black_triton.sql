-- Create Devices table
CREATE TABLE IF NOT EXISTS Devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Create DailyConsumption table
CREATE TABLE IF NOT EXISTS DailyConsumption (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    device_id TEXT NOT NULL,
    low_tariff_kwh REAL NOT NULL DEFAULT 0,
    high_tariff_kwh REAL NOT NULL DEFAULT 0,
    last_processed_timestamp INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    FOREIGN KEY (device_id) REFERENCES Devices(id),
    UNIQUE(date, device_id)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_daily_consumption_date ON DailyConsumption(date);
CREATE INDEX IF NOT EXISTS idx_daily_consumption_device_id ON DailyConsumption(device_id);
CREATE INDEX IF NOT EXISTS idx_daily_consumption_date_device ON DailyConsumption(date, device_id);

-- Insert default device
INSERT OR IGNORE INTO Devices (id, name) VALUES ('bfaa7a61cd379c04c9arlz', 'Main Energy Meter');
