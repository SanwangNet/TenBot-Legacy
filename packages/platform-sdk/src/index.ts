export interface PlatformLifecycle {
    readonly id: string;
    start(): Promise<void>;
    stop(): Promise<void>;
}
export type PlatformState = "unconfigured" | "connecting" | "connected" | "disconnected" | "error";
