import type { Meter } from "@opentelemetry/api";

interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export function installMemoryTracking(meter: Meter): () => void {
  if (typeof window === "undefined") return () => {};

  const perf = performance as unknown as { memory?: MemoryInfo };
  if (!perf.memory) return () => {};

  const usedGauge = meter.createGauge("browser.memory.used_js_heap", { unit: "By" });
  const totalGauge = meter.createGauge("browser.memory.total_js_heap", { unit: "By" });
  const limitGauge = meter.createGauge("browser.memory.heap_limit", { unit: "By" });

  const timer = setInterval(() => {
    const mem = perf.memory;
    if (!mem) return;
    usedGauge.record(mem.usedJSHeapSize);
    totalGauge.record(mem.totalJSHeapSize);
    limitGauge.record(mem.jsHeapSizeLimit);
  }, 30000);

  return () => clearInterval(timer);
}
