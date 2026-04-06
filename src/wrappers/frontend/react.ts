import type { ObtraceSDKConfig, SDKContext } from "../../shared/types";
import { initBrowserSDK, type BrowserSDK } from "../../browser/index";

let _sdk: BrowserSDK | null = null;

export function obtrace(config: ObtraceSDKConfig): BrowserSDK {
  if (_sdk) return _sdk;
  _sdk = initBrowserSDK(config);
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

interface ObtraceErrorBoundaryProps {
  children: unknown;
  fallback?: unknown;
  onError?: (error: Error, errorInfo: { componentStack?: string }) => void;
}

interface ObtraceErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

let _React: any = null;
function getReact(): any {
  if (_React) return _React;
  try {
    _React = require("react");
  } catch {
    try {
      _React = (globalThis as any).__obtrace_react;
    } catch {}
  }
  return _React;
}

export function createObtraceErrorBoundary(React: any): any {
  const Component = React.Component;

  class ObtraceErrorBoundary extends Component<ObtraceErrorBoundaryProps, ObtraceErrorBoundaryState> {
    constructor(props: ObtraceErrorBoundaryProps) {
      super(props);
      this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): ObtraceErrorBoundaryState {
      return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: any): void {
      const sdk = getObtrace();
      if (sdk) {
        const stack = errorInfo?.componentStack || "";
        sdk.captureException(error, {
          attrs: {
            "error.type": "react.render",
            "error.component_stack": typeof stack === "string" ? stack.slice(0, 4096) : "",
          },
        });
      }
      this.props.onError?.(error, errorInfo);
    }

    render(): unknown {
      if (this.state.hasError) {
        return this.props.fallback ?? null;
      }
      return this.props.children;
    }
  }

  return ObtraceErrorBoundary;
}

let _ObtraceErrorBoundary: any = null;

export function getObtraceErrorBoundary(): any {
  if (_ObtraceErrorBoundary) return _ObtraceErrorBoundary;
  const React = getReact();
  if (!React) throw new Error("React not found. Use createObtraceErrorBoundary(React) instead.");
  _ObtraceErrorBoundary = createObtraceErrorBoundary(React);
  return _ObtraceErrorBoundary;
}

export type { BrowserSDK, ObtraceSDKConfig, SDKContext };
