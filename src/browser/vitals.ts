import type { Meter } from "@opentelemetry/api";

export function installWebVitals(meter: Meter, reportAllChanges: boolean): () => void {
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") {
    return () => undefined;
  }

  const fcpGauge = meter.createGauge("web_vital_fcp_ms", { unit: "ms" });
  const lcpGauge = meter.createGauge("web_vital_lcp_ms", { unit: "ms" });
  const clsGauge = meter.createGauge("web_vital_cls", { unit: "1" });
  const inpGauge = meter.createGauge("web_vital_inp_ms", { unit: "ms" });
  const ttfbGauge = meter.createGauge("web_vital_ttfb_ms", { unit: "ms" });

  const cleanups: Array<() => void> = [];

  const observe = (type: string, cb: (entry: PerformanceEntry) => void) => {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          cb(entry);
          if (!reportAllChanges) {
            break;
          }
        }
      });
      observer.observe({ type, buffered: true });
      cleanups.push(() => observer.disconnect());
    } catch {
      return;
    }
  };

  observe("paint", (entry) => {
    if (entry.name === "first-contentful-paint") {
      fcpGauge.record(entry.startTime, { vital: "fcp" });
    }
  });

  observe("largest-contentful-paint", (entry) => {
    lcpGauge.record(entry.startTime, { vital: "lcp" });
  });

  observe("layout-shift", (entry) => {
    const ls = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
    if (ls.hadRecentInput) {
      return;
    }
    clsGauge.record(ls.value ?? 0, { vital: "cls" });
  });

  observe("event", (entry) => {
    const ev = entry as PerformanceEntry & { duration?: number; name?: string };
    if (ev.duration && ev.duration > 0) {
      inpGauge.record(ev.duration, { vital: "inp", event: ev.name ?? "event" });
    }
  });

  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (nav) {
    ttfbGauge.record(nav.responseStart, { vital: "ttfb" });
  }

  return () => {
    for (const c of cleanups) {
      c();
    }
  };
}
