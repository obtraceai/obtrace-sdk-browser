# Troubleshooting

## No data arriving
1. Verify `apiKey` and `ingestBaseUrl`.
2. Check ingest endpoint availability (`/healthz`).
3. Enable `debug: true` and inspect client error logs.

## 429 responses
- Quota/rate-limit is enforced server-side.
- Check `X-Rate-Limit-Reason` in responses.

## Replay not visible
- Ensure replay is enabled and flush is triggered on page hide/unload.
- Verify `/ingest/replay/chunk` accepts payloads.
