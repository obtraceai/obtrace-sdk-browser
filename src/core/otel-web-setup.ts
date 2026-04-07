import { trace, metrics, type Tracer, type Meter } from "@opentelemetry/api";
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
import { enrichSupabaseSpan, isSupabaseURL } from "../browser/supabase";

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

  const applySupabaseAttrs = (span: import("@opentelemetry/api").Span, req: any, _result?: any) => {
    try {
      const url = typeof req === "string" ? req : req instanceof URL ? req.href : req?.url || "";
      const method = req?.method || "GET";
      if (url && isSupabaseURL(url)) {
        enrichSupabaseSpan(span, url, method);
      }
    } catch {}
  };

  if (config.instrumentGlobalFetch !== false) {
    instrumentations.push(
      new FetchInstrumentation({
        propagateTraceHeaderCorsUrls: /.*/,
        ignoreUrls: [ingestPattern],
        clearTimingResources: true,
        applyCustomAttributesOnSpan: applySupabaseAttrs,
      })
    );
  }

  if (config.instrumentXHR !== false) {
    instrumentations.push(
      new XMLHttpRequestInstrumentation({
        propagateTraceHeaderCorsUrls: /.*/,
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

  const tracer = trace.getTracer("@obtrace/sdk-browser", "2.2.0");
  const meter = metrics.getMeter("@obtrace/sdk-browser", "2.2.0");

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
