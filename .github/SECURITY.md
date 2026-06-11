# Security Policy

The plugin runs inside a Signal K server on a vessel and makes outbound
HTTPS calls to OpenRouter, so the most important security boundary is
your OpenRouter API key.

## Supported Versions

We actively support the following versions with security updates:

| Version | Supported |
| ------- | --------- |
| 0.5.x   | Yes       |
| < 0.5   | No        |

## Reporting a Vulnerability

We take the security of OpenRouter Companion seriously. If you discover a
security vulnerability, please follow these guidelines.

### How to Report

**Please do NOT report security vulnerabilities through public GitHub issues.**

Instead, please report them via one of these methods:

1. **GitHub Security Advisory**: use the [GitHub Security Advisory](https://github.com/NearlCrews/signalk-openrouter-companion/security/advisories/new) feature (preferred).
2. **Direct contact**: reach the maintainer via [GitHub](https://github.com/NearlCrews) with "SECURITY" in the subject line.

### What to Include

Please include the following information in your report:

- **Description** of the vulnerability (the class, such as credential
  leak, injection, or denial of service)
- **Steps to reproduce** the issue, with affected file paths and the
  smallest reproducer you can provide
- **Potential impact** of the vulnerability
- **Suggested fix** (if you have one)
- **Your contact information** for follow-up

### Response Timeline

- **Initial Response**: within 48 hours of the report on a best-effort
  basis (this is a one-maintainer project, not a 24/7 security team)
- **Status Update**: within 7 days, severity and scope are confirmed
- **Fix Timeline**: critical within 1 week, high within 2 weeks, medium
  within 1 month, low best-effort

### Scope

In scope: the plugin's own code under `src/`, the published npm tarball
contents, and the dependencies declared in `package.json` (one direct
runtime dependency today: `croner`).

Out of scope:

- The Signal K server itself: report to [SignalK/signalk-server](https://github.com/SignalK/signalk-server).
- OpenRouter's API or any individual model behavior: report to OpenRouter.
- QuestDB: report to [questdb/questdb](https://github.com/questdb/questdb).
- The user's local NMEA 2000 bus.

## Security Best Practices

When using this plugin:

1. **Use a dedicated API key**: give this plugin its own OpenRouter API
   key so you can revoke it without impacting other tools.
2. **Cap the spend**: set "Max calls per day" to a hard cap so a stuck
   loop cannot burn through credit.
3. **Access Control**: keep the Signal K server's admin UI behind
   authentication. The plugin's REST routes are admin-gated, and its PUT
   triggers go through `app.registerPutHandler`, so anyone who can write
   `vessels.self` paths on your server can fire analyzer runs.
4. **Treat report text as untrusted**: LLM prompts are not sandboxed. If
   an attacker can write arbitrary deltas to the watched paths
   (`propulsion.*`, `electrical.batteries.*`), they can influence the
   model's input, and the published prose could carry attacker text. The
   output is only published as Signal K notifications, never executed.
5. **Monitor disk usage**: the JSONL report log is not pruned, so reports
   accumulate in `reports.jsonl` indefinitely on a constrained device.
6. **Keep Updated**: always use the latest version, and keep your Node.js
   runtime up to date. There is no outbound TLS pinning; the plugin
   trusts the system CA store for openrouter.ai and the QuestDB URL.

## Dependency Security

This project uses:

- `npm audit` for vulnerability scanning (run in CI on every push)
- Automated dependency updates via Dependabot for security patches

Run a security audit:

```bash
npm audit
```

## Data Handling

- **OpenRouter API key**: stored only in Signal K's plugin config
  (`~/.signalk/plugin-config-data/signalk-openrouter-companion.json`) and
  never logged. The schema marks the field as a password input. If you
  see the key echoed in logs, that is a bug, please report it.
- **Vessel telemetry sent to OpenRouter**: each analyzer's prompt
  includes the relevant subset of telemetry (engine RPM, fuel rate,
  battery voltage and state of charge, weather readings). No GPS
  coordinates and no identifying metadata are included. If you do not
  want telemetry leaving the boat, do not enable the analyzers.
- **Generated reports**: written locally to `reports.jsonl` in the
  plugin's data directory and published as Signal K notifications. They
  contain the same telemetry that was sent to OpenRouter plus the model's
  prose response.

## Signal K Security

This plugin operates within the Signal K server environment. Please also
refer to the [Signal K documentation](https://signalk.org/documentation/)
and Signal K server security best practices.

## Marine Safety Notice

This plugin reports on engine, battery, and weather telemetry aboard a
vessel. While we strive for security and reliability:

- **Not for Safety-Critical Use**: the battery threshold alerts are
  written by a cloud LLM call bounded by a shared daily budget, so a
  crossing can go unreported when the budget is spent or OpenRouter is
  unreachable. Pair the alerts with a hardware or BMS alarm.
- **Professional Equipment**: always maintain certified monitoring and
  alarm equipment for engine and electrical systems.
- **Regular Verification**: the reports are generated prose; verify any
  surprising claim against your instruments before acting on it.
- **Test Thoroughly**: test in non-critical conditions before relying on
  this plugin.

## Disclosure Policy

- We will coordinate disclosure timing with the reporter.
- Public disclosure will occur after a patched release is available and
  users have had at least 7 days to update.
- Credit will be given to reporters (if desired).
- A security advisory will be published on GitHub.
