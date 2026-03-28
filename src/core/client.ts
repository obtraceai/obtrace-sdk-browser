import type { LogLevel, ObtraceSDKConfig, QueuedPayload, ReplayChunk, ReplayStep, SDKContext } from "../shared/types";
import { isSemanticMetricName } from "../shared/semantic_metrics";
import { createTraceparent, extractPropagation, nowUnixNano, randomHex } from "../shared/utils";
import { buildLogsPayload, buildMetricPayload, buildSpanPayload } from "./otlp";

export class ObtraceClient {
  private readonly config: Required<Pick<ObtraceSDKConfig, "apiKey" | "ingestBaseUrl" | "serviceName">> & ObtraceSDKConfig;
  private readonly queue: QueuedPayload[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private active = true;
  private circuitFailures = 0;
  private circuitOpenUntil = 0;
  private flushing = false;
  private queueBytes = 0;
  replayTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ObtraceSDKConfig) {
    if (!config.apiKey || !config.ingestBaseUrl || !config.serviceName) {
      throw new Error("apiKey, ingestBaseUrl and serviceName are required");
    }
    this.config = {
      requestTimeoutMs: 5000,
      flushIntervalMs: 2000,
      maxQueueSize: 1000,
      maxQueueBytes: 4 * 1024 * 1024,
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
    if (this.replayTimer) {
      clearInterval(this.replayTimer);
      this.replayTimer = null;
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
      body: this.truncate(message, 32768),
      context
    });
    this.enqueue({ endpoint: "/otlp/v1/logs", contentType: "application/json", body });
  }

  metric(name: string, value: number, unit?: string, context?: SDKContext): void {
    if (this.config.validateSemanticMetrics && !isSemanticMetricName(name) && this.config.debug) {
      // eslint-disable-next-line no-console
      console.warn(`[obtrace-sdk-browser] non-canonical metric name: ${name}`);
    }
    const body = buildMetricPayload({
      resource: this.resource(),
      scope: this.scope(),
      metricName: this.truncate(name, 1024),
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

    let attrs = input.attrs;
    if (attrs) {
      attrs = { ...attrs };
      for (const key of Object.keys(attrs)) {
        const v = attrs[key];
        if (typeof v === "string") attrs[key] = this.truncate(v, 4096);
      }
    }

    const body = buildSpanPayload({
      resource: this.resource(),
      scope: this.scope(),
      name: this.truncate(input.name, 32768),
      traceId,
      spanId,
      parentSpanId: input.parentSpanId,
      startUnixNano: start,
      endUnixNano: end,
      statusCode: input.statusCode,
      statusMessage: input.statusMessage,
      attrs
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
    const maxBytes = this.config.maxQueueBytes ?? 4 * 1024 * 1024;
    const payloadBytes = payload.body.length * 2;
    while (this.queue.length > 0 && (this.queue.length >= maxQueue || this.queueBytes + payloadBytes > maxBytes)) {
      const dropped = this.queue.shift()!;
      this.queueBytes -= dropped.body.length * 2;
    }
    this.queue.push(payload);
    this.queueBytes += payloadBytes;
    if (this.queue.length >= 20) {
      this.flush().catch(() => undefined);
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || !this.queue.length) {
      return;
    }
    const now = Date.now();
    if (now < this.circuitOpenUntil) {
      return;
    }
    this.flushing = true;
    try {
      const halfOpen = this.circuitFailures >= 5;
      const batch = halfOpen ? this.queue.splice(0, 1) : this.queue.splice(0, this.queue.length);
      for (const item of batch) {
        this.queueBytes -= item.body.length * 2;
      }
      const concurrency = 4;
      for (let i = 0; i < batch.length; i += concurrency) {
        const chunk = batch.slice(i, i + concurrency);
        await Promise.allSettled(chunk.map((item) => this.sendWithRetry(item)));
      }
    } finally {
      this.flushing = false;
    }
  }

  private async sendWithRetry(item: QueuedPayload): Promise<void> {
    try {
      await this.send(item);
      if (this.circuitFailures > 0) {
        this.circuitFailures = 0;
        this.circuitOpenUntil = 0;
      }
    } catch {
      try {
        await new Promise((r) => setTimeout(r, 500));
        await this.send(item);
        if (this.circuitFailures > 0) {
          this.circuitFailures = 0;
          this.circuitOpenUntil = 0;
        }
      } catch {
        this.circuitFailures++;
        if (this.circuitFailures >= 5) {
          this.circuitOpenUntil = Date.now() + 30000;
        }
      }
    }
  }

  private async send(item: QueuedPayload): Promise<void> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.config.requestTimeoutMs);
    try {
      const hdrs: Record<string, string> = {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": item.contentType,
        ...this.config.defaultHeaders,
      };
      if (this.config.appId) hdrs["X-Obtrace-App-ID"] = this.config.appId;
      if (this.config.env) hdrs["X-Obtrace-Env"] = this.config.env;
      if (this.config.serviceName) hdrs["X-Obtrace-Service-Name"] = this.config.serviceName;
      const res = await fetch(`${this.config.ingestBaseUrl}${item.endpoint}`, {
        method: "POST",
        headers: hdrs,
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

  private truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max) + "...[truncated]";
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
