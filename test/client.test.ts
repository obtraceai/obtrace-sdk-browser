import test from "node:test";
import assert from "node:assert/strict";

import { ObtraceClient } from "../src/core/client.ts";

test("constructor validates required fields", () => {
  assert.throws(() => new ObtraceClient({} as never), /apiKey, ingestBaseUrl and serviceName are required/);
});

test("injectPropagation sets traceparent and session header", () => {
  const client = new ObtraceClient({
    apiKey: "k",
    ingestBaseUrl: "http://localhost:19090",
    serviceName: "svc"
  });
  const headers = client.injectPropagation(undefined, {
    traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    spanId: "bbbbbbbbbbbbbbbb",
    sessionId: "sess-1"
  });
  assert.equal(headers.get("traceparent"), "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
  assert.equal(headers.get("x-obtrace-session-id"), "sess-1");
  client.stop();
});

test("injectPropagation keeps existing traceparent", () => {
  const client = new ObtraceClient({
    apiKey: "k",
    ingestBaseUrl: "http://localhost:19090",
    serviceName: "svc"
  });
  const headers = client.injectPropagation({ traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" }, {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef"
  });
  assert.equal(headers.get("traceparent"), "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
  client.stop();
});
