import test from "node:test";
import assert from "node:assert/strict";

import {
  trace,
  context,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { Resource } from "@opentelemetry/resources";
import { parseSupabaseURL, enrichSupabaseSpan, isSupabaseURL } from "../src/browser/supabase.ts";

function setupTracer(): { tracer: Tracer; exporter: InMemorySpanExporter; cleanup: () => void } {
  const exporter = new InMemorySpanExporter();
  const ctxManager = new AsyncLocalStorageContextManager();
  ctxManager.enable();
  context.setGlobalContextManager(ctxManager);
  const provider = new BasicTracerProvider({
    resource: new Resource({ "service.name": "core" }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  const tracer = trace.getTracer("@obtrace/sdk-browser-test", String(Date.now()));
  return {
    tracer,
    exporter,
    cleanup: () => {
      ctxManager.disable();
      context.disable();
      trace.disable();
    },
  };
}

function createSupabaseChildSpans(
  tracer: Tracer,
  sessionId: string,
  parentSpan: Span,
  url: string,
  method: string,
  status: number,
) {
  if (!isSupabaseURL(url)) return;
  enrichSupabaseSpan(parentSpan, url, method);
  if (sessionId) parentSpan.setAttribute("session.id", sessionId);
  const parsed = parseSupabaseURL(url, method);
  if (!parsed) return;
  const synth = { "session.id": sessionId, "supabase.ref": parsed.ref, "span.synthetic": "true" };
  const parentCtx = trace.setSpan(context.active(), parentSpan);
  context.with(parentCtx, () => {
    const gw = tracer.startSpan("supabase.gateway", {
      attributes: { ...synth, "http.method": method.toUpperCase(), "http.status_code": status, "peer.service": "supabase.kong" },
    });
    const gwCtx = trace.setSpan(context.active(), gw);
    context.with(gwCtx, () => {
      if (parsed.service === "postgrest") {
        const db = tracer.startSpan("supabase.db.query", {
          attributes: { ...synth, "db.system": "postgresql", "db.operation": parsed.operation, "db.sql.table": parsed.table, "peer.service": "supabase.postgresql" },
        });
        db.setStatus({ code: status >= 400 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        db.end();
      }
      if (parsed.service === "auth") {
        const auth = tracer.startSpan("supabase.auth." + parsed.operation, {
          attributes: { ...synth, "auth.operation": parsed.operation, "peer.service": "supabase.gotrue" },
        });
        auth.setStatus({ code: status >= 400 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        auth.end();
      }
    });
    gw.setStatus({ code: status >= 400 ? SpanStatusCode.ERROR : SpanStatusCode.OK });
    gw.end();
  });
}

test("supabase postgrest: all spans share one traceId with correct parent-child hierarchy", () => {
  const { tracer, exporter, cleanup } = setupTracer();
  try {
    const fetchSpan = tracer.startSpan("HTTP GET");
    createSupabaseChildSpans(tracer, "sess-abc", fetchSpan, "https://xyzref.supabase.co/rest/v1/professionals?select=*&active=eq.true", "GET", 200);
    fetchSpan.end();

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 3, `expected 3 spans, got ${spans.length}: ${spans.map(s => s.name).join(", ")}`);

    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    assert.equal(traceIds.size, 1, `all spans must share ONE traceId, got ${traceIds.size}: ${[...traceIds].join(", ")}`);

    const fetchFinished = spans.find((s) => s.name.includes("supabase.postgrest"));
    const gwFinished = spans.find((s) => s.name === "supabase.gateway");
    const dbFinished = spans.find((s) => s.name === "supabase.db.query");
    assert.ok(fetchFinished && gwFinished && dbFinished);

    assert.equal(gwFinished.parentSpanId, fetchFinished.spanContext().spanId, "gateway must be child of fetch span");
    assert.equal(dbFinished.parentSpanId, gwFinished.spanContext().spanId, "db.query must be child of gateway span");

    assert.equal(fetchFinished.attributes["supabase.ref"], "xyzref");
    assert.equal(fetchFinished.attributes["supabase.service"], "postgrest");
    assert.equal(dbFinished.attributes["db.sql.table"], "professionals");
    assert.equal(dbFinished.attributes["peer.service"], "supabase.postgresql");
  } finally {
    cleanup();
  }
});

test("supabase auth: all spans share one traceId with correct parent-child", () => {
  const { tracer, exporter, cleanup } = setupTracer();
  try {
    const fetchSpan = tracer.startSpan("HTTP POST");
    createSupabaseChildSpans(tracer, "sess-def", fetchSpan, "https://abc123.supabase.co/auth/v1/token?grant_type=refresh_token", "POST", 200);
    fetchSpan.end();

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 3, `expected 3 spans, got ${spans.length}`);

    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    assert.equal(traceIds.size, 1, "all spans must share one traceId");

    const authSpan = spans.find((s) => s.name.startsWith("supabase.auth."));
    assert.ok(authSpan, "expected auth child span");
    assert.equal(authSpan!.attributes["peer.service"], "supabase.gotrue");
  } finally {
    cleanup();
  }
});

test("non-supabase URL produces no child spans", () => {
  const { tracer, exporter, cleanup } = setupTracer();
  try {
    const fetchSpan = tracer.startSpan("HTTP GET");
    createSupabaseChildSpans(tracer, "sess-xyz", fetchSpan, "https://api.example.com/data", "GET", 200);
    fetchSpan.end();

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1, "only the fetch span, no supabase children");
  } finally {
    cleanup();
  }
});
