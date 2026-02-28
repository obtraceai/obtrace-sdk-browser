import type { LogLevel, ObtraceSDKConfig, QueuedPayload, ReplayChunk, ReplayStep, SDKContext } from "../shared/types";
import { createTraceparent, extractPropagation, nowUnixNano, randomHex } from "../shared/utils";
import { buildLogsPayload, buildMetricPayload, buildSpanPayload } from "./otlp";

export class ObtraceClient {
  private readonly config: Required<Pick<ObtraceSDKConfig, "apiKey" | "ingestBaseUrl" | "serviceName">> & ObtraceSDKConfig;
  private readonly queue: QueuedPayload[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private active = true;

  constructor(config: ObtraceSDKConfig) {
    if (!config.apiKey || !config.ingestBaseUrl || !config.serviceName) {
      throw new Error("apiKey, ingestBaseUrl and serviceName are required");
    }
    this.config = {
      requestTimeoutMs: 5000,
      flushIntervalMs: 2000,
      maxQueueSize: 1000,
      defaultHeaders: {},
      ...config,
      apiKey: config.apiKey,
      ingestBaseUrl: config.ingestBaseUrl.replace(/\/$/, ""),
      serviceName: config.serviceName
    };
    this.start();
  }

  start(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setInterval(() => {
      this.flush().catch(() => undefined);
    }, this.config.flushIntervalMs);
  }

  stop(): void {
    this.active = false;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stop();
    await this.flush();
  }

  log(level: LogLevel, message: string, context?: SDKContext): void {
    const body = buildLogsPayload({
      resource: this.resource(),
      scope: this.scope(),
      level,
      body: message,
      context
    });
    this.enqueue({ endpoint: "/otlp/v1/logs", contentType: "application/json", body });
  }

  metric(name: string, value: number, unit?: string, context?: SDKContext): void {
    const body = buildMetricPayload({
      resource: this.resource(),
      scope: this.scope(),
      metricName: name,
      value,
      unit,
      context
    });
    this.enqueue({ endpoint: "/otlp/v1/metrics", contentType: "application/json", body });
  }

  span(input: {
    name: string;
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    startUnixNano?: string;
    endUnixNano?: string;
    statusCode?: number;
    statusMessage?: string;
    attrs?: Record<string, string | number | boolean>;
  }): { traceId: string; spanId: string } {
    const traceId = input.traceId ?? randomHex(16);
    const spanId = input.spanId ?? randomHex(8);
    const start = input.startUnixNano ?? `${Date.now()}000000`;
    const end = input.endUnixNano ?? `${Date.now()}000000`;

    const body = buildSpanPayload({
      resource: this.resource(),
      scope: this.scope(),
      name: input.name,
      traceId,
      spanId,
      parentSpanId: input.parentSpanId,
      startUnixNano: start,
      endUnixNano: end,
      statusCode: input.statusCode,
      statusMessage: input.statusMessage,
      attrs: input.attrs
    });

    this.enqueue({ endpoint: "/otlp/v1/traces", contentType: "application/json", body });
    return { traceId, spanId };
  }

  replayChunk(chunk: ReplayChunk): void {
    this.enqueue({
      endpoint: "/ingest/replay/chunk",
      contentType: "application/json",
      body: JSON.stringify(chunk)
    });
  }

  replayRecipes(steps: ReplayStep[]): void {
    this.enqueue({
      endpoint: "/ingest/replay/recipes",
      contentType: "application/json",
      body: JSON.stringify({ steps })
    });
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
    const traceHeader = this.config.propagation?.headerName ?? "traceparent";
    const sessionHeader = this.config.propagation?.sessionHeaderName ?? "x-obtrace-session-id";
    if (!h.has(traceHeader)) {
      h.set(traceHeader, createTraceparent(context?.traceId, context?.spanId));
    }
    if (context?.traceState && !h.has("tracestate")) {
      h.set("tracestate", context.traceState);
    }
    if (context?.baggage && !h.has("baggage")) {
      h.set("baggage", context.baggage);
    }
    if (context?.sessionId && !h.has(sessionHeader)) {
      h.set(sessionHeader, context.sessionId);
    }
    return h;
  }

  instrumentedFetch(context?: { sessionId?: string }) {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      const startMs = Date.now();
      const startNs = nowUnixNano();
      const incoming = extractPropagation(init?.headers);
      const traceId = incoming?.traceId ?? randomHex(16);
      const spanId = randomHex(8);
      try {
        const merged: RequestInit = {
          ...init,
          headers: this.injectPropagation(init?.headers, {
            traceId,
            spanId,
            traceState: incoming.traceState,
            baggage: incoming.baggage,
            sessionId: context?.sessionId
          })
        };
        const res = await fetch(input, merged);
        this.span({
          name: `http.client ${method}`,
          traceId,
          spanId,
          parentSpanId: incoming?.parentSpanId,
          startUnixNano: startNs,
          endUnixNano: nowUnixNano(),
          statusCode: res.status,
          attrs: {
            "http.method": method,
            "http.status_code": res.status,
            "http.duration_ms": Date.now() - startMs
          }
        });
        return res;
      } catch (err) {
        this.span({
          name: `http.client ${method}`,
          traceId,
          spanId,
          parentSpanId: incoming?.parentSpanId,
          startUnixNano: startNs,
          endUnixNano: nowUnixNano(),
          statusCode: 500,
          statusMessage: String(err),
          attrs: {
            "http.method": method,
            "http.duration_ms": Date.now() - startMs
          }
        });
        this.log("error", `fetch failed: ${String(err)}`, {
          traceId,
          spanId,
          method,
          attrs: { "http.duration_ms": Date.now() - startMs }
        });
        throw err;
      }
    };
  }

  private enqueue(payload: QueuedPayload): void {
    if (!this.active) {
      return;
    }
    const maxQueue = this.config.maxQueueSize ?? 1000;
    if (this.queue.length >= maxQueue) {
      this.queue.shift();
    }
    this.queue.push(payload);
    if (this.queue.length >= 20) {
      this.flush().catch(() => undefined);
    }
  }

  async flush(): Promise<void> {
    if (!this.queue.length) {
      return;
    }
    const batch = this.queue.splice(0, this.queue.length);
    for (const item of batch) {
      try {
        await this.send(item);
      } catch (err) {
        if (this.config.debug) {
          // eslint-disable-next-line no-console
          console.error("[obtrace-sdk] send failed", err);
        }
      }
    }
  }

  private async send(item: QueuedPayload): Promise<void> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.config.requestTimeoutMs);
    try {
      const res = await fetch(`${this.config.ingestBaseUrl}${item.endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": item.contentType,
          ...this.config.defaultHeaders
        },
        body: item.body,
        signal: ctrl.signal
      });
      if (res.status >= 300 && this.config.debug) {
        const txt = await res.text().catch(() => "");
        // eslint-disable-next-line no-console
        console.error(`[obtrace-sdk] status=${res.status} endpoint=${item.endpoint} body=${txt}`);
      }
    } finally {
      clearTimeout(t);
    }
  }

  private scope(): { tenantId?: string; projectId?: string; appId?: string; env?: string } {
    return {
      tenantId: this.config.tenantId,
      projectId: this.config.projectId,
      appId: this.config.appId,
      env: this.config.env
    };
  }

  private resource() {
    const g = globalThis as { Bun?: unknown; process?: { versions?: { node?: string } } };
    return {
      serviceName: this.config.serviceName,
      serviceVersion: this.config.serviceVersion,
      deploymentEnv: this.config.env,
      runtimeName: typeof g.Bun !== "undefined" ? "bun" : (typeof g.process?.versions?.node === "string" ? "node" : "browser")
    };
  }
}
