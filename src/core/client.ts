import type { ObtraceSDKConfig, ReplayChunk, ReplayStep } from "../shared/types";

export class ObtraceClient {
  private readonly config: Required<Pick<ObtraceSDKConfig, "apiKey" | "ingestBaseUrl" | "serviceName">> & ObtraceSDKConfig;
  private active = true;
  replayTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ObtraceSDKConfig) {
    if (!config.apiKey || !config.ingestBaseUrl || !config.serviceName) {
      throw new Error("apiKey, ingestBaseUrl and serviceName are required");
    }
    this.config = {
      requestTimeoutMs: 5000,
      defaultHeaders: {},
      ...config,
      apiKey: config.apiKey,
      ingestBaseUrl: config.ingestBaseUrl.replace(/\/$/, ""),
      serviceName: config.serviceName,
    };
  }

  stop(): void {
    this.active = false;
    if (this.replayTimer) {
      clearInterval(this.replayTimer);
      this.replayTimer = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stop();
  }

  replayChunk(chunk: ReplayChunk): void {
    if (!this.active) return;
    this.sendReplay("/ingest/replay/chunk", JSON.stringify(chunk));
  }

  replayRecipes(steps: ReplayStep[]): void {
    if (!this.active) return;
    this.sendReplay("/ingest/replay/recipes", JSON.stringify({ steps }));
  }

  injectPropagation(headers?: HeadersInit, context?: {
    traceId?: string;
    spanId?: string;
    traceState?: string;
    baggage?: string;
    sessionId?: string;
  }): Headers {
    const h = new Headers(headers);
    if (this.config.propagation?.enabled === false) {
      return h;
    }
    const sessionHeader = this.config.propagation?.sessionHeaderName ?? "x-obtrace-session-id";
    if (context?.sessionId && !h.has(sessionHeader)) {
      h.set(sessionHeader, context.sessionId);
    }
    return h;
  }

  private sendReplay(endpoint: string, body: string): void {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.config.requestTimeoutMs);
    const hdrs: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      ...this.config.defaultHeaders,
    };
    if (this.config.appId) hdrs["X-Obtrace-App-ID"] = this.config.appId;
    if (this.config.env) hdrs["X-Obtrace-Env"] = this.config.env;
    if (this.config.serviceName) hdrs["X-Obtrace-Service-Name"] = this.config.serviceName;
    fetch(`${this.config.ingestBaseUrl}${endpoint}`, {
      method: "POST",
      headers: hdrs,
      body,
      signal: ctrl.signal,
    })
      .catch(() => {})
      .finally(() => clearTimeout(t));
  }
}
