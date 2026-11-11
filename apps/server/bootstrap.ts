import { createServer, type RequestListener } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { createStardustConfigService } from "../../packages/config/src/stardust.js";

export type ServerState = "starting" | "ready" | "stopping";
export interface ServerOptions {
    host?: string;
    port?: number;
    staticDirectory?: string;
    /** Legacy test inputs are accepted but never used to start business services. */
    configured?: boolean;
    createRuntime?: (signal: AbortSignal) => Promise<unknown>;
    passwordFile?: string;
    passwordOrigin?: string;
    authEnvironment?: NodeJS.ProcessEnv;
    configPath?: string;
    envPath?: string;
    environment?: NodeJS.ProcessEnv;
}
export interface StardustServer {
    address: { host: string; port: number };
    getState(): ServerState;
    close(): Promise<void>;
}

export async function createStardustServer(options: ServerOptions = {}): Promise<StardustServer> {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 3000;
    const root = resolve(options.staticDirectory ?? "web/dist");
    const environment = options.environment ?? process.env;
    const config = createStardustConfigService({ configPath: options.configPath, envPath: options.envPath, environment });
    let state: ServerState = "starting";
    let closePromise: Promise<void> | undefined;
    const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".png": "image/png", ".woff2": "font/woff2" };
    const listener: RequestListener = (request, response) => {
        let pathname: string;
        try { pathname = new URL(request.url ?? "/", "http://localhost").pathname; }
        catch { response.writeHead(400); response.end(); return; }
        response.setHeader("X-Content-Type-Options", "nosniff");
        if (pathname === "/api/health" && request.method === "GET") {
            response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            response.end(JSON.stringify({ ok: state === "ready", state, service: "stardust", legacyApi: "disabled" }));
            return;
        }
        if (pathname === "/api/config" || pathname === "/api/initialization" || pathname === "/api/config/secrets") {
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            const send = (status: number, value: unknown) => { response.writeHead(status); response.end(JSON.stringify(value)); };
            if (request.method === "GET" && pathname !== "/api/config/secrets") {
                void config.snapshot().then((snapshot) => send(200, pathname === "/api/initialization" ? { initialized: snapshot.config.initialized } : snapshot)).catch(() => send(503, { error: "Configuration unavailable" }));
                return;
            }
            const hostHeader = request.headers.host ?? "";
            const origin = request.headers.origin;
            if (!hostHeader || (origin && origin !== `http://${hostHeader}`)) { send(403, { error: "Invalid request origin" }); return; }
            if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) { send(415, { error: "JSON required" }); return; }
            void (async () => {
                try {
                    let body = ""; for await (const chunk of request) { body += String(chunk); if (Buffer.byteLength(body) > 16384) { send(413, { error: "Request too large" }); return; } }
                    const input: unknown = JSON.parse(body);
                    if (!input || typeof input !== "object" || Array.isArray(input)) { send(400, { error: "Invalid request" }); return; }
                    if (pathname === "/api/initialization" && request.method === "POST") {
                        if (Object.keys(input).length || (await config.snapshot()).config.initialized) { send(409, { error: "Already initialized or invalid request" }); return; }
                        send(200, await config.initialize()); return;
                    }
                    if (pathname === "/api/config/secrets" && request.method === "PUT") {
                        if (Object.keys(input).length !== 1 || !("modelApiKey" in input) || typeof input.modelApiKey !== "string") { send(400, { error: "Invalid request" }); return; }
                        send(200, await config.updateSecret(input.modelApiKey)); return;
                    }
                    if (pathname === "/api/config" && request.method === "PATCH") {
                        const allowed = new Set(["service.name", "service.description", "server.host", "server.port", "web.title", "model.provider", "model.model", "model.baseUrl"]);
                        const entries = Object.entries(input); if (!entries.length || entries.some(([key, value]) => !allowed.has(key) || (key === "server.port" ? typeof value !== "number" : typeof value !== "string"))) { send(400, { error: "Invalid request" }); return; }
                        send(200, await config.update(Object.fromEntries(entries))); return;
                    }
                    send(405, { error: "Method not allowed" });
                } catch { send(400, { error: "Configuration update failed" }); }
            })();
            return;
        }
        if (pathname === "/api" || pathname.startsWith("/api/")) {
            response.writeHead(410, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            response.end(JSON.stringify({ error: { message: "Legacy management API is disabled" } }));
            return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); response.end(); return; }
        let decoded: string;
        try { decoded = decodeURIComponent(pathname); } catch { response.writeHead(400); response.end(); return; }
        const file = resolve(root, `.${decoded === "/" || !extname(decoded) ? "/index.html" : decoded}`);
        if (!file.startsWith(root + sep)) { response.writeHead(404); response.end(); return; }
        void readFile(file).then((content) => {
            response.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream" });
            response.end(request.method === "HEAD" ? undefined : content);
        }).catch(() => { response.writeHead(404); response.end(); });
    };
    const server = createServer(listener);
    await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => { server.off("error", reject); done(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Invalid server address");
    state = "ready";
    return {
        address: { host, port: address.port },
        getState: () => state,
        close() {
            if (closePromise) return closePromise;
            state = "stopping";
            closePromise = new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
            return closePromise;
        },
    };
}

export async function startServer(): Promise<StardustServer> {
    try {
        const snapshot = await createStardustConfigService().snapshot();
        return createStardustServer({ host: snapshot.config.server.host, port: snapshot.config.server.port });
    } catch {
        // Invalid configuration never exposes details and leaves the service reachable on safe defaults.
        return createStardustServer({ host: "127.0.0.1", port: 3000 });
    }
}
