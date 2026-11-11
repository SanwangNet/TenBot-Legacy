# Stardust S0

Run `pnpm dev` to start the standalone HTTP Server and Web development app. The Server owns HTTP, static assets and `/api/health`. It does not load or start the legacy TenBot Runtime, QQ, model plugins, prompts, Meme data, reply workers or their timers, even when a legacy `.env` exists.

Legacy management and authentication endpoints are disabled and respond with HTTP 410. They do not grant access or represent active business services. Web displays that the old management interface is disabled. Old source, data, configuration and tests remain as reference; no migration or deletion occurs in S0.

The new service uses only `WEB_HOST` and `WEB_PORT` from the process environment; `.env` is not loaded by the standalone Server. Configuration, authentication, and future Agent integration are outside this phase.
