import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStardustServer } from "../apps/server/bootstrap.js";
import { issueSetupToken } from "../src/auth/initial-claim.js";
import { createTenBotRuntime } from "../src/runtime.js";

test("empty install claim, password session, authorization, logout and restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stardust-setup-http-"));
    const passwordFile = join(dir, "admin-auth.json"), passwordOrigin = "http://127.0.0.1:5173";
    const make = (configured: boolean) => createStardustServer({ port: 0, configured, passwordFile, passwordOrigin, authEnvironment: {}, createRuntime: (signal) => createTenBotRuntime({ envPath: join(dir, ".env"), environment: {}, databasePath: join(dir, "bot.db"), logDirectory: join(dir, "logs"), consoleLogs: false, externalHttp: true, signal, passwordFile, passwordOrigin }) });
    const credential = await issueSetupToken(passwordFile);
    const password = "fixture-strong-password";
    let server = await make(false);
    const post = (base: string, path: string, body: object, origin = passwordOrigin, cookie?: string) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    try {
        let base = `http://127.0.0.1:${server.address.port}`;
        assert.deepEqual(await (await fetch(base + "/api/setup/status")).json(), { initialized: false, passwordEnabled: false, githubEnabled: false });
        assert.equal((await post(base, "/api/setup/claim", { token: credential.token, password }, "https://attacker.example")).status, 403);
        assert.equal((await post(base, "/api/setup/claim", { token: "wrong", password })).status, 400);
        assert.equal((await post(base, "/api/setup/claim", { token: credential.token, password })).status, 200);
        assert.equal((await post(base, "/api/setup/claim", { token: credential.token, password })).status, 409);
        for (let i=0; i<150 && String(server.getState()) === "initializing"; i++) await new Promise((r) => setTimeout(r, 20));
        assert.equal(server.getState(), "ready");
        assert.equal((await fetch(base + "/api/config", { method: "PATCH", headers: { "Content-Type": "application/json", Origin: passwordOrigin }, body: JSON.stringify({ field: "gpt.model", value: "test" }) })).status, 401);
        assert.equal((await post(base, "/api/auth/password", { password: "incorrect-password" })).status, 401);
        const login = await post(base, "/api/auth/password", { password });
        assert.equal(login.status, 200);
        const cookie = login.headers.get("set-cookie"); assert.ok(cookie); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Lax/i);
        const sessionCookie = cookie.split(";", 1)[0]!;
        assert.equal((await fetch(base + "/api/config", { headers: { Cookie: sessionCookie } })).status, 200);
        assert.equal((await fetch(base + "/api/config", { method: "PATCH", headers: { "Content-Type": "application/json", Origin: "https://attacker.example", Cookie: sessionCookie }, body: JSON.stringify({ field: "gpt.model", value: "test" }) })).status, 403);
        const saved = await fetch(base + "/api/config", { method: "PATCH", headers: { "Content-Type": "application/json", Origin: passwordOrigin, Cookie: sessionCookie }, body: JSON.stringify({ field: "gpt.model", value: "test-model" }) });
        assert.equal(saved.status, 200);
        await server.close();
        server = await make(true);
        base = `http://127.0.0.1:${server.address.port}`;
        for (let i=0; i<150 && String(server.getState()) === "initializing"; i++) await new Promise((r) => setTimeout(r, 20));
        assert.equal(server.getState(), "ready");
        assert.equal((await fetch(base + "/api/auth/me", { headers: { Cookie: sessionCookie } })).status, 200);
        assert.equal((await post(base, "/api/auth/logout", {}, passwordOrigin, sessionCookie)).status, 200);
        assert.equal((await fetch(base + "/api/auth/me", { headers: { Cookie: sessionCookie } })).status, 401);
        assert.equal((await post(base, "/api/auth/password", { password })).status, 200);
        assert.equal((await post(base, "/api/setup/claim", { token: credential.token, password })).status, 409);
    } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
