interface TuyaCredentials {
    clientId: string;
    secret: string;
    deviceId: string;
    baseUrl: string;
}

interface TuyaLogEntry {
    code: string;
    event_time: number;
    value: string;
}

interface TuyaLogResult {
    logs: TuyaLogEntry[];
    has_next?: boolean;
    next_row_key?: string;
}

interface TuyaApiResponse {
    success: boolean;
    result: TuyaLogResult;
    fetches?: number;
}

interface TuyaTokenResponse {
    success: boolean;
    result: {
        access_token: string;
    };
}

export class TuyaApiService {
    private credentials: TuyaCredentials;

    constructor(credentials: TuyaCredentials) {
        this.credentials = credentials;
    }

    private async sha256Hash(data: string): Promise<string> {
        const encoder = new TextEncoder();
        const dataBuffer = encoder.encode(data);
        const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    private createStringToSign(
        method: string,
        url: string,
        body: string = ""
    ): string {
        // HTTPMethod
        const httpMethod = method.toUpperCase();

        // Content-SHA256 (for empty body)
        const contentSha256 = body
            ? "" // We'll calculate this async if needed
            : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

        // Optional_Signature_key (empty for basic requests)
        const optionalSignatureKey = "";

        // Parse URL and sort query parameters
        const urlObj = new URL(url);
        const path = urlObj.pathname;

        // Sort parameters alphabetically
        const sortedParams = Array.from(urlObj.searchParams.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join("&");

        const urlWithParams = sortedParams ? `${path}?${sortedParams}` : path;

        // Create stringToSign
        return `${httpMethod}\n${contentSha256}\n${optionalSignatureKey}\n${urlWithParams}`;
    }

    private async generateSignature(
        t: string,
        nonce: string,
        stringToSign: string,
        accessToken?: string
    ): Promise<string> {
        const strToHash = accessToken
            ? `${this.credentials.clientId}${accessToken}${t}${nonce}${stringToSign}`
            : `${this.credentials.clientId}${t}${nonce}${stringToSign}`;

        const encoder = new TextEncoder();
        const secretKey = encoder.encode(this.credentials.secret);
        const message = encoder.encode(strToHash);

        const cryptoKey = await crypto.subtle.importKey(
            "raw",
            secretKey,
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"]
        );

        const signature = await crypto.subtle.sign("HMAC", cryptoKey, message);
        const hashArray = Array.from(new Uint8Array(signature));
        return hashArray
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
            .toUpperCase();
    }

    private generateNonce(): string {
        return crypto.randomUUID();
    }

    private getCurrentTimestamp(): string {
        return Date.now().toString();
    }

    async getAccessToken(): Promise<string> {
        const tokenUrl = `${this.credentials.baseUrl}/v1.0/token?grant_type=1`;
        const t = this.getCurrentTimestamp();
        const nonce = this.generateNonce();

        const stringToSign = this.createStringToSign("GET", tokenUrl);
        const signature = await this.generateSignature(t, nonce, stringToSign);

        const headers = {
            client_id: this.credentials.clientId,
            t: t,
            sign: signature,
            sign_method: "HMAC-SHA256",
            nonce: nonce,
        };

        const response = await fetch(tokenUrl, { headers });
        const responseData: TuyaTokenResponse = await response.json();

        if (responseData.success) {
            return responseData.result.access_token;
        } else {
            throw new Error(
                `Failed to get access token: ${JSON.stringify(responseData)}`
            );
        }
    }

    async getDeviceLogs(
        accessToken: string,
        deviceId: string,
        options: {
            start?: number | null;
            end?: number | null;
            evtype?: string;
            size?: number;
            maxFetches?: number;
            startRowKey?: string;
            params?: Record<string, any>;
        } = {}
    ): Promise<TuyaApiResponse> {
        const {
            start = null,
            end = null,
            evtype = "1,2,3,4,5,6,7,8,9,10",
            size = 0,
            maxFetches = 50,
            startRowKey,
            params = {},
        } = options;

        // Handle time calculations (server expects unixtime * 1000)
        const now = Date.now();

        let endTime: number;
        if (!end) {
            endTime = now;
        } else if (end < 0) {
            endTime = Math.floor((Date.now() / 1000 + end * 86400) * 1000);
        } else if (end === 0) {
            endTime = now;
        } else {
            endTime = end < 1e10 ? Math.floor(end * 1000) : Math.floor(end);
        }

        let startTime: number;
        if (!start) {
            startTime = endTime - 86400 * 1000; // 1 day ago
        } else if (start < 0) {
            startTime = Math.floor((Date.now() / 1000 + start * 86400) * 1000);
        } else {
            startTime =
                start < 1e10 ? Math.floor(start * 1000) : Math.floor(start);
        }

        // Ensure start < end
        if (startTime > endTime) {
            [startTime, endTime] = [endTime, startTime];
        }

        const wantSize = size;
        const requestSize = !size || size > 100 ? 100 : size;
        let maxFetchesRemaining =
            maxFetches && maxFetches >= 1 ? maxFetches : 50;

        const deviceLogsUrl = `${this.credentials.baseUrl}/v1.0/devices/${deviceId}/logs`;

        // Prepare base parameters
        const baseParams = new URLSearchParams({
            start_time: startTime.toString(),
            end_time: endTime.toString(),
            type: evtype,
            size: requestSize.toString(),
            query_type: "1",
            ...params,
        });

        if (startRowKey) {
            baseParams.set("start_row_key", startRowKey);
        }

        // Make first request
        const t = this.getCurrentTimestamp();
        const nonce = this.generateNonce();

        const fullUrl = `${deviceLogsUrl}?${baseParams.toString()}`;
        const stringToSign = this.createStringToSign("GET", fullUrl);
        const signature = await this.generateSignature(
            t,
            nonce,
            stringToSign,
            accessToken
        );

        const headers = {
            client_id: this.credentials.clientId,
            t: t,
            sign: signature,
            sign_method: "HMAC-SHA256",
            nonce: nonce,
            access_token: accessToken,
        };

        const response = await fetch(
            `${deviceLogsUrl}?${baseParams.toString()}`,
            { headers }
        );
        const ret: TuyaApiResponse = await response.json();

        if (!ret.success) {
            throw new Error(
                `Failed to get device logs: ${JSON.stringify(ret)}`
            );
        }

        maxFetchesRemaining -= 1;
        let fetches = 1;

        if (ret.result) {
            let result = ret.result;
            let nextRowKey = "";

            console.log(
                `Fetched ${result.logs?.length || 0} logs in first request`
            );

            // Continue fetching while we have more data and haven't reached limits
            while (
                maxFetchesRemaining > 0 &&
                result.logs &&
                result.has_next &&
                (!wantSize || result.logs.length < wantSize) &&
                result.next_row_key &&
                nextRowKey !== result.next_row_key
            ) {
                maxFetchesRemaining -= 1;
                fetches += 1;
                nextRowKey = result.next_row_key;

                // Update params for next request
                baseParams.set("start_row_key", nextRowKey);

                // Make next request
                const nextT = this.getCurrentTimestamp();
                const nextNonce = this.generateNonce();

                const nextFullUrl = `${deviceLogsUrl}?${baseParams.toString()}`;
                const nextStringToSign = this.createStringToSign(
                    "GET",
                    nextFullUrl
                );
                const nextSignature = await this.generateSignature(
                    nextT,
                    nextNonce,
                    nextStringToSign,
                    accessToken
                );

                const nextHeaders = {
                    client_id: this.credentials.clientId,
                    t: nextT,
                    sign: nextSignature,
                    sign_method: "HMAC-SHA256",
                    nonce: nextNonce,
                    access_token: accessToken,
                };

                const nextResponse = await fetch(
                    `${deviceLogsUrl}?${baseParams.toString()}`,
                    { headers: nextHeaders }
                );
                const nextRes: TuyaApiResponse = await nextResponse.json();

                if (nextRes.result) {
                    const result2 = nextRes.result;
                    if (result2.logs) {
                        result.logs = result.logs.concat(result2.logs);
                        console.log(
                            `Fetched ${result2.logs.length} more logs, total so far: ${result.logs.length}`
                        );
                    }
                    if (result2.has_next !== undefined) {
                        result.has_next = result2.has_next;
                    }
                    if (result2.next_row_key) {
                        result.next_row_key = result2.next_row_key;
                    }
                } else {
                    break;
                }
            }

            ret.fetches = fetches;
        }

        return ret;
    }

    async getDeviceLogConvenience(
        deviceId: string,
        options: {
            start?: number | null;
            end?: number | null;
            evtype?: string;
            size?: number;
            maxFetches?: number;
            startRowKey?: string;
            params?: Record<string, any>;
        } = {}
    ): Promise<TuyaApiResponse> {
        console.log("Getting access token...");
        const accessToken = await this.getAccessToken();
        console.log("✓ Access token obtained");

        console.log(
            `Fetching device logs (deviceid=${deviceId}, start=${options.start}, end=${options.end}, size=${options.size})...`
        );
        return this.getDeviceLogs(accessToken, deviceId, options);
    }
}

export type { TuyaLogEntry, TuyaLogResult, TuyaApiResponse };
