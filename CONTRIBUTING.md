# Contributing

## Workflow

1. Create a branch from `main`.
2. Make focused changes with clear commit messages.
3. Run local validation before opening a PR.
4. Open a PR with context, scope, and validation evidence.

## Commit Style

Use concise, imperative commit messages:
- `feat: add node middleware example`
- `fix: handle missing api key`
- `docs: update quickstart`

## Validation

Run only what applies to your repository before pushing:
- Install dependencies (`npm ci`, `pip install -e .`, etc.)
- Build/typecheck/tests
- Lint/format checks

## Pull Requests

PR description should include:
- What changed
- Why it changed
- How it was validated
- Any breaking changes

## Security

- Never commit secrets, tokens, or private keys.
- Use env vars for credentials.
- Keep examples pointed to safe defaults.
