import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { link, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

function scrypt(password: string, salt: string, length: number): Promise<Buffer> {
    return new Promise((resolve, reject) => scryptCallback(password, salt, length, (error, key) => error ? reject(error) : resolve(key)));
}
const TOKEN_TTL_MS = 10 * 60 * 1000;
export interface PasswordClaimRecord {
    version: 1;
    mode: "password";
    passwordHash: string;
    salt: string;
}
export type ClaimResult = "claimed" | "invalid" | "expired" | "already-claimed";

/** A process-local, short-lived claim challenge. Never expose tokenDigest or token in an API. */
export class InitialClaim {
    private readonly tokenDigest: Buffer;
    private readonly expiresAt: number;
    private used = false;
    private claiming = false;

    constructor(private readonly path: string, token: string, private readonly now: () => number = Date.now, ttl = TOKEN_TTL_MS) {
        if (!token || !Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("Invalid claim configuration");
        this.tokenDigest = createHash("sha256").update(token).digest();
        this.expiresAt = now() + ttl;
    }

    static generateToken(): string { return randomBytes(32).toString("base64url"); }

    async claim(token: string, password: string): Promise<ClaimResult> {
        if (this.used || this.claiming) return "already-claimed";
        if (this.now() >= this.expiresAt) return "expired";
        const candidate = createHash("sha256").update(token).digest();
        if (!timingSafeEqual(candidate, this.tokenDigest) || password.length < 12 || Buffer.byteLength(password, "utf8") > 1024) return "invalid";
        this.claiming = true;
        try {
            const salt = randomBytes(16).toString("hex");
            const hash = await scrypt(password, salt, 64);
            if (this.now() >= this.expiresAt) return "expired";
            const record: PasswordClaimRecord = { version: 1, mode: "password", salt, passwordHash: hash.toString("hex") };
            await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
            let file;
            try { file = await open(this.path, "wx", 0o600); }
            catch (error) {
                if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") { this.used = true; return "already-claimed"; }
                throw error;
            }
            try { await file.writeFile(JSON.stringify(record) + "\n", "utf8"); await file.sync(); }
            finally { await file.close(); }
            this.used = true;
            return "claimed";
        } finally { this.claiming = false; }
    }
}

export async function verifyClaimPassword(path: string, password: string): Promise<boolean> {
    try {
        if (Buffer.byteLength(password, "utf8") > 1024) return false;
        const data: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1 || !("mode" in data) || data.mode !== "password" || !("salt" in data) || typeof data.salt !== "string" || !/^[a-f0-9]{32}$/.test(data.salt) || !("passwordHash" in data) || typeof data.passwordHash !== "string" || !/^[a-f0-9]{128}$/.test(data.passwordHash)) return false;
        const expected = Buffer.from(data.passwordHash, "hex");
        const actual = await scrypt(password, data.salt, expected.length);
        return timingSafeEqual(actual, expected);
    } catch { return false; }
}

interface ChallengeRecord { version: 1; digest: string; expiresAt: number }
export interface IssuedSetupToken { token: string; expiresAt: number }

function challengePath(authPath: string): string { return `${authPath}.challenge`; }
function lockPath(authPath: string): string { return `${authPath}.lock`; }
function isCode(error: unknown, code: string): boolean {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
async function exists(path: string): Promise<boolean> {
    try { await stat(path); return true; }
    catch (error) { if (isCode(error, "ENOENT")) return false; throw error; }
}
async function removeIfPresent(path: string): Promise<void> {
    try { await unlink(path); } catch (error) { if (!isCode(error, "ENOENT")) throw error; }
}
async function acquireClaimLock(authPath: string): Promise<() => Promise<void>> {
    await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
    const path = lockPath(authPath);
    const handle = await open(path, "wx", 0o600);
    return async () => { await handle.close(); await removeIfPresent(path); };
}
function parseChallenge(value: unknown): ChallengeRecord | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value) || !("version" in value) || value.version !== 1 ||
        !("digest" in value) || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) ||
        !("expiresAt" in value) || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)) return undefined;
    return { version: 1, digest: value.digest, expiresAt: value.expiresAt };
}

/** Local CLI only. The raw token is returned once and never persisted; callers must not log it. */
export async function issueSetupToken(authPath: string, now: () => number = Date.now, ttl = TOKEN_TTL_MS): Promise<IssuedSetupToken> {
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("Invalid claim configuration");
    const release = await acquireClaimLock(authPath);
    const tmp = join(dirname(authPath), `.${basename(authPath)}.${randomUUID()}.tmp`);
    try {
        if (await exists(authPath)) throw new Error("Already initialized");
        const token = InitialClaim.generateToken();
        const expiresAt = now() + ttl;
        const challenge: ChallengeRecord = { version: 1, digest: createHash("sha256").update(token).digest("hex"), expiresAt };
        await writeFile(tmp, JSON.stringify(challenge) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
        await removeIfPresent(challengePath(authPath));
        await rename(tmp, challengePath(authPath));
        return { token, expiresAt };
    } finally {
        try { await removeIfPresent(tmp); } finally { await release(); }
    }
}

/** Atomically consumes an issued challenge across concurrent server processes. */
export async function claimInitialPassword(authPath: string, token: string, password: string, now: () => number = Date.now): Promise<ClaimResult> {
    if (token.length > 256 || password.length < 12 || Buffer.byteLength(password, "utf8") > 1024) return "invalid";
    let release: () => Promise<void>;
    try { release = await acquireClaimLock(authPath); }
    catch (error) { if (isCode(error, "EEXIST")) return "already-claimed"; throw error; }
    const tmp = join(dirname(authPath), `.${basename(authPath)}.${randomUUID()}.tmp`);
    try {
        if (await exists(authPath)) return "already-claimed";
        let data: unknown;
        try { data = JSON.parse(await readFile(challengePath(authPath), "utf8")); }
        catch (error) { if (isCode(error, "ENOENT") || error instanceof SyntaxError) return "invalid"; throw error; }
        const challenge = parseChallenge(data);
        if (!challenge) return "invalid";
        if (now() >= challenge.expiresAt) return "expired";
        const candidate = createHash("sha256").update(token).digest();
        if (!timingSafeEqual(candidate, Buffer.from(challenge.digest, "hex"))) return "invalid";
        const salt = randomBytes(16).toString("hex");
        const hash = await scrypt(password, salt, 64);
        if (now() >= challenge.expiresAt) return "expired";
        const record: PasswordClaimRecord = { version: 1, mode: "password", salt, passwordHash: hash.toString("hex") };
        const file = await open(tmp, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(record) + "\n", "utf8"); await file.sync(); }
        finally { await file.close(); }
        try { await link(tmp, authPath); }
        catch (error) { if (isCode(error, "EEXIST")) return "already-claimed"; throw error; }
        await removeIfPresent(challengePath(authPath));
        return "claimed";
    } finally {
        try { await removeIfPresent(tmp); } finally { await release(); }
    }
}
