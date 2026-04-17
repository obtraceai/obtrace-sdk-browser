import type { Tracer } from "@opentelemetry/api";

export function installLongTaskDetection(tracer: Tracer): () => void {
  if (typeof window === "undefined" || typeof PerformanceObserver === "undefined") return () => {};

  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration < 50) continue;
      const span = tracer.startSpan("browser.longtask", {
        attributes: {
          "longtask.duration_ms": entry.duration,
          "longtask.name": entry.name,
        },
      });
      span.end();
    }
  });

  try {
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    return () => {};
  }

  return () => observer.disconnect();
}
