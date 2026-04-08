import type { Meter } from "@opentelemetry/api";
import { getElementSelector } from "./breadcrumbs";

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
          if (!reportAllChanges) break;
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
    const lcp = entry as PerformanceEntry & { element?: Element };
    const attrs: Record<string, string | number> = { vital: "lcp" };
    if (lcp.element) {
      attrs["lcp.element"] = getElementSelector(lcp.element);
    }
    lcpGauge.record(entry.startTime, attrs);
  });

  observe("layout-shift", (entry) => {
    const ls = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean; sources?: Array<{ node?: Element }> };
    if (ls.hadRecentInput) return;
    const attrs: Record<string, string | number> = { vital: "cls" };
    if (ls.sources && ls.sources.length > 0 && ls.sources[0].node) {
      attrs["cls.element"] = getElementSelector(ls.sources[0].node);
    }
    clsGauge.record(ls.value ?? 0, attrs);
  });

  const interactionDurations = new Map<number, number>();

  observe("event", (entry) => {
    const ev = entry as PerformanceEntry & { duration?: number; interactionId?: number };
    if (!ev.interactionId || ev.interactionId === 0) return;
    if (!ev.duration || ev.duration <= 0) return;

    const existing = interactionDurations.get(ev.interactionId) ?? 0;
    if (ev.duration > existing) {
      interactionDurations.set(ev.interactionId, ev.duration);
    }

    if (interactionDurations.size > 100) {
      const entries = [...interactionDurations.entries()].sort((a, b) => b[1] - a[1]);
      interactionDurations.clear();
      for (const [k, v] of entries.slice(0, 50)) interactionDurations.set(k, v);
    }
    if (interactionDurations.size > 10) {
      const sorted = [...interactionDurations.values()].sort((a, b) => b - a);
      const p98Index = Math.max(0, Math.ceil(sorted.length * 0.02) - 1);
      inpGauge.record(sorted[p98Index], { vital: "inp" });
    }
  });

  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (nav) {
    ttfbGauge.record(nav.responseStart, { vital: "ttfb" });
  }

  return () => {
    if (interactionDurations.size > 0) {
      const sorted = [...interactionDurations.values()].sort((a, b) => b - a);
      const p98Index = Math.max(0, Math.ceil(sorted.length * 0.02) - 1);
      inpGauge.record(sorted[p98Index], { vital: "inp" });
    }
    for (const c of cleanups) c();
  };
}
