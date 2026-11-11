import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InitialClaim } from "../src/auth/initial-claim.js";
import { WebAuthService } from "../src/auth/web-auth-service.js";
import { WebSessionRepository } from "../src/auth/web-session-repository.js";
import { createTenBotWebServer } from "../src/control/web-server.js";
import type { TenBotControl } from "../src/control/tenbot-control.js";

const origin = "http://127.0.0.1:5173";
test("password session protects real management API, enforces Origin and survives auth service recreation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stardust-password-http-"));
    const passwordFile = join(dir, "auth.json");
    const repository = new WebSessionRepository(join(dir, "sessions.db"));
    const claim = new InitialClaim(passwordFile, "fixture-token");
    assert.equal(await claim.claim("fixture-token", "long-fixture-password"), "claimed");
    const auth = new WebAuthService({}, repository, { passwordFile, passwordOrigin: origin });
    const control = {
        getConfig: () => ({ marker: "authenticated" }),
        async updateConfig() { return { ok: true, requiresRestart: false, changedFields: ["gpt.model"], message: "saved" }; },
    } as unknown as TenBotControl;
    const web = createTenBotWebServer(control, { host: "127.0.0.1", port: 0, auth });
    const address = await web.start();
    const base = `http://127.0.0.1:${address.port}`;
    try {
        assert.equal((await fetch(`${base}/api/config`)).status, 401);
        const login = (password: string, requestOrigin = origin) => fetch(`${base}/api/auth/password`, { method: "POST", headers: { "Content-Type": "application/json", Origin: requestOrigin }, body: JSON.stringify({ password }) });
        assert.equal((await login("wrong-password")).status, 401);
        assert.equal((await login("long-fixture-password", "https://evil.example")).status, 403);
        const response = await login("long-fixture-password");
        assert.equal(response.status, 200);
        const setCookie = response.headers.get("set-cookie");
        assert.ok(setCookie);
        assert.match(setCookie, /HttpOnly/);
        assert.match(setCookie, /SameSite=Lax/);
        const cookie = setCookie.split(";", 1)[0]!;
        assert.equal((await fetch(`${base}/api/config`, { headers: { Cookie: cookie } })).status, 200);
        assert.equal((await fetch(`${base}/api/config`, { method: "PATCH", headers: { Cookie: cookie, Origin: "https://evil.example" } })).status, 403);
        assert.equal((await fetch(`${base}/api/config`, { method: "PATCH", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ field: "gpt.model", value: "fixture" }) })).status, 200);
        const recreated = new WebAuthService({}, repository, { passwordFile, passwordOrigin: origin });
        assert.equal(recreated.getSession(cookie.slice(cookie.indexOf("=") + 1))?.id, "local-admin");
        assert.equal((await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Cookie: cookie, Origin: origin } })).status, 200);
        assert.equal((await fetch(`${base}/api/config`, { headers: { Cookie: cookie } })).status, 401);
        const https = new WebAuthService({}, repository, { passwordFile, passwordOrigin: "https://admin.example" });
        assert.equal(https.securePasswordCookie(), true);
    } finally { await web.close(); repository.close(); await rm(dir, { recursive: true, force: true }); }
});
