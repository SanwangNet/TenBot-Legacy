import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "smol-toml";
import { parseEnvDocument, patchEnvDocument, isMissingFile, writeFileAtomically } from "../../../src/config/env-document.js";

export interface StardustConfig { service: { name: string; description: string }; server: { host: string; port: number }; web: { title: string }; model: { provider: string; model: string; baseUrl: string }; initialized: boolean }
export interface PublicStardustConfig { config: StardustConfig; sources: Record<string, "environment" | "file" | "default">; secrets: { modelApiKeyConfigured: boolean; masked: string | null; source: "environment" | "file" | "default" }; requiresRestart: boolean }
export interface StardustConfigOptions { configPath?: string; envPath?: string; environment?: NodeJS.ProcessEnv; write?: (path: string, content: string) => Promise<void> }
const defaults: StardustConfig = { service: { name: "Stardust", description: "" }, server: { host: "127.0.0.1", port: 3000 }, web: { title: "Stardust" }, model: { provider: "", model: "", baseUrl: "" }, initialized: false };
const keys = { "service.name": "STARDUST_NAME", "service.description": "STARDUST_DESCRIPTION", "server.host": "WEB_HOST", "server.port": "WEB_PORT", "web.title": "STARDUST_WEB_TITLE", "model.provider": "STARDUST_MODEL_PROVIDER", "model.model": "STARDUST_MODEL_NAME", "model.baseUrl": "STARDUST_MODEL_BASE_URL", initialized: "STARDUST_INITIALIZED" } as const;
type Field = keyof typeof keys;
async function read(path: string): Promise<string> { try { return await readFile(path, "utf8"); } catch (e) { if (isMissingFile(e)) return ""; throw e; } }
function flatten(c: StardustConfig): Record<Field, string | number | boolean> { return { "service.name": c.service.name, "service.description": c.service.description, "server.host": c.server.host, "server.port": c.server.port, "web.title": c.web.title, "model.provider": c.model.provider, "model.model": c.model.model, "model.baseUrl": c.model.baseUrl, initialized: c.initialized }; }
function decode(raw: unknown): StardustConfig {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid configuration");
    const r = raw as Record<string, unknown>;
    const section = (name: string): Record<string, unknown> => { const x = r[name]; if (x === undefined) return {}; if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("Invalid configuration"); return x as Record<string, unknown>; };
    const service=section("service"), server=section("server"), web=section("web"), model=section("model");
    const text=(v: unknown, fallback: string): string => { if (v === undefined) return fallback; if (typeof v !== "string" || v.length > 512 || /[\u0000-\u001f\u007f]/.test(v)) throw new Error("Invalid configuration"); return v; };
    const port=server.port ?? defaults.server.port; if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid configuration");
    const initialized=r.initialized ?? false; if (typeof initialized !== "boolean") throw new Error("Invalid configuration");
    const config={ service: { name: text(service.name, defaults.service.name), description: text(service.description, "") }, server: { host: text(server.host, defaults.server.host), port }, web: { title: text(web.title, defaults.web.title) }, model: { provider: text(model.provider, ""), model: text(model.model, ""), baseUrl: text(model.baseUrl, "") }, initialized };
    if (!config.service.name.trim() || !config.server.host.trim() || !config.web.title.trim()) throw new Error("Invalid configuration");
    if (config.model.baseUrl) { let u: URL; try { u = new URL(config.model.baseUrl); } catch { throw new Error("Invalid configuration"); } if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error("Invalid configuration"); }
    return config;
}
function patchToml(content: string, updates: Partial<Record<Field, string | number | boolean>>): string {
    let result = content;
    for (const [field, value] of Object.entries(updates)) {
        const parts = field.split("."); const key=parts.pop()!; const section=parts[0];
        const literal = typeof value === "string" ? JSON.stringify(value) : String(value);
        const lines=result ? result.split(/\r?\n/) : []; let current="", found=false, insert=lines.length;
        for (let i=0;i<lines.length;i++) { const h=lines[i]!.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/); if(h){ if(current===(section ?? "") && insert===lines.length) insert=i; current=h[1]!.trim(); continue; } if(current===(section ?? "") && new RegExp(`^\\s*${key}\\s*=`).test(lines[i]!)) { lines[i]=`${key} = ${literal}`; found=true; break; } }
        if(!found) { if(!section) { const first=lines.findIndex(l=>/^\s*\[/.test(l)); lines.splice(first<0?lines.length:first,0,`${key} = ${literal}`); } else if(lines.some(l=>new RegExp(`^\\s*\\[${section}\\]`).test(l))) lines.splice(insert,0,`${key} = ${literal}`); else lines.push(`[${section}]`,`${key} = ${literal}`); }
        result=lines.join(content.includes("\r\n") ? "\r\n" : "\n");
    }
    return result.endsWith("\n") ? result : result+"\n";
}
async function writeSecret(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true }); const temp=join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try { const f=await open(temp,"wx",0o600); try { await f.writeFile(content,"utf8"); await f.sync(); } finally { await f.close(); } await rename(temp,path); } finally { try { await unlink(temp); } catch { /* already renamed */ } }
}
export function createStardustConfigService(options: StardustConfigOptions = {}) {
    const configPath=resolve(options.configPath ?? "config.toml"), envPath=resolve(options.envPath ?? ".env"), environment={...(options.environment ?? process.env)}; let queue: Promise<void>=Promise.resolve();
    async function snapshot(): Promise<PublicStardustConfig> {
        const doc=await read(configPath), fileConfig=decode(doc ? parse(doc) : {}), values=flatten(fileConfig), sources: Record<string,"environment"|"file"|"default">={};
        const raw=doc ? parse(doc) : {}; const rawObject=raw as Record<string,unknown>;
        for(const field of Object.keys(keys) as Field[]) { const env=environment[keys[field]]; const [section,key]=field.includes(".")?field.split("."):["",field]; const rawSection=section ? rawObject[section!] : rawObject; const present=Boolean(rawSection && typeof rawSection === "object" && Object.hasOwn(rawSection,key!)); sources[field]=env!==undefined?"environment":present?"file":"default"; if(env!==undefined) values[field]=field==="server.port"?Number(env):field==="initialized"?(env==="true"?true:env==="false"?false:env):env; }
        const effective=decode({ initialized:values.initialized, service:{name:values["service.name"],description:values["service.description"]},server:{host:values["server.host"],port:values["server.port"]},web:{title:values["web.title"]},model:{provider:values["model.provider"],model:values["model.model"],baseUrl:values["model.baseUrl"]} });
        const secrets=parseEnvDocument(await read(envPath)); const secret=environment.STARDUST_MODEL_API_KEY ?? secrets.STARDUST_MODEL_API_KEY;
        const chars = Array.from(secret ?? "");
        return { config:effective,sources,secrets:{modelApiKeyConfigured:Boolean(secret),masked:chars.length ? "••••••••" + (chars.length > 4 ? chars.slice(-4).join("") : "") : null,source:environment.STARDUST_MODEL_API_KEY!==undefined?"environment":secrets.STARDUST_MODEL_API_KEY!==undefined?"file":"default"},requiresRestart:true };
    }
    function serial<T>(fn:()=>Promise<T>):Promise<T>{ const next=queue.then(fn,fn); queue=next.then(()=>undefined,()=>undefined); return next; }
    const writeConfig=async(updates: Partial<Record<Field,string|number|boolean>>)=>{ await snapshot(); const before=await read(configPath); if(before) parse(before); const candidate=patchToml(before,updates); decode(parse(candidate)); await (options.write ?? writeFileAtomically)(configPath,candidate); return snapshot(); };
    const update=(updates: Partial<Record<Field,string|number|boolean>>) => serial(()=>writeConfig(updates));
    const initialize=()=>serial(async()=>{ if((await snapshot()).config.initialized) throw new Error("Already initialized"); return writeConfig({initialized:true}); });
    const updateSecret=(value:string)=>serial(async()=>{ if(typeof value!=="string" || value.length>4096 || /[\r\n\u0000]/.test(value) || /^•{8}/.test(value)) throw new Error("Invalid secret"); await snapshot(); const original=await read(envPath); const next=patchEnvDocument(original,{ STARDUST_MODEL_API_KEY:value }); await writeSecret(envPath,next); return snapshot(); });
    return { snapshot, update, initialize, updateSecret };
}
