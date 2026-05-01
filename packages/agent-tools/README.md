# @opendj/agent-tools

> **Status: P2 placeholder. Dev-only.**

Local MCP server and repo-map tools for AI coding agents working on OpenDJ. Never shipped to production.

Planned tools (see [`docs/agent-brief.md`](../../docs/agent-brief.md) §"AI / MCP support"):

- `get_architecture_summary`
- `list_routes`
- `list_db_tables`
- `get_provider_contract`
- `get_session_event_contract`
- `get_frontend_routes`
- `run_typecheck`
- `run_tests`

Hard rules:

- Dev-only by default
- No production secrets
- No arbitrary shell tool — allowlisted commands only
- No direct write access to production databases
- `AGENTS.md`, OpenAPI, route schemas, and event schemas must stay in sync

This package is marked `private: true` and listed in `.changeset/config.json#ignore` — it will never be published to npm.
