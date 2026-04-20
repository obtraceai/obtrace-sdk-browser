import { trace, metrics, context, SpanStatusCode, ROOT_CONTEXT, type Tracer, type Meter, type Span } from "@opentelemetry/api";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { BatchSpanProcessor, TraceIdRatioBasedSampler, ParentBasedSampler } from "@opentelemetry/sdk-trace-web";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { XMLHttpRequestInstrumentation } from "@opentelemetry/instrumentation-xml-http-request";
import { DocumentLoadInstrumentation } from "@opentelemetry/instrumentation-document-load";
import { UserInteractionInstrumentation } from "@opentelemetry/instrumentation-user-interaction";
import { ZoneContextManager } from "@opentelemetry/context-zone";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import type { ObtraceSDKConfig } from "../shared/types";
import { enrichSupabaseSpan, isSupabaseURL, parseSupabaseURL } from "../browser/supabase";

const SUPABASE_PROPAGATE_REGEX = /\.supabase\.co\//;
const LOCALHOST_PROPAGATE_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/)/;
const SECOND_LEVEL_TLDS = new Set([
  "com", "co", "org", "gov", "net", "edu", "ac", "gob", "mil", "or", "ne",
]);
const PAAS_PUBLIC_SUFFIXES = [
  "vercel.app", "vercel.sh",
  "netlify.app", "netlify.com",
  "github.io",
  "herokuapp.com",
  "pages.dev",
  "fly.dev",
  "onrender.com",
  "railway.app",
  "ngrok.io", "ngrok-free.app",
  "cloudfront.net",
  "azurewebsites.net",
  "appspot.com",
  "firebaseapp.com", "web.app",
];

function deriveApexRegex(): RegExp | null {
  if (typeof window === "undefined") return null;
  const host = window.location.hostname;
  if (!host) return null;
  if (host === "localhost") return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  if (PAAS_PUBLIC_SUFFIXES.some((s) => host === s || host.endsWith("." + s))) return null;

  const parts = host.split(".");
  if (parts.length < 2) return null;

  const apexParts = parts.length >= 3 && SECOND_LEVEL_TLDS.has(parts[parts.length - 2])
    ? parts.slice(-3)
    : parts.slice(-2);
  const apex = apexParts.join(".").replace(/\./g, "\\.");
  return new RegExp(`^https?:\\/\\/([^\\/]+\\.)?${apex}(\\/|:|$)`);
}

function buildPropagateList(
  extra: string | RegExp | Array<string | RegExp> | undefined,
): Array<string | RegExp> {
  const list: Array<string | RegExp> = [SUPABASE_PROPAGATE_REGEX, LOCALHOST_PROPAGATE_REGEX];
  const apex = deriveApexRegex();
  if (apex) list.push(apex);
  if (extra === undefined) return list;
  if (Array.isArray(extra)) list.push(...extra);
  else list.push(extra);
  return list;
}

export interface OtelHandles {
  tracer: Tracer;
  meter: Meter;
  loggerProvider: LoggerProvider;
  shutdown: () => Promise<void>;
  forceFlush: () => Promise<void>;
}

export function setupOtelWeb(config: ObtraceSDKConfig & { sessionId?: string }): OtelHandles {
  const baseUrl = (config.ingestBaseUrl || "https://ingest.obtrace.ai").replace(/\/$/, "");
  const authHeaders = {
    Authorization: `Bearer ${config.apiKey}`,
    ...(config.appId ? { "X-Obtrace-App-ID": config.appId } : {}),
    ...(config.env ? { "X-Obtrace-Env": config.env } : {}),
    ...(config.serviceName ? { "X-Obtrace-Service-Name": config.serviceName } : {}),
    ...config.defaultHeaders,
  };

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion ?? "0.0.0",
    "deployment.environment": config.env ?? "dev",
    ...(config.tenantId ? { "obtrace.tenant_id": config.tenantId } : {}),
    ...(config.projectId ? { "obtrace.project_id": config.projectId } : {}),
    ...(config.appId ? { "obtrace.app_id": config.appId } : {}),
    ...(config.env ? { "obtrace.env": config.env } : {}),
    ...(config.sessionId ? { "session.id": config.sessionId } : {}),
    "runtime.name": "browser",
  });

  const traceExporter = new OTLPTraceExporter({
    url: `${baseUrl}/otlp/v1/traces`,
    headers: authHeaders,
  });

  const sampleRate = config.tracesSampleRate ?? 1;
  const sampler = sampleRate < 1
    ? new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRate) })
    : undefined;

  const tracerProvider = new WebTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
    ...(sampler ? { sampler } : {}),
  });

  tracerProvider.register({
    contextManager: new ZoneContextManager(),
  });

  const metricExporter = new OTLPMetricExporter({
    url: `${baseUrl}/otlp/v1/metrics`,
    headers: authHeaders,
  });

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: config.flushIntervalMs ?? 2000,
      }),
    ],
  });

  metrics.setGlobalMeterProvider(meterProvider);

  const logExporter = new OTLPLogExporter({
    url: `${baseUrl}/otlp/v1/logs`,
    headers: authHeaders,
  });

  const loggerProvider = new LoggerProvider({
    resource: resource as any,
    processors: [new BatchLogRecordProcessor(logExporter)],
  });

  const ingestPattern = new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

  const instrumentations = [];

  const sessionId = config.sessionId || "";

  const applySupabaseAttrs = (parentSpan: Span, req: any, result?: any) => {
    try {
      const url = typeof req === "string" ? req : req instanceof URL ? req.href : req?.url || "";
      const method = req?.method || "GET";
      if (!url || !isSupabaseURL(url)) return;
      enrichSupabaseSpan(parentSpan, url, method);
      if (sessionId) parentSpan.setAttribute("session.id", sessionId);
      const parsed = parseSupabaseURL(url, method);
      if (!parsed) return;
      const status = typeof result?.status === "number" ? result.status : 0;
      const t = trace.getTracer("@obtrace/sdk-browser", "2.6.1");
      const synth = { "session.id": sessionId, "supabase.ref": parsed.ref, "span.synthetic": "true" };
      const parentCtx = trace.setSpan(ROOT_CONTEXT, parentSpan);

      const gw = t.startSpan(
        "supabase.gateway",
        {
          attributes: {
            ...synth,
            "http.method": method.toUpperCase(),
            "http.status_code": status,
            "peer.service": "supabase.kong",
            "service.name": "supabase.kong",
            "span.layer": "gateway",
          },
        },
        parentCtx,
      );
      const gwCtx = trace.setSpan(parentCtx, gw);

      if (parsed.service === "postgrest") {
        const db = t.startSpan(
          "supabase.db.query",
          {
            attributes: {
              ...synth,
              "db.system": "postgresql",
              "db.operation": parsed.operation,
              "db.sql.table": parsed.table,
              "db.statement": parsed.detail,
              "peer.service": "supabase.postgresql",
              "service.name": "supabase.postgresql",
              "span.layer": "database",
            },
          },
          gwCtx,
        );
        db.setStatus({ code: status >= 400 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        db.end();
      }
      if (parsed.service === "auth") {
        const auth = t.startSpan(
          "supabase.auth." + parsed.operation,
          {
            attributes: {
              ...synth,
              "auth.operation": parsed.operation,
              "peer.service": "supabase.gotrue",
              "service.name": "supabase.gotrue",
              "span.layer": "auth",
            },
          },
          gwCtx,
        );
        auth.setStatus({ code: status >= 400 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        auth.end();
      }
      if (parsed.service === "storage") {
        const stor = t.startSpan(
          "supabase.storage." + parsed.operation,
          {
            attributes: {
              ...synth,
              "storage.operation": parsed.operation,
              "peer.service": "supabase.storage",
              "service.name": "supabase.storage",
              "span.layer": "storage",
            },
          },
          gwCtx,
        );
        stor.setStatus({ code: status >= 400 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        stor.end();
      }
      if (parsed.service === "edge-function") {
        const fnName = parsed.operation.replace("invoke:", "");
        const fn = t.startSpan(
          "supabase.function." + fnName,
          {
            attributes: {
              ...synth,
              "faas.name": fnName,
              "faas.trigger": "http",
              "peer.service": "supabase.edge-runtime",
              "service.name": "supabase.edge-runtime",
              "span.layer": "edge-function",
            },
          },
          gwCtx,
        );
        fn.setStatus({ code: status >= 400 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        fn.end();
      }

      gw.setStatus({ code: status >= 400 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      gw.end();
    } catch (err) {
      try { console.warn("[obtrace] applySupabaseAttrs failed", err); } catch {}
    }
  };

  const propagateTraceHeaderCorsUrls = buildPropagateList(config.propagation?.propagateTo);

  if (config.instrumentGlobalFetch !== false) {
    instrumentations.push(
      new FetchInstrumentation({
        propagateTraceHeaderCorsUrls,
        ignoreUrls: [ingestPattern],
        clearTimingResources: true,
        applyCustomAttributesOnSpan: applySupabaseAttrs,
      })
    );
  }

  if (config.instrumentXHR !== false) {
    instrumentations.push(
      new XMLHttpRequestInstrumentation({
        propagateTraceHeaderCorsUrls,
        ignoreUrls: [ingestPattern],
        clearTimingResources: true,
      })
    );
  }

  instrumentations.push(new DocumentLoadInstrumentation());
  instrumentations.push(new UserInteractionInstrumentation());

  registerInstrumentations({
    tracerProvider,
    instrumentations,
  });

  const tracer = trace.getTracer("@obtrace/sdk-browser", "2.4.0");
  const meter = metrics.getMeter("@obtrace/sdk-browser", "2.4.0");

  const forceFlush = async () => {
    try { await tracerProvider.forceFlush(); } catch {}
    try { await meterProvider.forceFlush(); } catch {}
    try { await loggerProvider.forceFlush(); } catch {}
  };

  const shutdown = async () => {
    await forceFlush();
    await tracerProvider.shutdown();
    await meterProvider.shutdown();
    await loggerProvider.shutdown();
  };

  return { tracer, meter, loggerProvider, shutdown, forceFlush };
}
