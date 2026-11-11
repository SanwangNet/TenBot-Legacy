import { startServer } from "./bootstrap.js";
const server = await startServer();
console.log(`[Server] listening on ${server.address.host}:${server.address.port}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void server.close().catch(() => { process.exitCode = 1; }); });
