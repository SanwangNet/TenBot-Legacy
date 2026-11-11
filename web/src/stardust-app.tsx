import { useEffect, useState, type FormEvent } from "react";
import "./stardust.css";

type Snapshot = { config: { initialized: boolean; service: { name: string; description: string }; server: { host: string; port: number }; web: { title: string }; model: { provider: string; model: string; baseUrl: string } }; sources: Record<string,string>; secrets: { modelApiKeyConfigured: boolean; masked: string | null; source: string }; requiresRestart: boolean };
type Draft = { name:string; description:string; provider:string; model:string; baseUrl:string; apiKey:string };
const empty: Draft = { name:"",description:"",provider:"",model:"",baseUrl:"",apiKey:"" };
async function api<T>(path:string, method="GET", body?:unknown):Promise<T> {
    const response=await fetch(path,{method,headers:body===undefined?undefined:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),cache:"no-store"});
    if(!response.ok) throw new Error(`请求失败（${response.status}）`);
    return response.json() as Promise<T>;
}
function toDraft(s:Snapshot):Draft { return {name:s.config.service.name,description:s.config.service.description,provider:s.config.model.provider,model:s.config.model.model,baseUrl:s.config.model.baseUrl,apiKey:""}; }
export function StardustApp() {
    const [snapshot,setSnapshot]=useState<Snapshot>(); const [draft,setDraft]=useState<Draft>(empty); const [page,setPage]=useState<"overview"|"settings">("overview");
    const [welcome,setWelcome]=useState(true); const [busy,setBusy]=useState(false); const [error,setError]=useState(""); const [notice,setNotice]=useState(""); const [health,setHealth]=useState("检查中");
    async function refresh(){ const [init,s]=await Promise.all([api<{initialized:boolean}>("/api/initialization"),api<Snapshot>("/api/config")]); setSnapshot({...s,config:{...s.config,initialized:init.initialized}}); setDraft(toDraft(s)); }
    useEffect(()=>{ void refresh().catch(()=>setError("无法读取配置，请检查服务状态。")); void api<{state:string}>("/api/health").then(h=>setHealth(h.state)).catch(()=>setHealth("离线")); },[]);
    function set<K extends keyof Draft>(key:K,value:Draft[K]) { setDraft(old=>({...old,[key]:value})); }
    const errors:Partial<Record<keyof Draft,string>>={};
    if(!draft.name.trim()) errors.name="请填写服务名称。";
    if(draft.baseUrl){ try { const url=new URL(draft.baseUrl); if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash) throw Error(); } catch { errors.baseUrl="请输入不含凭据、查询参数或片段的 HTTP(S) 地址。"; } }
    if(/^•{8}/.test(draft.apiKey)) errors.apiKey="请输入实际密钥，而非脱敏显示值。";
    async function save(event:FormEvent,initialize:boolean){
        event.preventDefault(); if(Object.keys(errors).length){setError("请检查标记的字段。");return;} setBusy(true);setError("");setNotice(""); let ordinarySaved=false; let initializedSaved=false;
        try {
            await api("/api/config","PATCH",{"service.name":draft.name.trim(),"service.description":draft.description,"model.provider":draft.provider,"model.model":draft.model,"model.baseUrl":draft.baseUrl}); ordinarySaved=true;
            if(draft.apiKey) await api("/api/config/secrets","PUT",{modelApiKey:draft.apiKey});
            if(initialize) { await api("/api/initialization","POST",{}); initializedSaved=true; }
            await refresh();setNotice("设置已保存。环境变量优先；部分更改需重启后生效。");setWelcome(false);
        } catch {setError(initializedSaved?"初始化已保存，但状态刷新失败；请刷新页面。":ordinarySaved?(initialize?"普通配置已保存，但后续步骤失败；初始化尚未完成，请检查后重试。":"普通配置已保存，但密钥保存或状态刷新失败，请检查后重试。"):"保存失败，请检查配置后重试。");} finally {setBusy(false);}
    }
    async function clearKey(){ if(!window.confirm("确定清除文件中保存的 API Key？"))return;setBusy(true);setError("");try{await api("/api/config/secrets","PUT",{modelApiKey:""});await refresh();setNotice("已清除文件中的密钥；环境变量仍可能生效。");}catch{setError("清除密钥失败，请稍后重试。");}finally{setBusy(false);} }
    if(!snapshot) return <main className="sd-loading">{error||"正在加载 Stardust…"}</main>;
    const setup=!snapshot.config.initialized;
    const fields=<>
        <label>服务名称<input value={draft.name} onChange={e=>set("name",e.target.value)} required maxLength={512}/>{errors.name&&<small className="sd-error">{errors.name}</small>}<small>来源：{snapshot.sources["service.name"]}</small></label>
        <label>服务描述<input value={draft.description} onChange={e=>set("description",e.target.value)} maxLength={512}/><small>来源：{snapshot.sources["service.description"]}</small></label>
        <label>模型提供商（可选）<input value={draft.provider} onChange={e=>set("provider",e.target.value)} maxLength={512}/><small>来源：{snapshot.sources["model.provider"]}</small></label>
        <label>模型名称（可选）<input value={draft.model} onChange={e=>set("model",e.target.value)} maxLength={512}/><small>来源：{snapshot.sources["model.model"]}</small></label>
        <label>Base URL（可选）<input value={draft.baseUrl} onChange={e=>set("baseUrl",e.target.value)} />{errors.baseUrl&&<small className="sd-error">{errors.baseUrl}</small>}<small>来源：{snapshot.sources["model.baseUrl"]}</small></label>
        <label>API Key（可选）<input type="password" value={draft.apiKey} autoComplete="off" placeholder="留空保持不变" onChange={e=>set("apiKey",e.target.value)}/>{errors.apiKey&&<small className="sd-error">{errors.apiKey}</small>}<small>{snapshot.secrets.modelApiKeyConfigured ? `已配置 ${snapshot.secrets.masked ?? "••••••••"}（${snapshot.secrets.source}）` : "未配置"}</small></label>
        {snapshot.secrets.modelApiKeyConfigured && !setup && <button type="button" className="sd-secondary" disabled={busy} onClick={()=>void clearKey()}>清除文件中保存的密钥</button>}
    </>;
    if(setup) return <main className="sd-center"><section className="sd-card"><div className="sd-brand">✦ Stardust</div>{welcome?<><h1>欢迎使用 Stardust</h1><p>创建你的空白管理空间。模型可以稍后配置。</p><button onClick={()=>setWelcome(false)}>开始配置</button></>:<><h1>基础配置</h1><p>服务地址：{snapshot.config.server.host}:{snapshot.config.server.port}</p><form onSubmit={e=>void save(e,true)}>{fields}{error&&<p className="sd-error" role="alert">{error}</p>}<button disabled={busy}>{busy?"正在保存…":"完成初始化"}</button></form></>}</section></main>;
    return <div className="sd-shell"><aside><div className="sd-brand">✦ Stardust</div><button className={page==="overview"?"active":""} onClick={()=>setPage("overview")}>概览</button><button className={page==="settings"?"active":""} onClick={()=>setPage("settings")}>设置</button><p>未来功能</p><span>Agent · 暂未实现</span><span>平台 · 暂未实现</span><span>扩展 · 暂未实现</span></aside><main className="sd-main">{page==="overview"?<><h1>概览</h1><p>查看 Stardust 的基本运行状态。</p><section className="sd-card"><h2>{snapshot.config.service.name}</h2><p>{snapshot.config.service.description || "尚未填写服务描述"}</p><div className="sd-metrics"><span>服务状态：{health}</span><span>初始化：已完成</span><span>监听：{snapshot.config.server.host}:{snapshot.config.server.port}</span></div></section></>:<><h1>设置</h1><p>环境变量优先于文件配置，已保存值可能被覆盖。</p><section className="sd-card"><form onSubmit={e=>void save(e,false)}>{fields}{error&&<p className="sd-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}<button disabled={busy}>{busy?"正在保存…":"保存设置"}</button></form></section></>}</main></div>;
}
