# MOYAI Chrome MCP Bugfix Plan

## Background

MOYAI daily operations must automate real Chrome workflows, especially ThinkingData dashboard downloads for daily report ZIP files. The current Chrome MCP bridge can expose tools to Codex, but the production flow is unstable: tool calls fail before reaching the page, and manual browser interaction still works. This points to bridge/session reliability rather than a ThinkingData or Tampermonkey script problem.

This plan focuses on making `mcp-chrome-bridge` reliable enough for host AI driven browser automation.

## Current Status 2026-05-28

- MOYAI fork has implemented P1 through P3:
  - per-session MCP server instances for `/mcp` and `/sse`
  - `/health/mcp` active session visibility
  - bridge startup reuse when an existing healthy bridge owns the port
  - MCP-compatible JSON-RPC error bodies for missing or invalid sessions
  - server regression tests for repeated initialize, cleanup, and invalid-session paths
- Upstream `hangwin/mcp-chrome` already has open PR #346, `fix(native-server): use per-session MCP Server factory (closes #345)`, which covers the same core singleton MCP server problem as MOYAI P1.
- If contributing back upstream, avoid duplicating PR #346. A cleaner follow-up is to upstream the remaining bridge health, duplicate-start reuse, `doctor` MCP health check, and JSON-RPC error improvements after #346 lands or on top of that branch.
- Keep `docs/MOYAI_CHROME_MCP_BUGFIX_PLAN.md` fork-local; it contains MOYAI-specific production validation context and should not be included in an upstream PR.

## Observed Failures

- `GET /ping` on the local bridge succeeds, so the HTTP server can start.
- Chrome extension communication can respond through `/ask-extension`, so native host to extension wiring is at least partially alive.
- Codex MCP tool calls such as `get_windows_and_tabs` and `chrome_navigate` fail with a JSON-RPC deserialize error before useful tool output is returned.
- Direct `/mcp` GET without a valid session returns an invalid/missing session error.
- Direct `/mcp` initialize may succeed once, then later fail with `Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection.`
- Local preflight showed duplicate `mcp-chrome-bridge` Node processes and possible port owner confusion around port `12306`.

## Code Hotspots

- `app/native-server/src/mcp/mcp-server.ts`
  - `getMcpServer()` returns a singleton MCP `Server`.
  - A singleton MCP server cannot safely be connected to multiple transports at the same time.
- `app/native-server/src/server/index.ts`
  - `/mcp` POST creates a new `StreamableHTTPServerTransport` on initialize, then calls `await getMcpServer().connect(transport)`.
  - `/sse` does the same singleton connection through `getMcpServer().connect(transport)`.
  - `transportsMap` tracks sessions, but server-to-transport lifecycle is not isolated per session.
- `app/native-server/src/server/server.test.ts`
  - Current server tests only cover `/ping`, so the broken MCP session lifecycle is not protected by regression tests.

## Root Cause Hypotheses

1. **Singleton MCP server transport conflict**
   The singleton returned by `getMcpServer()` is reused across streamable HTTP and SSE transports. Re-initializing after a stale session, duplicate client, or reconnect can call `connect()` on an already connected protocol instance.

2. **Stale session cleanup is incomplete**
   `transport.onclose` removes the session from `transportsMap`, but the associated MCP server/protocol lifecycle is not fully closed or isolated.

3. **Duplicate bridge processes race for ownership**
   Multiple `mcp-chrome-bridge` processes may exist. Even if only one owns the port, Codex and Chrome extension state can drift when old native host processes survive.

4. **MCP errors are not always client-compatible**
   Some route failures return plain Fastify JSON/string errors. Codex may expect MCP-compatible JSON-RPC or streamable HTTP shapes and report a deserialize error instead of a useful bridge error.

5. **Health checks are too shallow**
   `/ping` only proves the Fastify server is alive. It does not prove MCP initialize, `tools/list`, or extension roundtrip works.

## Fix Plan

### P0: Reproducible Diagnostics

Add diagnostics before changing behavior.

- Add a local `doctor` or `/health/mcp` check covering:
  - bridge process PID and port owner
  - active MCP session count
  - whether a Chrome extension roundtrip succeeds
  - whether MCP initialize plus `tools/list` succeeds
- Add structured logs for:
  - session creation
  - session close
  - rejected invalid session
  - duplicate initialize attempts
- Add tests around `/mcp` failure responses so regressions are visible.

Acceptance:

- A single command can distinguish `server alive`, `extension alive`, and `MCP session alive`.
- When Codex reports a tool failure, the bridge log has a matching session id and reason.

### P1: Fix MCP Transport Lifecycle

Replace the singleton server lifecycle for HTTP/SSE sessions.

Preferred implementation:

- Introduce `createMcpServer()` that creates a fresh MCP `Server` and registers tools for each new transport.
- Store `{ transport, server }` per session instead of only storing `transport`.
- On `transport.onclose` and DELETE, remove the session and close the session-owned server/transport when supported by the SDK.
- Keep a compatibility wrapper only where a singleton is truly required.

Alternative if per-session server has unacceptable cost:

- Before connecting a new transport, explicitly close the previous singleton transport/server and remove all stale sessions.
- This is simpler but riskier for concurrent clients, so it should be a fallback.

Acceptance:

- Repeated initialize -> DELETE -> initialize works.
- Two sequential Codex sessions do not produce `Already connected to a transport`.
- A stale session id is rejected with a useful MCP-compatible error.
- Existing `/sse` behavior remains either supported or explicitly documented as legacy.

### P2: Prevent Duplicate Bridge Confusion

Add a bridge single-instance guard.

- On startup, check whether the target port is already owned by a healthy bridge.
- If another healthy bridge exists, exit with a clear message instead of starting a second unmanaged process.
- If the port owner is unhealthy or stale, show an actionable recovery message.
- Consider a lockfile containing PID, port, startup timestamp, package version, and health status.

Acceptance:

- Starting the bridge twice does not create two competing long-lived processes.
- The CLI tells the user which PID owns the port and how to stop or reuse it.

### P3: Normalize MCP Error Responses

Make failure output easier for MCP clients to parse.

- Audit `/mcp` POST/GET/DELETE and `/messages` error paths.
- Prefer SDK-compliant JSON-RPC error responses or streamable HTTP responses where required.
- Avoid plain string errors on MCP endpoints.
- Include session id, route, and reason in server logs, not necessarily in client-visible output.

Acceptance:

- Invalid session, server already connected, and extension timeout errors produce readable client-side errors.
- Codex no longer reports a generic deserialize failure for known bridge-side errors.

### P4: MOYAI Production Validation

Validate against the real workflow that motivated this fork.

Steps:

1. Install or link the patched bridge locally.
2. Start a clean Chrome MCP bridge with no stale process.
3. Confirm Codex can call:
   - `get_windows_and_tabs`
   - `chrome_navigate`
   - `chrome_get_web_content`
   - a low-risk script execution against the current tab
4. Run MOYAI's ThinkingData daily ZIP download flow through Chrome MCP.
5. Confirm the Tampermonkey downloader can execute after dashboard page switches and forced refreshes.

Acceptance:

- No Codex MCP deserialize error.
- No `Already connected to a transport` after reconnect or restart.
- MOYAI can reach the TA dashboard page and trigger the existing downloader script without manual browser clicks except expected human approvals.

## Out Of Scope

- Rewriting MOYAI's Tampermonkey scripts.
- Automating final high-risk production confirmation clicks.
- Changing ThinkingData page logic.
- Replacing Chrome MCP with Lightpanda or Playwright.

## Suggested Implementation Order

1. Add tests that reproduce duplicate initialize and stale session behavior.
2. Refactor MCP server creation to support per-session server instances.
3. Add session cleanup and MCP-compatible error handling.
4. Add bridge `doctor` or deeper health endpoint.
5. Add single-instance guard.
6. Run MOYAI validation and document the clean-start procedure.

## Regression Test Ideas

- `POST /mcp initialize` twice sequentially after DELETE should succeed both times.
- `POST /mcp initialize` twice without DELETE should either support two sessions or reject the second with a deterministic MCP-compatible error.
- `GET /mcp` without `mcp-session-id` should return a deterministic client-compatible error.
- Closing a transport should remove its session entry.
- `/health/mcp` should report no active sessions after cleanup.
- Starting bridge while a healthy bridge owns the port should fail cleanly with the owner PID.
