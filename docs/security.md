# Security and Data Handling

## Sanitization
- Strips/avoids sensitive headers (`authorization`, `cookie`, `set-cookie`, keys).
- Masks sensitive input-like fields.
- Truncates oversized fragments.

## Principle
SDK never owns business policy decisions.
All product/business decisions live in ingest/control-plane.
