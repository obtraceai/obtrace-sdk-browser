import assert from "node:assert/strict";
import test from "node:test";

import { SemanticMetrics } from "../src/index.ts";

test("SemanticMetrics exposes canonical browser metrics", () => {
  assert.equal(SemanticMetrics.runtimeCpuUtilization, "runtime.cpu.utilization");
  assert.equal(SemanticMetrics.webVitalLcp, "web.vital.lcp");
  assert.equal(SemanticMetrics.webVitalCls, "web.vital.cls");
});
