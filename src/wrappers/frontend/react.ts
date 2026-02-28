import type { ObtraceSDKConfig } from "../../shared/types";
import { initBrowserSDK } from "../../browser/index";

export type ReactObtraceHandle = ReturnType<typeof initBrowserSDK>;

export function createReactObtrace(config: ObtraceSDKConfig): ReactObtraceHandle {
  return initBrowserSDK(config);
}
