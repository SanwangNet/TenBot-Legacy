import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadAppConfig, publicConfigPatchEnvValues, toPublicConfig, validateImageGenerationConfig } from "../../../src/config/config-validation.js";
import type { AppConfig, ConfigUpdateResult, ImageGenerationConfig, PublicConfig, PublicConfigPatch } from "../../../src/config/config-types.js";
import { isMissingFile, parseEnvDocument, writeFileAtomically } from "../../../src/config/env-document.js";

export type ConfigurationSource = "environment" | "web" | "default";
export interface ConfigurationSnapshot { readonly revision: number; readonly value: Readonly<PublicConfig>; readonly sources: Readonly<Record<string, ConfigurationSource>> }
export interface ConfigurationService {
    getSnapshot(): ConfigurationSnapshot;
    getAppConfig(): AppConfig;
    update(patch: PublicConfigPatch, expectedRevision?: number): Promise<ConfigUpdateResult>;
    getEnvPath(): string;
}
export interface ConfigurationOptions {
    envPath?: string; storagePath?: string; environment?: NodeJS.ProcessEnv;
    validateImageConfig?: (config: ImageGenerationConfig, current: AppConfig) => void;
}
const publicKeys = ["AI_PROVIDER", "MEME_SEND_MAX_EDGE", "CODEX_MODEL", "CODEX_REASONING_EFFORT", "CODEX_VERBOSITY", "DEEPSEEK_MODEL", "DEEPSEEK_REASONING_EFFORT", "REPLY_JUDGE_MODEL", "REPLY_JUDGE_TIMEOUT_MS", "REPLY_JUDGE_IPO_FALLBACK_TO_MAIN", "REPLY_JUDGE_TURN_WAIT_MS", "BOT_LOOP_GUARD_MAX_CYCLES", "IMAGE_GENERATION_ENABLED", "IMAGE_GENERATION_DAILY_LIMIT", "IMAGE_GENERATION_PROVIDER", "IMAGE_GENERATION_MODEL", "IMAGE_GENERATION_QUALITY", "IMAGE_GENERATION_SIZE", "IMAGE_GENERATION_OUTPUT_FORMAT"] as const;
const sourceKeys = [...publicKeys, "FRONT_MODE", "BOT_TIME_ZONE", "BOT_ADMIN_IDS", "QQBOT_APP_ID", "QQBOT_APP_SECRET", "CODEX_API_KEY", "CODEX_BASE_URL", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "REPLY_JUDGE_PROVIDER", "REPLY_JUDGE_BASE_URL", "REPLY_JUDGE_API_KEY", "WEB_HOST", "WEB_PORT"] as const;
type Stored = { revision: number; values: Record<string, string> };
function readText(path: string): string {
    try { return readFileSync(path, "utf8"); } catch (error) { if (isMissingFile(error)) return ""; throw error; }
}
function readStored(path: string): Stored {
    const text = readText(path);
    if (!text) return { revision: 0, values: {} };
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value) || !("revision" in value) || !("values" in value) || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0 || !value.values || typeof value.values !== "object" || Array.isArray(value.values)) throw new Error("Invalid stored configuration");
    const values: Record<string, string> = {};
    for (const [key, item] of Object.entries(value.values)) {
        if (!publicKeys.some((allowed) => allowed === key) || typeof item !== "string") throw new Error("Invalid stored configuration");
        values[key] = item;
    }
    return { revision: value.revision, values };
}
export function createConfigurationService(options: ConfigurationOptions = {}): ConfigurationService {
    const envPath = resolve(options.envPath ?? ".env");
    const storagePath = resolve(options.storagePath ?? "data/web-config.json");
    const environment = { ...(options.environment ?? process.env) };
    const initialFile = parseEnvDocument(readText(envPath));
    if (!options.environment) for (const [key, value] of Object.entries(initialFile)) if (environment[key] === value) delete environment[key];
    let queue: Promise<void> = Promise.resolve();
    const effectiveEnvironment = (stored: Stored) => ({ ...stored.values, ...parseEnvDocument(readText(envPath)), ...environment });
    const getAppConfig = () => loadAppConfig(effectiveEnvironment(readStored(storagePath)));
    const getSnapshot = (): ConfigurationSnapshot => {
        const stored = readStored(storagePath);
        const file = parseEnvDocument(readText(envPath));
        const sources: Record<string, ConfigurationSource> = {};
        for (const key of sourceKeys) {
            const envValue = environment[key] ?? file[key];
            sources[key] = envValue !== undefined ? (envValue.trim() ? "environment" : "default") : stored.values[key] !== undefined ? "web" : "default";
        }
        return { revision: stored.revision, value: toPublicConfig(loadAppConfig({ ...stored.values, ...file, ...environment })), sources };
    };
    const update = (patch: PublicConfigPatch, expectedRevision?: number): Promise<ConfigUpdateResult> => {
        const action = async (): Promise<ConfigUpdateResult> => {
            try {
                const stored = readStored(storagePath);
                if (expectedRevision !== undefined && expectedRevision !== stored.revision) return { ok: false, requiresRestart: false, changedFields: [], message: "配置版本冲突" };
                const values = publicConfigPatchEnvValues(patch, (image) => options.validateImageConfig ? options.validateImageConfig(image, getAppConfig()) : validateImageGenerationConfig(image));
                const next = { revision: stored.revision + 1, values: { ...stored.values, ...values } };
                loadAppConfig(effectiveEnvironment(next));
                await writeFileAtomically(storagePath, JSON.stringify(next, null, 2) + "\n");
                return { ok: true, requiresRestart: false, changedFields: [patch.field], message: "配置已保存。" };
            } catch { return { ok: false, requiresRestart: false, changedFields: [], message: "配置无效或无法保存" }; }
        };
        const result = queue.then(action, action);
        queue = result.then(() => undefined, () => undefined);
        return result;
    };
    return { getSnapshot, getAppConfig, update, getEnvPath: () => envPath };
}
