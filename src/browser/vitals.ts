import type { ObtraceClient } from "../core/client";

export function installWebVitals(client: ObtraceClient, reportAllChanges: boolean): () => void {
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") {
    return () => undefined;
  }

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
      client.metric("web_vital_fcp_ms", entry.startTime, "ms", {
        attrs: { vital: "fcp" }
      });
    }
  });

  observe("largest-contentful-paint", (entry) => {
    client.metric("web_vital_lcp_ms", entry.startTime, "ms", {
      attrs: { vital: "lcp" }
    });
  });

  observe("layout-shift", (entry) => {
    const ls = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
    if (ls.hadRecentInput) {
      return;
    }
    client.metric("web_vital_cls", ls.value ?? 0, "1", {
      attrs: { vital: "cls" }
    });
  });

  observe("event", (entry) => {
    const ev = entry as PerformanceEntry & { duration?: number; name?: string };
    if (ev.duration && ev.duration > 0) {
      client.metric("web_vital_inp_ms", ev.duration, "ms", {
        attrs: { vital: "inp", event: ev.name ?? "event" }
      });
    }
  });

  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (nav) {
    client.metric("web_vital_ttfb_ms", nav.responseStart, "ms", {
      attrs: { vital: "ttfb" }
    });
  }

  return () => {
    for (const c of cleanups) {
      c();
    }
  };
}
