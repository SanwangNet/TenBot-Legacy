import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { QQBot } from "@tencent-connect/qqbot-nodejs";
import { createTenBotRuntime } from "../src/runtime.js";
import { createTenBotWebServer } from "../src/control/web-server.js";
import { createQqBot, shutdownQqMessageHandler, type QqConnectionState } from "../src/qq/bot.js";

async function fixture(appId = "", secret = "", behavior: "pending" | "fail" = "pending", realWeb = false) {
    const directory = await mkdtemp(join(tmpdir(), "stardust-lifecycle-"));
    const envPath = join(directory, ".env");
    const env = (id: string, key: string) => `QQBOT_APP_ID=${id}\nQQBOT_APP_SECRET=${key}\n`;
    await writeFile(envPath, env(appId, secret));
    let state: ((state: QqConnectionState) => void) | undefined;
    let created = 0, started = 0, stopped = 0, webStarted = 0, webStopped = 0;
    let rejectStart: ((error: Error) => void) | undefined;
    let webUrl = "";
    const runtime = await createTenBotRuntime({
        consoleLogs: false, logDirectory: join(directory, "logs"), databasePath: join(directory, "bot.db"), envPath,
        environment: {},
        createBot(onState) {
            created++;
            state = onState;
            return {
                start() {
                    started++;
                    if (behavior === "fail") return Promise.reject(new Error("fake connection failure"));
                    return new Promise<void>((_resolve, reject) => { rejectStart = reject; });
                },
                stop() { stopped++; },
            } as QQBot;
        },
        createWebServer(_control, options) {
            if (realWeb) {
                const server = createTenBotWebServer(_control, { ...options, host: "127.0.0.1", port: 0 });
                return {
                    handle: server.handle,
                    async start() {
                        const address = await server.start();
                        webStarted++;
                        webUrl = `http://127.0.0.1:${address.port}`;
                        return address;
                    },
                    async close() { webStopped++; await server.close(); },
                };
            }
            return {
                handle(_request, response) { response.writeHead(503); response.end(); },
                async start() { webStarted++; return { host: options.host, port: options.port }; },
                async close() { webStopped++; },
            };
        },
    });
    return {
        runtime, state: (value: QqConnectionState) => state?.(value),
        counts: () => ({ created, started, stopped, webStarted, webStopped }),
        webUrl: () => webUrl,
        change: async (id: string, key: string) => writeFile(envPath, env(id, key)),
        reject: () => rejectStart?.(new Error("late failure")),
        async close() { await runtime.control.shutdown(); await rm(directory, { recursive: true, force: true }); },
    };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("the existing QQ factory registers message and ready handlers without connecting", () => {
    const spy = mock.method(QQBot.prototype, "on");
    const bot = createQqBot(undefined, undefined, undefined, { appId: "id", appSecret: "secret" });
    try {
        const events = spy.mock.calls.map((call) => call.arguments[0]);
        assert.ok(events.includes("ready"));
        assert.ok(events.includes("message"));
        assert.ok(bot.getMiddlewares().length > 0);
    } finally {
        shutdownQqMessageHandler(bot);
        spy.mock.restore();
    }
});

for (const [id, key] of [["", ""], ["id", ""], ["", "secret"]]) {
    test(`missing QQ credentials (${Boolean(id)}, ${Boolean(key)}) starts Web only`, async () => {
        const f = await fixture(id, key);
        try {
            await f.runtime.start();
            assert.equal(f.runtime.control.getStatus().qq, "unconfigured");
            assert.deepEqual(f.counts(), { created: 0, started: 0, stopped: 0, webStarted: 1, webStopped: 0 });
        } finally { await f.close(); }
    });
}

test("ready and pending connection do not block Web, shutdown ignores late events", async () => {
    const f = await fixture("id", "secret");
    try {
        await f.runtime.start(); await tick();
        assert.equal(f.counts().webStarted, 1);
        assert.equal(f.counts().started, 1);
        assert.equal(f.runtime.control.getStatus().qq, "connecting");
        f.state("connected");
        assert.equal(f.runtime.control.getStatus().qq, "connected");
        await Promise.race([f.runtime.control.shutdown(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shutdown hung")), 2000).unref())]);
        await f.runtime.control.shutdown();
        assert.equal(f.counts().webStopped, 1);
        assert.equal(f.counts().stopped, 1);
        f.state("connected");
        assert.equal(f.runtime.control.getStatus().qq, "disconnected");
        f.reject(); await tick();
        assert.equal(f.runtime.control.getStatus().qq, "disconnected");
    } finally { await f.close(); }
});

test("real Web health remains reachable and management stays locked without QQ and after failure", async () => {
    for (const [id, key, behavior] of [["", "", "pending"], ["id", "secret", "fail"]] as const) {
        const f = await fixture(id, key, behavior, true);
        try {
            await f.runtime.start(); await tick(); await tick();
            const health = await fetch(`${f.webUrl()}/api/health`);
            assert.equal(health.status, 200);
            assert.equal((await health.json()).qq, behavior === "fail" ? "error" : "unconfigured");
            const management = await fetch(`${f.webUrl()}/api/config`);
            assert.ok([401, 503].includes(management.status));
        } finally { await f.close(); }
    }
});

test("startup failure is contained and shutdown is idempotent", async () => {
    const f = await fixture("id", "secret", "fail");
    const rejected: unknown[] = [];
    const onReject = (error: unknown) => rejected.push(error);
    process.on("unhandledRejection", onReject);
    try {
        await f.runtime.start(); await tick(); await tick();
        assert.equal(f.runtime.control.getStatus().qq, "error");
        assert.equal(f.counts().webStarted, 1);
        await f.runtime.control.shutdown(); await f.runtime.control.shutdown();
        assert.equal(f.counts().stopped, 1);
        assert.equal(f.counts().webStopped, 1);
        assert.deepEqual(rejected, []);
    } finally { process.off("unhandledRejection", onReject); await f.close(); }
});

test("shutdown while connecting does not await a stuck SDK promise", async () => {
    const f = await fixture("id", "secret");
    try {
        await f.runtime.start(); await tick();
        assert.equal(f.runtime.control.getStatus().qq, "connecting");
        await Promise.race([f.runtime.control.shutdown(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("shutdown hung")), 2000).unref())]);
        assert.equal(f.counts().stopped, 1);
        f.state("connected");
        assert.equal(f.runtime.control.getStatus().qq, "disconnected");
        f.reject(); await tick();
    } finally { await f.close(); }
});

test("shutdown before start skips connection", async () => {
    const f = await fixture("id", "secret");
    try {
        await f.runtime.control.shutdown(); await f.runtime.start();
        assert.equal(f.counts().started, 0);
        assert.equal(f.counts().stopped, 1);
    } finally { await f.close(); }
});

test("changing credentials requests restart without changing current connection state", async () => {
    const f = await fixture("id", "secret");
    try {
        await f.runtime.start(); await tick(); f.state("connected");
        await f.change("id2", "secret2");
        for (let i = 0; i < 50 && !f.runtime.control.getStatus().hotReload?.requiresRestart; i++) await new Promise((r) => setTimeout(r, 50));
        assert.equal(f.runtime.control.getStatus().hotReload?.requiresRestart, true);
        assert.equal(f.runtime.control.getStatus().qq, "connected");
    } finally { await f.close(); }
});
