export type Signal = "traces" | "logs" | "metrics";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface ObtraceResource {
  serviceName?: string;
  serviceVersion?: string;
  deploymentEnv?: string;
  runtimeName?: string;
  runtimeVersion?: string;
  appNamespace?: string;
  appName?: string;
  appInstanceId?: string;
  [k: string]: string | number | boolean | undefined;
}

export interface ObtraceSDKConfig {
  apiKey: string;
  ingestBaseUrl?: string;
  tenantId?: string;
  projectId?: string;
  appId?: string;
  env?: string;
  serviceName: string;
  serviceVersion?: string;
  defaultHeaders?: Record<string, string>;
  requestTimeoutMs?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  maxQueueBytes?: number;
  replay?: {
    enabled: boolean;
    flushIntervalMs?: number;
    maxChunkBytes?: number;
    captureNetworkRecipes?: boolean;
    sessionStorageKey?: string;
    blockClass?: string;
    maskTextClass?: string;
    maskAllInputs?: boolean;
    sampling?: ReplaySamplingConfig;
  };
  vitals?: {
    enabled: boolean;
    reportAllChanges?: boolean;
  };
  propagation?: {
    enabled: boolean;
    headerName?: string;
    sessionHeaderName?: string;
  };
  validateSemanticMetrics?: boolean;
  debug?: boolean;
  instrumentGlobalFetch?: boolean;
  instrumentXHR?: boolean;
  patchConsole?: boolean;
  captureConsole?: boolean;
  tracesSampleRate?: number;
  replaySampleRate?: number;
}

export interface SDKContext {
  traceId?: string;
  spanId?: string;
  traceState?: string;
  baggage?: string;
  sessionId?: string;
  routeTemplate?: string;
  endpoint?: string;
  method?: string;
  statusCode?: number;
  attrs?: Record<string, string | number | boolean>;
}

export interface ReplayStep {
  step_id: number;
  method: string;
  url_template: string;
  headers?: Record<string, string>;
  body_b64?: string;
}

export interface ReplayChunk {
  replay_id: string;
  seq: number;
  started_at_ms: number;
  ended_at_ms: number;
  events: import("@rrweb/types").eventWithTime[];
  metadata?: Record<string, unknown>;
}

export interface ReplaySamplingConfig {
  mousemove?: boolean | number;
  scroll?: number;
  input?: "all" | "last";
}

export interface HTTPRecord {
  ts: number;
  method: string;
  url: string;
  status?: number;
  dur_ms?: number;
  req_headers?: Record<string, string>;
  res_headers?: Record<string, string>;
  req_body_b64?: string;
  res_body_b64?: string;
}

export interface QueuedPayload {
  endpoint: string;
  contentType: string;
  body: string;
}
