import { createServer, type RequestListener } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

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
    const requestedPort = Number(process.env.WEB_PORT ?? 3000);
    const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535 ? requestedPort : 3000;
    return createStardustServer({ host: process.env.WEB_HOST || "127.0.0.1", port });
}
