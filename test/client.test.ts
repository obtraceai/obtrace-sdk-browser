import test from "node:test";
import assert from "node:assert/strict";

import { ObtraceClient } from "../src/core/client.ts";

test("constructor validates required fields", () => {
  assert.throws(() => new ObtraceClient({} as never), /apiKey, ingestBaseUrl and serviceName are required/);
});

test("injectPropagation sets session header", () => {
  const client = new ObtraceClient({
    apiKey: "k",
    ingestBaseUrl: "http://localhost:19090",
    serviceName: "svc"
  });
  const headers = client.injectPropagation(undefined, {
    sessionId: "sess-1"
  });
  assert.equal(headers.get("x-obtrace-session-id"), "sess-1");
  client.stop();
});
