import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStardustServer } from "../apps/server/bootstrap.js";

test("standalone server does not start legacy runtime even with old configuration", async () => {
    const source = await readFile(new URL("../apps/server/bootstrap.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:src\/runtime|createTenBotRuntime|src\/qq|src\/skills\/meme)/);
    const dir = await mkdtemp(join(tmpdir(), "stardust-s0-"));
    await writeFile(join(dir, "index.html"), "<main>Stardust fixture</main>");
    let legacyCalls = 0;
    const server = await createStardustServer({ port: 0, configured: true, staticDirectory: dir, createRuntime: async () => { legacyCalls++; throw new Error("legacy should not run"); } });
    const base = `http://127.0.0.1:${server.address.port}`;
    try {
        assert.deepEqual(await (await fetch(base + "/api/health")).json(), { ok: true, state: "ready", service: "stardust", legacyApi: "disabled" });
        assert.match(await (await fetch(base + "/")).text(), /Stardust fixture/);
        for (const [path, method] of [["/api/config", "PATCH"], ["/api/status", "GET"], ["/api/setup/claim", "POST"], ["/api/auth/me", "GET"]]) {
            const response = await fetch(base + path, { method });
            assert.equal(response.status, 410);
        }
        assert.equal(legacyCalls, 0);
    } finally { await server.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
    assert.equal(server.getState(), "stopping");
});

test("real Server process ignores absent and legacy .env without leaking credentials", async () => {
    const { spawn } = await import("node:child_process");
    const { createServer } = await import("node:net");
    const { fileURLToPath } = await import("node:url");
    const dir = await mkdtemp(join(tmpdir(), "stardust-s0-process-"));
    try {
        for (const legacy of [false, true]) {
            if (legacy) await writeFile(join(dir, ".env"), "QQBOT_APP_ID=fake-app\nQQBOT_APP_SECRET=fake-secret-never-log\n");
            const socket = createServer();
            await new Promise<void>((done) => socket.listen(0, "127.0.0.1", done));
            const info = socket.address();
            assert.ok(info && typeof info !== "string");
            const port = info.port;
            await new Promise<void>((done, reject) => socket.close((error) => error ? reject(error) : done()));
            const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../apps/server/main.ts", import.meta.url))], {
                cwd: dir, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WEB_PORT: String(port), ...(legacy ? { QQBOT_APP_ID: "fake-app", QQBOT_APP_SECRET: "fake-secret-never-log" } : {}) }, stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
            child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
            try {
                let health: Response | undefined;
                for (let i = 0; i < 100; i++) {
                    try { health = await fetch(`http://127.0.0.1:${port}/api/health`); break; }
                    catch { await new Promise((done) => setTimeout(done, 30)); }
                }
                assert.ok(health, `Server failed to listen: ${output}`);
                assert.equal((await health.json()).service, "stardust");
                assert.doesNotMatch(output, /fake-secret-never-log|QQ Bot|Meme|Reply Judge/);
            } finally {
                const exited = new Promise<void>((done) => child.once("exit", () => done()));
                child.kill();
                await exited;
            }
        }
    } finally { await rm(dir, { recursive: true, force: true }); }
});
