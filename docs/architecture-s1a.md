> Historical S1a design: S1b changes the write security boundary; see architecture-s1b.md.

# S1a configuration API

`config.toml` holds `initialized` (boolean), `[service]` (`name`, `description`), `[server]` (`host`, `port`), `[web]` (`title`), and `[model]` (`provider`, `model`, `baseUrl`). Missing values use defaults; model fields may be empty. Explicit process environment variables override file values; the public snapshot reports the source for each field. Configuration updates are conservative and report `requiresRestart: true`.

The sensitive model credential is `STARDUST_MODEL_API_KEY` in `.env`. An explicitly set process variable wins. Writes patch only this key and retain other .env lines. API responses only report whether a key is configured and its source. No secret is returned.

`GET /api/initialization` returns the initialized flag. `GET /api/config` returns public effective values and sources. `POST /api/initialization` takes `{}`; `PATCH /api/config` accepts a JSON object keyed by dotted field names; `PUT /api/config/secrets` accepts `{ "modelApiKey": "..." }`. All write requests require the `X-Stardust-Local-Token` header matching a high-entropy `STARDUST_CONFIG_TOKEN` process environment variable of at least 32 characters, an actual loopback peer, a localhost Host for the bound port, a matching Origin when supplied, and no forwarding headers. Without a token, writes are disabled. A reverse proxy can also connect from loopback, so the token is essential; do not give it to a proxy or remote browser. Reads are redacted. Existing old business routes stay disabled.

Writes are serialized within one Server process and replace each file atomically. This is not a multi-process transaction or cross-process concurrency protocol. Invalid TOML and invalid values fail closed with generic API errors. Existing unknown TOML keys are preserved but edited known lines may be reformatted. Secrets are written via a new temporary file with POSIX mode 0600; Windows mode bits are not ACL enforcement. On Windows, protect the installation directory and .env with an appropriate ACL before storing secrets.
