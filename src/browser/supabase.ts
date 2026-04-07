import { type Span } from "@opentelemetry/api";

const SUPABASE_DOMAIN = ".supabase.co";

interface SupabaseParsed {
  ref: string;
  service: string;
  operation: string;
  table: string;
  detail: string;
}

export function isSupabaseURL(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith(SUPABASE_DOMAIN);
  } catch {
    return false;
  }
}

export function parseSupabaseURL(url: string, method: string): SupabaseParsed | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!u.hostname.endsWith(SUPABASE_DOMAIN)) return null;

  const ref = u.hostname.replace(SUPABASE_DOMAIN, "");
  const path = u.pathname;
  const segments = path.split("/").filter(Boolean);

  if (segments[0] === "rest" && segments[1] === "v1" && segments[2]) {
    const table = segments[2];
    const op = restMethodToOp(method);
    const select = u.searchParams.get("select") || "*";
    const filters = extractFilters(u.searchParams);
    const detail = op === "SELECT" ? `${op} ${select} FROM ${table}` : `${op} ${table}`;
    return { ref, service: "postgrest", operation: op, table, detail: filters ? `${detail} WHERE ${filters}` : detail };
  }

  if (segments[0] === "auth" && segments[1] === "v1") {
    const action = segments[2] || "session";
    const op = authActionToOp(action);
    return { ref, service: "auth", operation: op, table: "", detail: `AUTH ${op}` };
  }

  if (segments[0] === "storage" && segments[1] === "v1") {
    const subCmd = segments[2] || "object";
    const bucket = segments[3] || "";
    const filePath = segments.slice(4).join("/");
    const op = `${method.toUpperCase()} ${subCmd}`;
    return { ref, service: "storage", operation: op, table: "", detail: bucket ? `STORAGE ${op} ${bucket}/${filePath}` : `STORAGE ${op}` };
  }

  if (segments[0] === "realtime") {
    return { ref, service: "realtime", operation: "subscribe", table: "", detail: "REALTIME subscribe" };
  }

  if (segments[0] === "functions" && segments[1] === "v1" && segments[2]) {
    const fnName = segments[2];
    return { ref, service: "edge-function", operation: `invoke:${fnName}`, table: "", detail: `EDGE FUNCTION ${fnName}` };
  }

  return { ref, service: "unknown", operation: method.toUpperCase(), table: "", detail: `${method.toUpperCase()} ${path}` };
}

function restMethodToOp(method: string): string {
  switch (method.toUpperCase()) {
    case "GET": return "SELECT";
    case "POST": return "INSERT";
    case "PATCH": return "UPDATE";
    case "PUT": return "UPSERT";
    case "DELETE": return "DELETE";
    default: return method.toUpperCase();
  }
}

function authActionToOp(action: string): string {
  switch (action) {
    case "token": return "login";
    case "signup": return "signup";
    case "logout": return "logout";
    case "recover": return "recover";
    case "magiclink": return "magic_link";
    case "otp": return "otp";
    case "user": return "get_user";
    case "callback": return "oauth_callback";
    default: return action;
  }
}

function extractFilters(params: URLSearchParams): string {
  const filters: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "select" || key === "apikey" || key === "order" || key === "limit" || key === "offset") continue;
    const match = value.match(/^(eq|neq|gt|gte|lt|lte|like|ilike|is|in|cs|cd|not)\.(.+)/);
    if (match) {
      filters.push(`${key} ${match[1]} ${match[2]}`);
    }
  }
  return filters.join(" AND ");
}

export function enrichSupabaseSpan(span: Span, url: string, method: string): void {
  const parsed = parseSupabaseURL(url, method);
  if (!parsed) return;

  span.setAttribute("supabase.ref", parsed.ref);
  span.setAttribute("supabase.service", parsed.service);
  span.setAttribute("supabase.operation", parsed.operation);
  span.setAttribute("supabase.detail", parsed.detail);
  span.setAttribute("peer.service", `supabase.${parsed.service}`);

  if (parsed.service === "postgrest") {
    span.setAttribute("db.system", "postgresql");
    span.setAttribute("db.operation", parsed.operation);
    if (parsed.table) span.setAttribute("db.sql.table", parsed.table);
  }

  span.updateName(`supabase.${parsed.service} ${parsed.detail}`);
}

