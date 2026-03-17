// Price era effective dates — sorted ascending
// Used to split consumption by pricing period
export const PRICE_ERA_DATES = ["2025-01-01", "2026-01-01"];

// Returns the effective date for a given day
export function getEraForDate(date: string): string {
    let era = PRICE_ERA_DATES[0];
    for (const eraDate of PRICE_ERA_DATES) {
        if (date >= eraDate) {
            era = eraDate;
        } else {
            break;
        }
    }
    return era;
}
