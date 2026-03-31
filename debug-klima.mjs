// Local diagnostic script — run with: node debug-klima.mjs

const TUYA_CLIENT_ID = process.env.TUYA_CLIENT_ID;
const TUYA_SECRET = process.env.TUYA_SECRET;
const TUYA_BASE_URL = process.env.TUYA_BASE_URL || "https://openapi.tuyaeu.com";
const KLIMA_DEVICE_ID = "bfaa7a61cd379c04c9arlz";

async function sha256(data) {
    const enc = new TextEncoder();
    const hash = await crypto.subtle.digest("SHA-256", enc.encode(data));
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSign(secret, message) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function createStringToSign(method, url) {
    const urlObj = new URL(url);
    const sortedParams = Array.from(urlObj.searchParams.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`).join("&");
    const path = sortedParams ? `${urlObj.pathname}?${sortedParams}` : urlObj.pathname;
    return `${method}\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n\n${path}`;
}

async function tuyaGet(path, token) {
    const url = `${TUYA_BASE_URL}${path}`;
    const t = Date.now().toString();
    const nonce = crypto.randomUUID();
    const strToSign = createStringToSign("GET", url);
    const strToHash = token
        ? `${TUYA_CLIENT_ID}${token}${t}${nonce}${strToSign}`
        : `${TUYA_CLIENT_ID}${t}${nonce}${strToSign}`;
    const sign = await hmacSign(TUYA_SECRET, strToHash);

    const headers = { client_id: TUYA_CLIENT_ID, t, sign, sign_method: "HMAC-SHA256", nonce };
    if (token) headers.access_token = token;

    const res = await fetch(url, { headers });
    return res.json();
}

async function getToken() {
    const res = await tuyaGet("/v1.0/token?grant_type=1");
    if (!res.success) throw new Error(`Token failed: ${JSON.stringify(res)}`);
    return res.result.access_token;
}

async function main() {
    console.log("Getting access token...");
    const token = await getToken();
    console.log("✓ Token obtained\n");

    // 1. Device details
    console.log("=== DEVICE DETAILS ===");
    const details = await tuyaGet(`/v2.0/cloud/thing/${KLIMA_DEVICE_ID}`, token);
    if (details.success) {
        console.log(JSON.stringify(details.result, null, 2));
    } else {
        console.log(`  Error: ${JSON.stringify(details)}`);
    }

    // 2. Recent logs (last 7 days) — all event types
    console.log("\n=== RECENT LOGS (last 7 days, all types) ===");
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 86400 * 1000;
    const params = new URLSearchParams({
        start_time: sevenDaysAgo.toString(),
        end_time: now.toString(),
        type: "1,2,3,4,5,6,7,8,9,10",
        size: "100",
        query_type: "1",
    });
    const logs = await tuyaGet(`/v1.0/devices/${KLIMA_DEVICE_ID}/logs?${params}`, token);
    if (logs.success) {
        const allLogs = logs.result.logs || [];
        console.log(`  Total logs: ${allLogs.length}`);
        const codes = [...new Set(allLogs.map(l => l.code))];
        console.log(`  Codes found: ${codes.join(", ") || "(none)"}`);
        const addEle = allLogs.filter(l => l.code === "add_ele");
        console.log(`  add_ele logs: ${addEle.length}`);
        if (allLogs.length > 0) {
            console.log("\n  First 10 logs:");
            allLogs.slice(0, 10).forEach(l => {
                console.log(`    ${new Date(l.event_time).toISOString()} | ${l.code} = ${l.value}`);
            });
        }
    } else {
        console.log(`  Error: ${JSON.stringify(logs)}`);
    }

    // 3. Logs around cutoff date (Feb 10-16)
    console.log("\n=== LOGS AROUND CUTOFF (Feb 10-16, 2026) ===");
    const feb10 = new Date("2026-02-10T00:00:00Z").getTime();
    const feb16 = new Date("2026-02-16T00:00:00Z").getTime();
    const params2 = new URLSearchParams({
        start_time: feb10.toString(),
        end_time: feb16.toString(),
        type: "7",
        size: "100",
        query_type: "1",
    });
    const cutoff = await tuyaGet(`/v1.0/devices/${KLIMA_DEVICE_ID}/logs?${params2}`, token);
    if (cutoff.success) {
        const cutLogs = (cutoff.result.logs || []).filter(l => l.code === "add_ele");
        console.log(`  add_ele logs: ${cutLogs.length}`);
        if (cutLogs.length > 0) {
            const last = cutLogs[cutLogs.length - 1];
            const first = cutLogs[0];
            console.log(`  First: ${new Date(first.event_time).toISOString()} = ${first.value}`);
            console.log(`  Last:  ${new Date(last.event_time).toISOString()} = ${last.value}`);
        }
    } else {
        console.log(`  Error: ${JSON.stringify(cutoff)}`);
    }

    // 4. Check last 30 days for any add_ele
    console.log("\n=== LAST 30 DAYS add_ele CHECK ===");
    const thirtyDaysAgo = now - 30 * 86400 * 1000;
    const params3 = new URLSearchParams({
        start_time: thirtyDaysAgo.toString(),
        end_time: now.toString(),
        type: "7",
        size: "100",
        query_type: "1",
    });
    const last30 = await tuyaGet(`/v1.0/devices/${KLIMA_DEVICE_ID}/logs?${params3}`, token);
    if (last30.success) {
        const eleLogs = (last30.result.logs || []).filter(l => l.code === "add_ele");
        console.log(`  add_ele logs in last 30 days: ${eleLogs.length}`);
        if (eleLogs.length > 0) {
            console.log(`  Most recent: ${new Date(eleLogs[0].event_time).toISOString()} = ${eleLogs[0].value}`);
            console.log(`  Oldest:      ${new Date(eleLogs[eleLogs.length - 1].event_time).toISOString()} = ${eleLogs[eleLogs.length - 1].value}`);
        }
    } else {
        console.log(`  Error: ${JSON.stringify(last30)}`);
    }
}

main().catch(console.error);
