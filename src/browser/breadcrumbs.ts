export interface Breadcrumb {
  timestamp: number;
  category: string;
  message: string;
  level: "debug" | "info" | "warn" | "error" | "fatal";
  data?: Record<string, unknown>;
}

const MAX_BREADCRUMBS = 100;
const buffer: Breadcrumb[] = [];

export function addBreadcrumb(crumb: Breadcrumb): void {
  buffer.push(crumb);
  if (buffer.length > MAX_BREADCRUMBS) {
    buffer.shift();
  }
}

export function getBreadcrumbs(): Breadcrumb[] {
  return buffer.slice();
}

export function clearBreadcrumbs(): void {
  buffer.length = 0;
}

export function getElementSelector(el: Element | null): string {
  if (!el) return "";
  let sel = el.tagName.toLowerCase();
  if (el.id) sel += `#${el.id}`;
  else if (el.className && typeof el.className === "string") {
    sel += `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}`;
  }
  return sel;
}

export function installClickBreadcrumbs(): () => void {
  if (typeof document === "undefined") return () => {};
  const handler = (ev: MouseEvent) => {
    const target = ev.target as Element | null;
    addBreadcrumb({
      timestamp: Date.now(),
      category: "ui.click",
      message: getElementSelector(target),
      level: "info",
      data: { x: ev.clientX, y: ev.clientY },
    });
  };
  document.addEventListener("click", handler, true);
  return () => document.removeEventListener("click", handler, true);
}
