import type { Meter } from "@opentelemetry/api";

export function installResourceTiming(meter: Meter): () => void {
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") return () => {};

  const gauge = meter.createGauge("browser.resource.duration", { unit: "ms" });

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const res = entry as PerformanceResourceTiming;
      if (res.duration < 100) continue;
      gauge.record(res.duration, {
        "resource.type": res.initiatorType || "other",
        "resource.name": res.name.split("?")[0].split("/").pop() || res.name.slice(0, 80),
        "resource.transfer_size": res.transferSize || 0,
      });
    }
  });

  try {
    observer.observe({ type: "resource", buffered: false });
  } catch {
    return () => {};
  }

  return () => observer.disconnect();
}
