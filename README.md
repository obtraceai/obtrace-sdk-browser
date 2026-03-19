# obtrace-sdk-browser

Browser SDK for Obtrace with frontend wrappers.

## Install

```bash
npm install @obtrace/sdk-browser
# or
bun add @obtrace/sdk-browser
```

## Quickstart

### Simplified setup

The API key resolves `tenant_id`, `project_id`, `app_id`, and `env` automatically on the server side, so only three fields are needed:

```ts
import { initBrowserSDK } from "@obtrace/sdk-browser/browser";

const sdk = initBrowserSDK({
  apiKey: "obt_live_...",
  ingestBaseUrl: "https://ingest.obtrace.io",
  serviceName: "web-app",
});
```

### Full configuration

For advanced use cases you can override the resolved values explicitly:

```ts
import { initBrowserSDK, SemanticMetrics } from "@obtrace/sdk-browser/browser";

const sdk = initBrowserSDK({
  apiKey: "<API_KEY>",
  ingestBaseUrl: "https://inject.obtrace.ai",
  serviceName: "web-app",
  tenantId: "tenant-prod",
  projectId: "project-prod",
  appId: "web",
  env: "prod"
});

sdk.metric(SemanticMetrics.webVitalLcp, 2400, "ms", {
  route: "/checkout",
});

sdk.span({
  name: "ui.checkout.submit",
  attrs: {
    "feature.name": "checkout",
    "ui.action": "submit",
  },
});
```

## Canonical metrics and custom spans

- Use `SemanticMetrics` whenever possible so dashboards, explorer and AI work against the global metric catalog.
- Browser vitals still emit built-in aliases internally, but the platform normalizes them to canonical names such as `web.vital.lcp` and `web.vital.inp`.
- Custom spans use `sdk.span({ name, attrs, statusCode, statusMessage })`.

## Frontend wrappers

- Vite
- React
- Next (browser side)
- Vue
- Angular
- Svelte

## Examples

- `examples/browser/example.ts`
- `examples/react-vite/main.tsx`
- `examples/vue-vite/main.ts`

## Docs

- `docs/getting-started.md`
- `docs/browser.md`
- `docs/security.md`
- `docs/troubleshooting.md`
