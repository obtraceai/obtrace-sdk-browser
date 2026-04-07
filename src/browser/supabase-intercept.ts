import { type Tracer, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { isSupabaseURL, parseSupabaseURL } from "./supabase";
import { addBreadcrumb } from "./breadcrumbs";

export function installSupabaseFetchInterceptor(tracer: Tracer, sessionId: string): () => void {
  if (typeof window === "undefined" || typeof window.fetch === "undefined") return () => {};

  const originalFetch = window.fetch;

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input instanceof Request ? input.url : "";
    if (!url || !isSupabaseURL(url)) {
      return originalFetch.call(this, input, init);
    }

    const method = init?.method || (input instanceof Request ? input.method : "GET") || "GET";
    const parsed = parseSupabaseURL(url, method);
    if (!parsed) {
      return originalFetch.call(this, input, init);
    }

    const rootSpan = tracer.startSpan(`supabase.${parsed.service} ${parsed.detail}`, {
      attributes: {
        "supabase.ref": parsed.ref,
        "supabase.service": parsed.service,
        "supabase.operation": parsed.operation,
        "supabase.detail": parsed.detail,
        "http.method": method.toUpperCase(),
        "http.url": url.split("?")[0],
        "peer.service": `supabase.${parsed.service}`,
        "session.id": sessionId,
        ...(parsed.service === "postgrest" ? {
          "db.system": "postgresql",
          "db.operation": parsed.operation,
          "db.sql.table": parsed.table,
        } : {}),
      },
    });

    const rootCtx = trace.setSpan(context.active(), rootSpan);
    const startMs = performance.now();

    try {
      const response = await originalFetch.call(this, input, init);
      const durationMs = performance.now() - startMs;

      rootSpan.setAttribute("http.status_code", response.status);
      rootSpan.setAttribute("supabase.duration_ms", Math.round(durationMs));

      context.with(rootCtx, () => {
        createChildSpans(tracer, parsed, method, response.status, durationMs, sessionId);
      });

      if (response.status >= 400) {
        rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
        addBreadcrumb({ timestamp: Date.now(), category: "supabase", message: `${parsed.detail} → ${response.status}`, level: "error" });
      } else {
        rootSpan.setStatus({ code: SpanStatusCode.OK });
        addBreadcrumb({ timestamp: Date.now(), category: "supabase", message: `${parsed.detail} → ${response.status} (${Math.round(durationMs)}ms)`, level: "info" });
      }

      rootSpan.end();
      return response;
    } catch (err) {
      rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : "fetch failed" });
      if (err instanceof Error) rootSpan.recordException(err);
      rootSpan.end();
      addBreadcrumb({ timestamp: Date.now(), category: "supabase", message: `${parsed.detail} → FAILED`, level: "error" });
      throw err;
    }
  };

  return () => { window.fetch = originalFetch; };
}

type ParsedSupabase = NonNullable<ReturnType<typeof parseSupabaseURL>>;

function createChildSpans(
  tracer: Tracer,
  parsed: ParsedSupabase,
  method: string,
  status: number,
  _durationMs: number,
  sessionId: string,
): void {
  const synth = { "session.id": sessionId, "supabase.ref": parsed.ref, "span.synthetic": "true" };

  const gatewaySpan = tracer.startSpan("supabase.gateway", {
    attributes: {
      ...synth,
      "http.method": method.toUpperCase(),
      "http.status_code": status,
      "peer.service": "supabase.kong",
    },
  });
  const gatewayCtx = trace.setSpan(context.active(), gatewaySpan);

  context.with(gatewayCtx, () => {
    if (parsed.service === "postgrest") {
      const dbSpan = tracer.startSpan("supabase.db.query", {
        attributes: {
          ...synth,
          "db.system": "postgresql",
          "db.operation": parsed.operation,
          "db.sql.table": parsed.table,
          "db.statement": parsed.detail,
          "peer.service": "supabase.postgresql",
        },
      });
      if (status >= 400) dbSpan.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
      else dbSpan.setStatus({ code: SpanStatusCode.OK });
      dbSpan.end();
    }

    if (parsed.service === "auth") {
      const authSpan = tracer.startSpan("supabase.auth." + parsed.operation, {
        attributes: { ...synth, "auth.operation": parsed.operation, "peer.service": "supabase.gotrue" },
      });
      if (status >= 400) authSpan.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
      else authSpan.setStatus({ code: SpanStatusCode.OK });
      authSpan.end();
    }

    if (parsed.service === "storage") {
      const storageSpan = tracer.startSpan("supabase.storage." + parsed.operation, {
        attributes: { ...synth, "storage.operation": parsed.operation, "peer.service": "supabase.storage" },
      });
      if (status >= 400) storageSpan.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
      else storageSpan.setStatus({ code: SpanStatusCode.OK });
      storageSpan.end();
    }

    if (parsed.service === "edge-function") {
      const fnName = parsed.operation.replace("invoke:", "");
      const fnSpan = tracer.startSpan("supabase.function." + fnName, {
        attributes: { ...synth, "faas.name": fnName, "faas.trigger": "http", "peer.service": "supabase.edge-runtime" },
      });
      if (status >= 400) fnSpan.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
      else fnSpan.setStatus({ code: SpanStatusCode.OK });
      fnSpan.end();
    }
  });

  if (status >= 400) gatewaySpan.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
  else gatewaySpan.setStatus({ code: SpanStatusCode.OK });
  gatewaySpan.end();
}
