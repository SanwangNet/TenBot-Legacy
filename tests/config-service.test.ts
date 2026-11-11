import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createConfigurationService } from "../packages/config/src/index.js";

test("web configuration persists atomically without writing env and tracks overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stardust-config-"));
    const envPath = join(dir, ".env"), storagePath = join(dir, "web.json");
    try {
        const environment = { CODEX_API_KEY: "private-config-secret" };
        const service = createConfigurationService({ envPath, storagePath, environment });
        assert.equal(service.getSnapshot().sources.CODEX_MODEL, "default");
        assert.equal((await service.update({ field: "gpt.model", value: "test-web-model" }, 0)).ok, true);
        assert.equal(service.getSnapshot().value.gpt.model, "test-web-model");
        assert.equal(service.getSnapshot().sources.CODEX_MODEL, "web");
        assert.equal(service.getSnapshot().sources.CODEX_API_KEY, "environment");
        await assert.rejects(readFile(envPath));
        assert.doesNotMatch(JSON.stringify(service.getSnapshot()), /private-config-secret/);
        assert.doesNotMatch(await readFile(storagePath, "utf8"), /private-config-secret/);
        const restarted = createConfigurationService({ envPath, storagePath, environment });
        assert.equal(restarted.getSnapshot().value.gpt.model, "test-web-model");
        assert.equal(restarted.getSnapshot().revision, 1);
        const before = await readFile(storagePath, "utf8");
        assert.equal((await restarted.update({ field: "gpt.model", value: "" })).ok, false);
        assert.equal((await restarted.update({ field: "gpt.model", value: "changed" }, 0)).ok, false);
        assert.equal(await readFile(storagePath, "utf8"), before);
        await writeFile(envPath, "CODEX_MODEL=legacy-model\n");
        assert.equal(restarted.getSnapshot().value.gpt.model, "legacy-model");
        assert.equal(restarted.getSnapshot().sources.CODEX_MODEL, "environment");
        assert.equal((await restarted.update({ field: "gpt.model", value: "saved-but-overridden" })).ok, true);
        assert.equal(await readFile(envPath, "utf8"), "CODEX_MODEL=legacy-model\n");
        assert.equal(restarted.getSnapshot().value.gpt.model, "legacy-model");
        const explicit = createConfigurationService({ envPath, storagePath, environment: { CODEX_MODEL: "process-model" } });
        assert.equal(explicit.getSnapshot().value.gpt.model, "process-model");
        const equalAtStart = createConfigurationService({ envPath, storagePath, environment: { CODEX_MODEL: "legacy-model" } });
        await writeFile(envPath, "CODEX_MODEL=changed-after-start\n");
        assert.equal(equalAtStart.getSnapshot().value.gpt.model, "legacy-model");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("concurrent revision-checked updates do not overwrite each other", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stardust-revision-"));
    try {
        const service = createConfigurationService({ envPath: join(dir, ".env"), storagePath: join(dir, "config.json"), environment: {} });
        const results = await Promise.all([
            service.update({ field: "gpt.model", value: "first" }, 0),
            service.update({ field: "gpt.model", value: "second" }, 0),
        ]);
        assert.deepEqual(results.map((result) => result.ok), [true, false]);
        assert.equal(service.getSnapshot().value.gpt.model, "first");
        assert.equal(service.getSnapshot().revision, 1);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("runtime saves public config separately and restores it after restart", async () => {
    const { createTenBotRuntime } = await import("../src/runtime.js");
    const dir = await mkdtemp(join(tmpdir(), "stardust-runtime-config-"));
    const envPath = join(dir, ".env"), configPath = join(dir, "web.json");
    const options = { envPath, configPath, environment: {}, databasePath: join(dir, "bot.db"), logDirectory: join(dir, "logs"), consoleLogs: false, externalHttp: true };
    try {
        const first = await createTenBotRuntime(options);
        try {
            assert.equal((await first.control.updateConfig({ field: "gpt.model", value: "fixture-model" })).ok, true);
            assert.equal(first.control.getConfig().gpt.model, "fixture-model");
            await assert.rejects(readFile(envPath));
        } finally { await first.control.shutdown(); }
        const second = await createTenBotRuntime(options);
        try { assert.equal(second.control.getConfig().gpt.model, "fixture-model"); }
        finally { await second.control.shutdown(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
});
