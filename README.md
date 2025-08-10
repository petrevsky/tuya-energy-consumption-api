# Energy Monitor - Tuya IoT Energy Consumption Tracker

This is a Cloudflare Workers application built with Hono framework that monitors energy consumption from Tuya IoT devices, processes the data according to North Macedonia tariff rules, and stores it in a D1 database using Drizzle ORM.

## Features

-   **Automated Data Collection**: Scheduled CRON job (every 4 hours) fetches energy logs from Tuya API
-   **Tariff Classification**: Automatically categorizes consumption into low/high tariff based on North Macedonia electricity pricing
-   **Device Management**: Support for multiple devices with custom names
-   **REST API**: Query consumption data for specific periods and devices
-   **Database**: Uses Cloudflare D1 (SQLite) with Drizzle ORM

## Tariff Rules (North Macedonia)

The system implements the following tariff classification:

-   **Low Tariff**:
    -   Weekend: Saturday 22:00 to Monday 07:00
    -   Daily: 13:00 - 15:00
    -   Nightly: 22:00 - 07:00
-   **High Tariff**: All other times

## Setup

### Prerequisites

-   Node.js 18+ and pnpm
-   Cloudflare account with Workers enabled
-   Tuya IoT Platform account with API credentials

### Installation

1. **Install dependencies**:

```bash
pnpm install
```

2. **Set up Cloudflare credentials**:

```bash
pnpm wrangler login
```

3. **Database is already created and configured**:

    - **Database ID**: `2f5e4889-e11e-43d8-87d4-34b968d3b377`
    - **Database Name**: `energy-monitor-db`
    - **Migrations**: Already applied to both local and remote databases

4. **Update environment variables in `wrangler.jsonc`** (if needed):
    - `TUYA_CLIENT_ID`: Your Tuya API client ID
    - `TUYA_SECRET`: Your Tuya API secret
    - `TUYA_DEVICE_ID`: Your energy meter device ID
    - `TUYA_BASE_URL`: Tuya API base URL (default: https://openapi.tuyaeu.com)

### Development

Start the development server:

```bash
pnpm run dev
```

The server will be available at http://localhost:8787

### Deployment

Deploy to Cloudflare Workers:

```bash
pnpm run deploy
```

## API Endpoints

### Base URL

-   Development: `http://localhost:8787`
-   Production: `https://energy-monitor.your-subdomain.workers.dev`

### Core Endpoints

-   **`GET /`** - API status and information
-   **`GET /run-manual`** - Manually trigger energy log processing (for testing)

### Device Management

-   **`POST /devices`** - Create a new device

    ```json
    {
        "id": "device_id_from_tuya",
        "name": "Kitchen Energy Meter"
    }
    ```

-   **`GET /devices`** - List all devices
-   **`GET /devices/:id`** - Get specific device details

### Energy Consumption

-   **`GET /consumption?start=2025-01-01&end=2025-01-31`** - Get total consumption for all devices
-   **`GET /consumption/:deviceId?start=2025-01-01&end=2025-01-31`** - Get consumption for specific device

Response format:

```json
{
    "totalLow": 145.67,
    "totalHigh": 89.23
}
```

## Database Schema

### Devices Table

-   `id` (TEXT PRIMARY KEY) - Tuya device ID
-   `name` (TEXT) - Human-readable device name
-   `created_at` (INTEGER) - Timestamp

### DailyConsumption Table

-   `id` (INTEGER PRIMARY KEY) - Auto-increment ID
-   `date` (TEXT) - Date in YYYY-MM-DD format
-   `device_id` (TEXT) - Reference to device
-   `low_tariff_kwh` (REAL) - kWh consumed during low tariff periods
-   `high_tariff_kwh` (REAL) - kWh consumed during high tariff periods
-   `last_processed_timestamp` (INTEGER) - Last processed Tuya log timestamp
-   `created_at`, `updated_at` (INTEGER) - Timestamps

## CRON Schedule

The system automatically runs every 4 hours:

```json
"triggers": {
  "crons": ["0 */4 * * *"]
}
```

## Project Structure

```
energy-monitor/
├── src/
│   ├── index.ts                    # Main Hono application
│   ├── db/
│   │   ├── index.ts               # Database connection setup
│   │   ├── schema.ts              # Drizzle ORM schemas
│   │   └── migrations/
│   │       └── 001_initial.sql   # Database initialization
│   └── services/
│       ├── tuya-api.ts            # Tuya API client (TypeScript port)
│       └── energy-processor.ts    # Energy processing logic
├── drizzle.config.ts              # Drizzle configuration
├── wrangler.jsonc                 # Cloudflare Workers config
├── tsconfig.json                  # TypeScript configuration
└── package.json                   # Dependencies and scripts
```

## Architecture

The application follows a clean architecture pattern:

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────────┐
│   Tuya API      │◄───┤ CRON Job     │───►│ D1 Database     │
│                 │    │ (Every 1h)   │    │ (SQLite)        │
└─────────────────┘    └──────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌──────────────┐
                       │ Hono API     │
                       │ Endpoints    │
                       └──────────────┘
```

### Key Components

1. **`TuyaApiService`** - TypeScript port of the Python Tuya API client with proper crypto support
2. **`EnergyProcessor`** - Business logic for processing energy data and tariff classification
3. **`NorthMacedoniaTariffRules`** - Implements specific tariff rules for North Macedonia
4. **Drizzle ORM** - Type-safe database operations with D1

## Current Configuration

### Environment Variables (wrangler.jsonc):

```json
{
    "vars": {
        "TUYA_CLIENT_ID": "yqf8fqdpb3ms2kupppv0",
        "TUYA_SECRET": "d612e48fb1ab462bbf7713cb8bf4c99f",
        "TUYA_DEVICE_ID": "bfaa7a61cd379c04c9arlz",
        "TUYA_BASE_URL": "https://openapi.tuyaeu.com"
    }
}
```

### Default Device:

-   **ID**: `bfaa7a61cd379c04c9arlz`
-   **Name**: `Main Energy Meter`

## Usage Examples

### 1. Test Manual Processing

```bash
curl http://localhost:8787/run-manual
```

### 2. Add a New Device

```bash
curl -X POST http://localhost:8787/devices \
  -H "Content-Type: application/json" \
  -d '{"id": "new-device-123", "name": "Living Room Meter"}'
```

### 3. Get Monthly Consumption for Specific Device

```bash
curl "http://localhost:8787/consumption/bfaa7a61cd379c04c9arlz?start=2025-01-01&end=2025-01-31"
```

### 4. Get Total Consumption (All Devices)

```bash
curl "http://localhost:8787/consumption?start=2025-01-01&end=2025-01-31"
```

### 5. List All Devices

```bash
curl http://localhost:8787/devices
```

## Database Management

### Generate New Migrations

```bash
pnpm run db:generate
```

### Apply Migrations

```bash
# Local development database
pnpm exec wrangler d1 execute energy-monitor-db --file=./src/db/migrations/001_initial.sql

# Production database
pnpm exec wrangler d1 execute energy-monitor-db --remote --file=./src/db/migrations/001_initial.sql
```

### Query Database Directly

```bash
# Local database
pnpm exec wrangler d1 execute energy-monitor-db --command "SELECT * FROM Devices;"

# Remote database
pnpm exec wrangler d1 execute energy-monitor-db --remote --command "SELECT * FROM DailyConsumption ORDER BY date DESC LIMIT 10;"
```

## Troubleshooting

### Common Issues

1. **"No new logs" message**: Normal if system has processed all available logs
2. **Database connection errors**: Ensure D1 database exists and migrations are applied
3. **Tuya API errors**: Verify API credentials and device ID are correct
4. **CRON not triggering**: Deploy to production - CRON only works in deployed Workers

### Debug Commands

```bash
# Check if development server is running
curl http://localhost:8787/

# Check database tables
pnpm exec wrangler d1 execute energy-monitor-db --command ".tables"

# Check recent consumption data
pnpm exec wrangler d1 execute energy-monitor-db --command "SELECT * FROM DailyConsumption ORDER BY created_at DESC LIMIT 5;"
```

## Development Tools

-   **TypeScript**: Full type safety with Cloudflare Workers types
-   **Hono**: Fast, lightweight web framework
-   **Drizzle ORM**: Type-safe database operations
-   **Wrangler**: Cloudflare Workers development and deployment

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test locally with `pnpm run dev`
5. Submit a pull request

## License

MIT License
