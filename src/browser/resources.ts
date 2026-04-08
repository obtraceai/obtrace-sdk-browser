import type { Meter } from "@opentelemetry/api";

export function installResourceTiming(meter: Meter): () => void {
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") return () => {};

  const gauge = meter.createGauge("browser.resource.duration", { unit: "ms" });

  let pendingEntries: PerformanceResourceTiming[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushEntries = () => {
    flushTimer = null;
    const batch = pendingEntries;
    pendingEntries = [];
    for (const res of batch) {
      const name = typeof res.name === "string" ? res.name : "";
      const shortName = name.split("?")[0].split("/").pop() || name.slice(0, 80) || "unknown";
      gauge.record(res.duration, {
        "resource.type": String(res.initiatorType || "other"),
        "resource.name": String(shortName),
        "resource.transfer_size": Number(res.transferSize) || 0,
      });
    }
  };

  const observer = new PerformanceObserver((list) => {
    try {
      for (const entry of list.getEntries()) {
        const res = entry as PerformanceResourceTiming;
        if (res.duration < 100) continue;
        pendingEntries.push(res);
      }
      if (pendingEntries.length > 0 && !flushTimer) {
        flushTimer = setTimeout(flushEntries, 1000);
      }
    } catch {}
  });

  try {
    observer.observe({ type: "resource", buffered: false });
  } catch {
    return () => {};
  }

  return () => {
    observer.disconnect();
    if (flushTimer) clearTimeout(flushTimer);
  };
}
