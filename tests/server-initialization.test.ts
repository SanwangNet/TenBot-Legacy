import assert from "node:assert/strict";
import test from "node:test";
import { createStardustServer } from "../apps/server/bootstrap.js";
import { readdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("initialization server exposes health while locking management", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stardust-static-"));
    await writeFile(join(dir, "index.html"), "<main>setup fixture</main>");
    const server = await createStardustServer({ host: "127.0.0.1", port: 0, configured: false, staticDirectory: dir });
    const url = `http://127.0.0.1:${server.address.port}`;
    try {
        const health = await fetch(`${url}/api/health`);
        assert.deepEqual(await health.json(), { ok: true, state: "needs-setup", initialized: false, qq: null });
        assert.match(await (await fetch(`${url}/`)).text(), /setup fixture/);
        for (const [path, method] of [["/api/status", "GET"], ["/api/config", "PATCH"], ["/api/auth/me", "GET"]]) {
            assert.equal((await fetch(`${url}${path}`, { method })).status, 503);
        }
    } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Web and core do not import QQ or backend internals", async () => {
    async function inspect(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await inspect(path);
            else if (/\.tsx?$/.test(entry.name)) {
                const source = await readFile(path, "utf8");
                assert.doesNotMatch(source, /(?:@tencent-connect\/qqbot-nodejs|src\/(?:qq|control|runtime|ai)\/)/, path);
            }
        }
    }
    await inspect(resolve("web/src"));
    await inspect(resolve("packages/core/src"));
});

test("HTTP survives delayed and failed runtime initialization", async () => {
    let rejectRuntime!: (error: Error) => void;
    const pending = new Promise<import("../src/runtime.js").TenBotRuntime>((_, reject) => { rejectRuntime = reject; });
    const server = await createStardustServer({ port: 0, configured: true, createRuntime: () => pending });
    const url = `http://127.0.0.1:${server.address.port}`;
    try {
        assert.equal((await (await fetch(`${url}/api/health`)).json()).state, "initializing");
        assert.equal((await fetch(`${url}/api/config`, { method: "PATCH" })).status, 503);
        rejectRuntime(new Error("test"));
        for (let i = 0; i < 50 && String(server.getState()) !== "degraded"; i++) await new Promise((r) => setTimeout(r, 10));
        assert.equal((await (await fetch(`${url}/api/health`)).json()).state, "degraded");
    } finally { await server.close(); }
});

test("shutdown during initialization ignores and cleans a late runtime", async () => {
    let finish!: (runtime: import("../src/runtime.js").TenBotRuntime) => void;
    const pending = new Promise<import("../src/runtime.js").TenBotRuntime>((resolve) => { finish = resolve; });
    let stops = 0;
    const server = await createStardustServer({ port: 0, configured: true, createRuntime: () => pending });
    await server.close();
    finish({ control: { async shutdown() { stops++; } }, async start() { throw new Error("must not start"); }, handleHttp() {} } as unknown as import("../src/runtime.js").TenBotRuntime);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stops, 1);
    assert.equal(server.getState(), "stopping");
    await server.close();
});

test("shutdown aborts cooperative runtime initialization", async () => {
    let seen: AbortSignal | undefined;
    const server = await createStardustServer({ port: 0, configured: true, createRuntime: (signal) => {
        seen = signal;
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } });
    await new Promise((resolve) => setImmediate(resolve));
    await server.close();
    assert.equal(seen?.aborted, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.getState(), "stopping");
});

test("runtime attaches to the same HTTP listener with existing auth gate", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { createTenBotRuntime } = await import("../src/runtime.js");
    const dir = await mkdtemp(join(tmpdir(), "stardust-http-"));
    const envPath = join(dir, ".env");
    await writeFile(envPath, "QQBOT_APP_ID=\nQQBOT_APP_SECRET=\n");
    const server = await createStardustServer({ port: 0, configured: true, createRuntime: () => createTenBotRuntime({ envPath, environment: {}, databasePath: join(dir, "bot.db"), logDirectory: join(dir, "logs"), consoleLogs: false, externalHttp: true }) });
    const url = `http://127.0.0.1:${server.address.port}`;
    try {
        for (let i = 0; i < 100 && String(server.getState()) === "initializing"; i++) await new Promise((r) => setTimeout(r, 20));
        assert.equal(server.getState(), "ready");
        const health = await (await fetch(`${url}/api/health`)).json();
        assert.equal(health.state, "ready");
        assert.equal(health.qq, "unconfigured");
        assert.ok([401, 503].includes((await fetch(`${url}/api/config`)).status));
    } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
