import "dotenv/config";
import { resolve } from "node:path";
import { issueSetupToken } from "../src/auth/initial-claim.js";

async function main(): Promise<void> {
    if (!process.stdout.isTTY) throw new Error("请在可信的交互终端中运行，禁止重定向输出。");
    if (["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET", "GITHUB_OAUTH_CALLBACK_URL", "GITHUB_OAUTH_ALLOWED_USER_IDS"].some((key) => Boolean(process.env[key]?.trim()))) {
        throw new Error("检测到 GitHub OAuth 部署配置，不允许签发首次认领凭据。");
    }
    const issued = await issueSetupToken(resolve(process.cwd(), "data", "admin-auth.json"));
    process.stdout.write(`一次性初始化凭据（请勿分享或记录）：\n${issued.token}\n有效期至 ${new Date(issued.expiresAt).toISOString()}\n`);
}

void main().catch(() => {
    process.stderr.write("无法签发初始化凭据：请确认在交互终端运行、尚未完成初始化且没有 GitHub OAuth 部署配置。\n");
    process.exitCode = 1;
});
