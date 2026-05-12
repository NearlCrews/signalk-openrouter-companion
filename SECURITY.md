# Security Policy

This is a beta project. The plugin runs inside a Signal K server on a vessel and makes outbound HTTPS calls to OpenRouter, so the most important security boundary is your OpenRouter API key.

## Supported versions

Only the latest release line is supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | Yes (current)      |
| < 0.2   | No                 |

## Reporting a vulnerability

**Do not open a public GitHub issue for a security report.**

Use one of:

1. **GitHub Security Advisory** (preferred): open the [Security tab](https://github.com/NearlCrews/signalk-openrouter-companion/security) and click "Report a vulnerability".
2. **Direct contact**: reach the maintainer via GitHub with "SECURITY" in the subject line.

Include:

- The vulnerability class (e.g., credential leak, injection, denial of service).
- Affected file paths and the smallest reproducer you can provide.
- An impact assessment.
- Any suggested fix or mitigation.

A first reply is sent within a few business days. Severity and a fix timeline follow once the issue is reproduced.

## Disclosure timeline

- Initial response: within 48 hours of the report on a best-effort basis (this is a one-maintainer project, not a 24/7 security team).
- Investigation: within 7 days, severity and scope are confirmed.
- Fix: critical within 1 week, high within 2 weeks, medium within 1 month, low best-effort.
- Public disclosure: after a patched release is published and users have had at least 7 days to update.

## What is in scope

- The plugin's own code under `src/`.
- The plugin's published package surface (npm tarball contents, when published).
- Dependencies declared in `package.json` (one direct runtime dep today: `croner`).

Out of scope:

- The Signal K server itself: report to [SignalK/signalk-server](https://github.com/SignalK/signalk-server).
- OpenRouter's API or any individual model behavior: report to OpenRouter.
- QuestDB: report to [questdb/questdb](https://github.com/questdb/questdb).
- The user's local NMEA 2000 bus.

## Sensitive data this plugin handles

- **OpenRouter API key**. Stored only in Signal K's plugin config (`~/.signalk/plugin-config-data/signalk-openrouter-companion.json`) and is never logged. The schema marks the field with `ui:widget: 'password'`. If you see the key echoed in logs, that's a bug, please report it.
- **Vessel telemetry sent to OpenRouter**: each analyzer's `buildPrompt` includes the relevant subset of telemetry (engine RPM, fuel rate, battery voltage / SoC, etc.). No GPS coordinates and no identifying metadata are included. If you do not want telemetry leaving the boat, do not enable the analyzers.
- **Generated reports**: written locally to `<plugin-config-data>/signalk-openrouter-companion/reports.jsonl` and published as Signal K notifications. They contain the same telemetry that was sent to OpenRouter plus the LLM's prose response.

## Hardening recommendations for operators

- Use an OpenRouter API key dedicated to this plugin so you can revoke it without impacting other tools.
- Set `openrouter.maxCallsPerDay` to a hard cap so a stuck loop can't burn through credit.
- Keep the Signal K server's admin UI behind authentication. The plugin's PUT triggers are routed through `app.registerPutHandler`, so anyone who can write `vessels.self` paths on your SK server can fire analyzer runs.
- Keep your Node.js runtime up to date.

## Known security considerations

- **LLM prompts are not sandboxed**. If an attacker can write arbitrary deltas to the watched paths (`propulsion.*`, `electrical.batteries.*`), they can influence the LLM's input. Output is published only as Signal K notifications, not executed, but the prose itself could carry attacker text. Treat report text as untrusted.
- **JSONL log is not pruned**. Reports accumulate in `reports.jsonl` forever. On a constrained device, monitor disk usage.
- **No outbound TLS pinning**. The plugin trusts the system CA store for `openrouter.ai` and `localhost:9000` (QuestDB). If your CA store is compromised, the plugin can be MITM'd.

## License

This security policy is covered by the project's [Apache-2.0 License](LICENSE). Copyright 2026 Nearl Crews.
