# Stardust R1 architecture

Run `pnpm dev` to start the independent server and Web development workspaces. The Web development server proxies `/api` to the Server. Production builds are produced by `pnpm web:build`.

On Windows, interrupting the parallel pnpm development command can produce cmd.exe's `Terminate batch job (Y/N)?` prompt and a nonzero pnpm exit code, even when both listeners and child processes have stopped. This was observed during an empty-configuration acceptance run; it is not evidence that all other shutdown failures can be ignored. Check the child logs and port cleanup if shutdown behaves differently.

`apps/server` owns the only listening HTTP server. It exposes `/api/health` with `starting`, `initializing`, `ready`, `needs-setup`, `degraded`, or `stopping` state and a separate QQ state. It serves the built Web while initializing, and locks management endpoints until a runtime is ready. It attaches the legacy Runtime's HTTP handler after initialization; that handler retains the existing GitHub OAuth, session and Origin checks. QQ starts asynchronously and does not gate the listener. Shutdown stops HTTP and the Runtime; a Runtime that finishes initializing after shutdown is stopped rather than attached.

The legacy runtime retains a self-hosted mode for existing callers; the Server selects external HTTP mode. Existing QQ message and model behavior remains in `src`. `packages/shared` contains platform-neutral display helpers, and `packages/core`, `packages/config`, and `packages/platform-sdk` hold preliminary interfaces; they are not yet complete implementations.

R2 can implement authenticated initialization, durable configuration and live runtime replacement. Runtime initialization accepts an AbortSignal and checks it after controlled asynchronous phases. On cancellation or failure it closes resources acquired during initialization, including watchers, database handles, timers, bot handlers and logs. Server shutdown aborts initialization without waiting indefinitely; a third-party operation that never settles cannot be forcibly cancelled and may retain resources until it returns.
