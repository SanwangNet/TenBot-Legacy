import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InitialClaim, issueSetupToken, claimInitialPassword, verifyClaimPassword } from "../src/auth/initial-claim.js";

test("claim expires, rejects invalid input, stores only a password hash and cannot be replayed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stardust-claim-"));
    try {
        const file = join(dir, "auth.json");
        let now = 1_000;
        const claim = new InitialClaim(file, "secret-claim-token", () => now, 1_000);
        assert.equal(await claim.claim("wrong", "long-password-value"), "invalid");
        assert.equal(await claim.claim("secret-claim-token", "short"), "invalid");
        assert.equal(await claim.claim("secret-claim-token", "long-password-value"), "claimed");
        assert.equal(await claim.claim("secret-claim-token", "long-password-value"), "already-claimed");
        const saved = await readFile(file, "utf8");
        assert.doesNotMatch(saved, /secret-claim-token|long-password-value/);
        assert.equal(await verifyClaimPassword(file, "long-password-value"), true);
        assert.equal(await verifyClaimPassword(file, "incorrect-password"), false);
        assert.equal(await new InitialClaim(file, "another-token").claim("another-token", "long-password-value"), "already-claimed");
        const expired = new InitialClaim(join(dir, "other.json"), "token", () => now, 5);
        now += 5;
        assert.equal(await expired.claim("token", "long-password-value"), "expired");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CLI-issued challenges survive restart, expire and are atomically single-use", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stardust-persistent-claim-"));
    try {
        const file = join(dir, "admin-auth.json");
        let now = 1_000;
        const expired = await issueSetupToken(file, () => now, 10);
        const raw = await readFile(`${file}.challenge`, "utf8");
        assert.doesNotMatch(raw, new RegExp(expired.token));
        now += 10;
        assert.equal(await claimInitialPassword(file, expired.token, "valid-password-value", () => now), "expired");
        const fresh = await issueSetupToken(file, () => now, 10_000);
        assert.equal(await claimInitialPassword(file, "bad-token", "valid-password-value", () => now), "invalid");
        assert.equal(await claimInitialPassword(file, expired.token, "valid-password-value", () => now), "invalid");
        const outcomes = await Promise.all([
            claimInitialPassword(file, fresh.token, "valid-password-value", () => now),
            claimInitialPassword(file, fresh.token, "another-valid-password", () => now),
        ]);
        assert.equal(outcomes.filter((result) => result === "claimed").length, 1);
        assert.equal(outcomes.filter((result) => result === "already-claimed").length, 1);
        assert.equal(await claimInitialPassword(file, fresh.token, "valid-password-value", () => now), "already-claimed");
        const stored = await readFile(file, "utf8");
        assert.doesNotMatch(stored, /valid-password-value|another-valid-password/);
        assert.doesNotMatch(stored, new RegExp(fresh.token));
        await assert.rejects(issueSetupToken(file, () => now), /Already initialized/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
