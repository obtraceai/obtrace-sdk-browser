# Browser SDK

## Features
- OTLP logs/traces/metrics
- Global error capture
- Web vitals
- Fetch instrumentation with distributed propagation (`traceparent`, `tracestate`, `baggage`)
- Replay and recipe capture
- DOM reconstruction (snapshot + mutations + input + scroll + viewport + SPA navigation)

## Example

```ts
const sdk = initBrowserSDK({
  apiKey: "<API_KEY>",
  ingestBaseUrl: "https://inject.obtrace.ai",
  serviceName: "checkout-web",
  replay: { enabled: true, captureNetworkRecipes: true },
  vitals: { enabled: true }
});

const obFetch = sdk.instrumentFetch();
await obFetch("/api/checkout", { method: "POST", body: JSON.stringify({ cartId: "c1" }) });
sdk.log("info", "checkout loaded");
```
