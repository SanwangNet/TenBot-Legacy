import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createStardustConfigService } from "../packages/config/src/stardust.js";
import { createStardustServer } from "../apps/server/bootstrap.js";

test("configuration persists defaults, secrets and environment precedence", async () => {
    const dir=await mkdtemp(join(tmpdir(),"stardust-s1-")), configPath=join(dir,"config.toml"), envPath=join(dir,".env");
    try {
        const service=createStardustConfigService({configPath,envPath,environment:{}});
        assert.equal((await service.snapshot()).config.initialized,false);
        await writeFile(envPath,"UNRELATED=keep\n");
        await service.update({"service.name":"Fixture","model.provider":""});
        await service.updateSecret("secret-never-return");
        assert.match(await readFile(envPath,"utf8"),/UNRELATED=keep/);
        assert.doesNotMatch(JSON.stringify(await service.snapshot()),/secret-never-return/);
        await service.initialize();
        const restarted=createStardustConfigService({configPath,envPath,environment:{STARDUST_NAME:"Override", STARDUST_MODEL_API_KEY:"env-secret"}});
        const snap=await restarted.snapshot();
        assert.equal(snap.config.service.name,"Override"); assert.equal(snap.config.initialized,true); assert.equal(snap.sources["service.name"],"environment");
        assert.doesNotMatch(JSON.stringify(snap),/env-secret|secret-never-return/);
        await assert.rejects(service.update({"server.port":-1}));
        assert.equal((await service.snapshot()).config.service.name,"Fixture");
        const before=await readFile(configPath,"utf8");
        const fail=createStardustConfigService({configPath,envPath,environment:{},write:async()=>{throw Error("simulated")}});
        await assert.rejects(fail.update({"service.name":"changed"})); assert.equal(await readFile(configPath,"utf8"),before);
        await writeFile(configPath,"[broken\n"); await assert.rejects(service.snapshot());
    } finally {await rm(dir,{recursive:true,force:true})}
});

test("configuration writes reject cross-origin requests and allow same-origin requests without a token", async () => {
    const dir=await mkdtemp(join(tmpdir(),"stardust-s1-http-")), token="fixture-strong-local-token-0123456789";
    const server=await createStardustServer({port:0,configPath:join(dir,"config.toml"),envPath:join(dir,".env"),environment:{STARDUST_CONFIG_TOKEN:token}});
    const base=`http://127.0.0.1:${server.address.port}`;
    const send=(headers:Record<string,string>)=>fetch(base+"/api/initialization",{method:"POST",headers:{"content-type":"application/json",...headers},body:"{}"});
    try {
        assert.deepEqual(await (await fetch(base+"/api/initialization")).json(),{initialized:false});
        assert.equal((await send({origin:"https://attacker.example"})).status,403);
        assert.equal((await send({origin:base})).status,200);
        assert.equal((await send({origin:base})).status,409);
        const secret = await fetch(base + "/api/config/secrets", { method:"PUT", headers:{"content-type":"application/json", "x-stardust-local-token":token, origin:base}, body:JSON.stringify({modelApiKey:"http-private-key"}) });
        assert.equal(secret.status,200); assert.doesNotMatch(await secret.text(), /http-private-key/);
        const config = await fetch(base + "/api/config");
        const publicConfig = await config.text();
        assert.doesNotMatch(publicConfig, /http-private-key/);
        assert.match(publicConfig, /••••••••-key/);
        await writeFile(join(dir, "config.toml"), "[invalid\nsecret-never-echo");
        const invalid = await fetch(base + "/api/config");
        assert.equal(invalid.status,503); assert.doesNotMatch(await invalid.text(), /secret-never-echo/);
    } finally {await server.close();await rm(dir,{recursive:true,force:true})}
});
