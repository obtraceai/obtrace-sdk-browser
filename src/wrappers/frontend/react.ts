import type { ObtraceSDKConfig, SDKContext } from "../../shared/types";
import { initBrowserSDK, type BrowserSDK } from "../../browser/index";

let _sdk: BrowserSDK | null = null;
const _originalFetch = typeof window !== "undefined" ? window.fetch.bind(window) : undefined;

export function obtrace(config: ObtraceSDKConfig): BrowserSDK {
  if (_sdk) return _sdk;
  _sdk = initBrowserSDK(config);
  if (typeof window !== "undefined" && _originalFetch) {
    window.fetch = _sdk.instrumentFetch();
  }
  return _sdk;
}

export function getObtrace(): BrowserSDK | null {
  return _sdk;
}

export function obtraceLog(level: "debug" | "info" | "warn" | "error" | "fatal", message: string, context?: SDKContext) {
  _sdk?.log(level, message, context);
}

export function obtraceMetric(name: string, value: number, unit?: string, context?: SDKContext) {
  _sdk?.metric(name, value, unit, context);
}

export function obtraceError(error: unknown, context?: SDKContext) {
  _sdk?.captureException(error, context);
}

export type { BrowserSDK, ObtraceSDKConfig, SDKContext };
