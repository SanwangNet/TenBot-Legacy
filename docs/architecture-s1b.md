# S1b deployment

Stardust management has no authentication. Bind to 127.0.0.1 by default. Do not expose the management interface directly to untrusted networks; deployment operators are responsible for securing remote access. The server validates configuration and JSON request bodies and checks a supplied browser Origin against Host, but these checks are not authentication and cannot protect an exposed reverse proxy. `STARDUST_CONFIG_TOKEN` and `X-Stardust-Local-Token` are no longer required.

On first visit, complete the welcome and configuration form; model settings are optional. The wizard saves ordinary configuration, then an optional secret, and marks initialization complete only after both succeed. If a later step fails, previously saved settings remain and the page reports the partial save.

`config.toml` stores non-secret settings and `.env` stores the model API key. The API returns only whether a key is configured, its source, and a masked suffix. An environment override remains effective even after a file value is changed or cleared. Restarts may be required for configuration changes. Existing `.env` keys are retained.
