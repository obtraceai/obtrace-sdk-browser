# obtrace-sdk-browser

Browser SDK for Obtrace with frontend wrappers.

## Install

```bash
npm install @obtrace/sdk-browser
# or
bun add @obtrace/sdk-browser
```

## Quickstart

```ts
import { initBrowserSDK } from "@obtrace/sdk-browser/browser";

const sdk = initBrowserSDK({
  apiKey: "<API_KEY>",
  ingestBaseUrl: "https://inject.obtrace.ai",
  serviceName: "web-app",
  tenantId: "tenant-prod",
  projectId: "project-prod",
  appId: "web",
  env: "prod"
});
```

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
