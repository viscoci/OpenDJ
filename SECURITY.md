# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Use GitHub's Private Vulnerability Reporting:

👉 https://github.com/viscoci/opendj/security/advisories/new

What to include:

- Affected package(s) and version (or commit SHA if pre-release)
- Reproduction steps or proof-of-concept
- Impact assessment (data exposure, privilege escalation, etc.)
- Any suggested mitigation

## Response targets

- **First response:** within 7 days of report
- **Triage + severity assignment:** within 14 days
- **Fix or disclosure plan:** communicated within 30 days

These are targets, not guarantees — this project is maintained by volunteers.

## Supported versions

Until the first tagged release, only the current `main` branch is supported. After releases begin, the latest minor of each major will be supported for security fixes; older majors are best-effort.

## Coordinated disclosure

We will credit reporters in the release notes unless you prefer to remain anonymous. Please give us a reasonable window (typically 30–90 days depending on severity) before public disclosure.

## Out of scope

Vulnerabilities specific to a particular hosted deployment built on top of OpenDJ should be reported to that deployment's operator, not here. This policy covers the OSS packages and the reference `apps/oss-demo` self-host.
