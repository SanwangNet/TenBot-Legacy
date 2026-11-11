import { useCallback, useEffect, useReducer } from "react";
import { setUnauthorizedHandler } from "../api/client.js";
import type { AuthMeResponse } from "../api/types.js";
import { RuntimeProvider } from "../runtime/runtime-context.js";
import { App } from "../App.js";
import { AuthGateView, ClaimCompletedError, authGateReducer, initialAuthGateState } from "./auth-view.js";

type SetupStatus = { initialized: boolean; passwordEnabled: boolean; githubEnabled: boolean };

async function setupStatus(signal?: AbortSignal): Promise<SetupStatus> {
    const response = await fetch("/api/setup/status", { headers: { Accept: "application/json" }, signal });
    // Older standalone Runtime servers do not expose setup status; retain GitHub login there.
    if (response.status === 401 || response.status === 404) return { initialized: true, passwordEnabled: false, githubEnabled: true };
    if (response.status === 410) throw new Error("legacy-disabled");
    if (!response.ok) throw new Error("unavailable");
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("initialized" in value) || typeof value.initialized !== "boolean" ||
        !("passwordEnabled" in value) || typeof value.passwordEnabled !== "boolean" ||
        !("githubEnabled" in value) || typeof value.githubEnabled !== "boolean") throw new Error("invalid status");
    return { initialized: value.initialized, passwordEnabled: value.passwordEnabled, githubEnabled: value.githubEnabled };
}

async function postCredentials(path: string, body: object): Promise<number> {
    const response = await fetch(path, {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return response.status;
}

async function authenticatedUser(signal?: AbortSignal): Promise<AuthMeResponse["user"] | undefined> {
    const response = await fetch("/api/auth/me", { headers: { Accept: "application/json" }, cache: "no-store", signal });
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("authenticated" in value) || value.authenticated !== true ||
        !("user" in value) || !value.user || typeof value.user !== "object" ||
        !("id" in value.user) || typeof value.user.id !== "string" ||
        !("login" in value.user) || typeof value.user.login !== "string" ||
        !("avatarUrl" in value.user) || !(value.user.avatarUrl === null || typeof value.user.avatarUrl === "string")) return undefined;
    return { id: value.user.id, login: value.user.login, avatarUrl: value.user.avatarUrl };
}

export function AuthGate() {
    const [state, dispatch] = useReducer(authGateReducer, initialAuthGateState);
    const showLogin = useCallback(async (signal?: AbortSignal) => {
        try {
            const status = await setupStatus(signal);
            if (signal?.aborted) return;
            if (!status.initialized) dispatch({ type: "setup" });
            else dispatch({ type: "unauthenticated", passwordEnabled: status.passwordEnabled, githubEnabled: status.githubEnabled });
        } catch (error) {
            if (!signal?.aborted) dispatch({ type: "unavailable", message: error instanceof Error && error.message === "legacy-disabled" ? "旧管理接口已停用，Stardust 正在建设中。" : "无法读取初始化状态，请检查服务是否可用。" });
        }
    }, []);
    useEffect(() => {
        const controller = new AbortController();
        setUnauthorizedHandler(() => { void showLogin(controller.signal); });
        void authenticatedUser(controller.signal)
            .then((user) => {
                if (controller.signal.aborted) return;
                if (user) dispatch({ type: "authenticated", user });
                else void showLogin(controller.signal);
            })
            .catch(() => { if (!controller.signal.aborted) void showLogin(controller.signal); });
        return () => {
            controller.abort();
            setUnauthorizedHandler(undefined);
        };
    }, [showLogin]);

    const attachSession = async () => {
        const user = await authenticatedUser();
        if (user) { dispatch({ type: "authenticated", user }); return; }
        await showLogin();
        throw new Error("session unavailable");
    };
    const claim = async (token: string, password: string) => {
        const claimStatus = await postCredentials("/api/setup/claim", { token, password });
        if (claimStatus < 200 || claimStatus >= 300) throw new Error("claim failed");
        let loggedIn = false;
        for (let attempt = 0; attempt < 60; attempt++) {
            const status = await postCredentials("/api/auth/password", { password });
            if (status >= 200 && status < 300) { loggedIn = true; break; }
            if (status !== 503) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!loggedIn) { await showLogin(); throw new ClaimCompletedError(); }
        try { await attachSession(); }
        catch { throw new ClaimCompletedError(); }
    };
    const login = async (password: string) => {
        const status = await postCredentials("/api/auth/password", { password });
        if (status < 200 || status >= 300) throw new Error("authentication failed");
        await attachSession();
    };

    return <AuthGateView state={state} onClaim={claim} onPasswordLogin={login}>
        {state.kind === "authenticated" && <RuntimeProvider><App user={state.user} onLogout={() => { void showLogin(); }} /></RuntimeProvider>}
    </AuthGateView>;
}
