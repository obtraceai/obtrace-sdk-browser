import type { LogLevel, ObtraceResource, SDKContext } from "../shared/types";
import { nowUnixNano, safeJson } from "../shared/utils";

function attrKV(attrs?: Record<string, string | number | boolean>) {
  if (!attrs) {
    return [];
  }
  return Object.entries(attrs).map(([key, value]) => {
    if (typeof value === "string") {
      return { key, value: { stringValue: value } };
    }
    if (typeof value === "number") {
      return { key, value: { doubleValue: value } };
    }
    return { key, value: { boolValue: value } };
  });
}

function resourceAttrs(resource: ObtraceResource, scope: { tenantId?: string; projectId?: string; appId?: string; env?: string }) {
  const base: Record<string, string | number | boolean> = {
    "service.name": resource.serviceName ?? "unknown",
    "service.version": resource.serviceVersion ?? "0.0.0",
    "deployment.environment": resource.deploymentEnv ?? scope.env ?? "dev"
  };

  if (scope.tenantId) base["obtrace.tenant_id"] = scope.tenantId;
  if (scope.projectId) base["obtrace.project_id"] = scope.projectId;
  if (scope.appId) base["obtrace.app_id"] = scope.appId;
  if (scope.env) base["obtrace.env"] = scope.env;

  for (const [k, v] of Object.entries(resource)) {
    if (v !== undefined && !(k in base)) {
      base[k] = v;
    }
  }
  return attrKV(base);
}

export function buildLogsPayload(input: {
  resource: ObtraceResource;
  scope: { tenantId?: string; projectId?: string; appId?: string; env?: string };
  level: LogLevel;
  body: string;
  context?: SDKContext;
}): string {
  const contextAttrs: Record<string, string | number | boolean> = {
    "obtrace.log.level": input.level
  };
  if (input.context?.traceId) contextAttrs["obtrace.trace_id"] = input.context.traceId;
  if (input.context?.spanId) contextAttrs["obtrace.span_id"] = input.context.spanId;
  if (input.context?.sessionId) contextAttrs["obtrace.session_id"] = input.context.sessionId;
  if (input.context?.routeTemplate) contextAttrs["obtrace.route_template"] = input.context.routeTemplate;
  if (input.context?.endpoint) contextAttrs["obtrace.endpoint"] = input.context.endpoint;
  if (input.context?.method) contextAttrs["obtrace.method"] = input.context.method;
  if (typeof input.context?.statusCode === "number") contextAttrs["obtrace.status_code"] = input.context.statusCode;

  if (input.context?.attrs) {
    for (const [k, v] of Object.entries(input.context.attrs)) {
      contextAttrs[`obtrace.attr.${k}`] = v;
    }
  }

  const payload = {
    resourceLogs: [
      {
        resource: { attributes: resourceAttrs(input.resource, input.scope) },
        scopeLogs: [
          {
            scope: { name: "@obtrace/sdk-js", version: "1.0.0" },
            logRecords: [
              {
                timeUnixNano: nowUnixNano(),
                severityText: input.level.toUpperCase(),
                body: { stringValue: input.body },
                attributes: attrKV(contextAttrs)
              }
            ]
          }
        ]
      }
    ]
  };

  return safeJson(payload);
}

export function buildMetricPayload(input: {
  resource: ObtraceResource;
  scope: { tenantId?: string; projectId?: string; appId?: string; env?: string };
  metricName: string;
  value: number;
  unit?: string;
  context?: SDKContext;
}): string {
  const attrs = attrKV(input.context?.attrs);
  const now = nowUnixNano();
  const payload = {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttrs(input.resource, input.scope) },
        scopeMetrics: [
          {
            scope: { name: "@obtrace/sdk-js", version: "1.0.0" },
            metrics: [
              {
                name: input.metricName,
                unit: input.unit ?? "1",
                gauge: {
                  dataPoints: [
                    {
                      timeUnixNano: now,
                      asDouble: input.value,
                      attributes: attrs
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  };
  return safeJson(payload);
}

export function buildSpanPayload(input: {
  resource: ObtraceResource;
  scope: { tenantId?: string; projectId?: string; appId?: string; env?: string };
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startUnixNano: string;
  endUnixNano: string;
  statusCode?: number;
  statusMessage?: string;
  attrs?: Record<string, string | number | boolean>;
}): string {
  const payload = {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs(input.resource, input.scope) },
        scopeSpans: [
          {
            scope: { name: "@obtrace/sdk-js", version: "1.0.0" },
            spans: [
              {
                traceId: input.traceId,
                spanId: input.spanId,
                parentSpanId: input.parentSpanId,
                name: input.name,
                kind: 3,
                startTimeUnixNano: input.startUnixNano,
                endTimeUnixNano: input.endUnixNano,
                attributes: attrKV(input.attrs),
                status: {
                  code: typeof input.statusCode === "number" && input.statusCode >= 400 ? 2 : 1,
                  message: input.statusMessage ?? ""
                }
              }
            ]
          }
        ]
      }
    ]
  };
  return safeJson(payload);
}
