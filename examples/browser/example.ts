import { initBrowserSDK } from "../../src/browser/index";
import { SemanticMetrics } from "../../src/shared/semantic_metrics";

const sdk = initBrowserSDK({
  apiKey: "devkey",
  tenantId: "tenant-dev",
  projectId: "project-dev",
  appId: "web",
  env: "dev",
  serviceName: "example-web",
  replay: { enabled: true, captureNetworkRecipes: true },
  vitals: { enabled: true },
  propagation: { enabled: true },
  debug: true
});

const obFetch = sdk.instrumentFetch();
void obFetch("https://httpbin.org/get");
sdk.log("info", "browser sdk initialized");
sdk.metric(SemanticMetrics.webVitalLcp, 2400, "ms", { route: "/checkout" });
sdk.span({
  name: "ui.checkout.submit",
  attrs: {
    "feature.name": "checkout",
    "ui.action": "submit"
  }
});

window.addEventListener("beforeunload", () => {
  void sdk.shutdown();
});
