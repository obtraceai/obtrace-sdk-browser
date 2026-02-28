import type { ObtraceSDKConfig } from "../../shared/types";
import { initBrowserSDK } from "../../browser/index";

export function createAngularObtrace(config: ObtraceSDKConfig) {
  return initBrowserSDK(config);
}
