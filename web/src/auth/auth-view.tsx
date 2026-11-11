import React, { useState, type FormEvent, type ReactNode } from "react";
import type { AuthMeResponse } from "../api/types.js";

export class ClaimCompletedError extends Error {}

export type AuthGateState =
    | { kind: "loading" }
    | { kind: "setup" }
    | { kind: "unauthenticated"; passwordEnabled?: boolean; githubEnabled?: boolean }
    | { kind: "unavailable"; message: string }
    | { kind: "authenticated"; user: AuthMeResponse["user"] };

type AuthGateAction =
    | { type: "authenticated"; user: AuthMeResponse["user"] }
    | { type: "setup" }
    | { type: "unauthenticated"; passwordEnabled?: boolean; githubEnabled?: boolean }
    | { type: "unavailable"; message: string };

export const initialAuthGateState: AuthGateState = { kind: "loading" };

export function authGateReducer(_state: AuthGateState, action: AuthGateAction): AuthGateState {
    if (action.type === "authenticated") return { kind: "authenticated", user: action.user };
    if (action.type === "setup") return { kind: "setup" };
    if (action.type === "unavailable") return { kind: "unavailable", message: action.message };
    return { kind: "unauthenticated", passwordEnabled: action.passwordEnabled, githubEnabled: action.githubEnabled };
}

export function AuthGateView({ state, children, onClaim, onPasswordLogin }: {
    state: AuthGateState;
    children?: ReactNode;
    onClaim?: (token: string, password: string) => Promise<void>;
    onPasswordLogin?: (password: string) => Promise<void>;
}) {
    if (state.kind === "loading") return <React.Fragment><main className="auth-screen"><section className="auth-card" aria-live="polite"><span className="brand-mark">T</span><p>正在验证 TenBot 登录状态…</p></section></main></React.Fragment>;
    if (state.kind === "authenticated") return children;
    return <LoginScreen state={state} onClaim={onClaim} onPasswordLogin={onPasswordLogin} />;
}

function LoginScreen({ state, onClaim, onPasswordLogin }: {
    state: Exclude<AuthGateState, { kind: "loading" } | { kind: "authenticated" }>;
    onClaim?: (token: string, password: string) => Promise<void>;
    onPasswordLogin?: (password: string) => Promise<void>;
}) {
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string>();
    const setup = state.kind === "setup";
    const passwordEnabled = state.kind === "unauthenticated" && state.passwordEnabled === true;
    const githubEnabled = state.kind === "unauthenticated" && state.githubEnabled !== false;
    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (submitting) return;
        const form = event.currentTarget;
        const values = new FormData(form);
        const password = String(values.get("password") ?? "");
        const token = String(values.get("token") ?? "").trim();
        if (setup && password !== String(values.get("confirmPassword") ?? "")) {
            setError("两次输入的密码不一致。");
            return;
        }
        form.reset();
        setError(undefined);
        setSubmitting(true);
        try {
            if (setup) {
                if (!onClaim) throw new Error("unavailable");
                await onClaim(token, password);
            } else {
                if (!onPasswordLogin) throw new Error("unavailable");
                await onPasswordLogin(password);
            }
        } catch (cause) {
            setError(cause instanceof ClaimCompletedError ? "账户已创建，请使用管理员密码登录。" : setup ? "认领失败，请检查凭据是否正确或过期后重试。" : "登录失败，请检查密码后重试。");
        } finally { setSubmitting(false); }
    }
    return <React.Fragment><main className="auth-screen">
        <section className="auth-card">
            <div className="auth-brand"><span className="brand-mark" aria-hidden="true">T</span><span>TenBot</span></div>
            <div className="auth-kicker">WEB CONTROL PLANE</div>
            <h1>{setup ? "初始化管理账户" : state.kind === "unavailable" ? "管理后台暂不可用" : "安全登录"}</h1>
            <p>{setup ? "请在服务器本机获取一次性认领凭据，然后设置管理员密码。" : state.kind === "unavailable" ? state.message : "使用已配置的管理员认证方式继续。"}</p>
            {setup && <p>在服务器工作目录运行 <code>pnpm setup-token</code> 获取凭据；请勿分享该凭据。</p>}
            {(setup || passwordEnabled) && <form onSubmit={submit} className="setting-field" style={{ marginTop: 24 }}>
                {setup && <label>一次性认领凭据<input name="token" type="password" autoComplete="off" required disabled={submitting} /></label>}
                <label>管理员密码<input name="password" type="password" autoComplete={setup ? "new-password" : "current-password"} minLength={setup ? 12 : undefined} maxLength={1024} required disabled={submitting} /></label>
                {setup && <label>确认密码<input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} maxLength={1024} required disabled={submitting} /></label>}
                {error && <div className="auth-error" role="alert">{error}</div>}
                <button className="button" type="submit" disabled={submitting}>{submitting ? "正在处理…" : setup ? "认领并进入" : "使用密码登录"}</button>
            </form>}
            {state.kind === "unavailable" && <div className="auth-error" role="alert">{state.message}</div>}
            {githubEnabled && <a className="github-login" href="/api/auth/github"><GitHubMark />使用 GitHub 登录</a>}
            <div className="auth-footnote">仅管理员可以访问管理后台</div>
        </section>
    </main></React.Fragment>;
}

function GitHubMark() {
    return <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.76-.24.76-.54v-2.1c-3.1.67-3.76-1.32-3.76-1.32-.5-1.28-1.24-1.62-1.24-1.62-1.01-.69.08-.68.08-.68 1.12.08 1.71 1.15 1.71 1.15.99 1.7 2.6 1.21 3.23.92.1-.72.39-1.21.7-1.49-2.48-.28-5.09-1.24-5.09-5.52 0-1.22.44-2.22 1.15-3-.12-.28-.5-1.42.11-2.96 0 0 .94-.3 3.08 1.15a10.7 10.7 0 0 1 5.6 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.54.23 2.68.11 2.96.72.78 1.15 1.78 1.15 3 0 4.29-2.61 5.23-5.1 5.51.4.35.75 1.03.75 2.08v3.07c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z" /></svg>;
}
