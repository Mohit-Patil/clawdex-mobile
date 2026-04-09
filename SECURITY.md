# Security Policy

## Supported Scope

`clawdex-mobile` is intended for trusted/private networks only.
It is not designed to be exposed directly to the public internet.

Security reports are especially valuable for:

- bridge authentication and authorization issues
- terminal execution or git mutation bypasses
- attachment or local file exposure
- token leakage
- cross-origin or preview-shell vulnerabilities
- unsafe defaults that could expose a private bridge externally

## Reporting a Vulnerability

Please do not file public GitHub issues for security-sensitive reports.

Instead:

1. Use GitHub private vulnerability reporting if available for the repository.
2. If needed, email `mohitpatil973@gmail.com` with:
   - a clear summary
   - impact
   - reproduction steps
   - affected versions or commit range
   - any suggested mitigation

We will acknowledge the report as soon as practical and work toward a fix and coordinated disclosure.

## Security Notes for Users

- Prefer bearer-token auth.
- Treat `BRIDGE_ALLOW_INSECURE_NO_AUTH=true` as local debugging only.
- Do not expose the bridge directly to the public internet.
- Review environment and runtime guidance in `docs/setup-and-operations.md` and `docs/troubleshooting.md`.
