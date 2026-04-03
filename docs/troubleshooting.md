# Troubleshooting

## No data arriving
1. Verify `apiKey` and `ingestBaseUrl`.
2. Check ingest endpoint availability (`/healthz`).
3. Verify `serviceName` matches the connected app name in the project, or an explicit alias for that app.
4. Enable `debug: true` and inspect client error logs.

## 429 responses
- Quota/rate-limit is enforced server-side.
- Check `X-Rate-Limit-Reason` in responses.

## Replay not visible
- Ensure replay is enabled and flush is triggered on page hide/unload.
- Verify `/ingest/replay/chunk` accepts payloads.
- Verify the browser app name is valid for the project. Unknown names are rejected before replay and incident correlation.
