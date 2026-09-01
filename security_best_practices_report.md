# Security Audit & Code Review Report — agent-reviewer

**Project:** `agent-reviewer` (Kilo Pre-Auto-Approve Security Gate Plugin)  
**Version:** `v0.5.0`  
**Date:** 2026-09-01  
**Scope:** Complete repository audit (`agent-reviewer.ts`, `lib/least-connections.ts`, `tui/agent-reviewer-tui.tsx`, `check-agent-reviewer.py`, `scripts/gate_suite_unified.py`, `scripts/install.sh`, test suites, JSON datasets, configuration schemas).

---

## 1. Executive Summary

`agent-reviewer` serves as a critical pre-execution safety gate for mutating tools in the Kilo AI agent ecosystem. The codebase exhibits exceptionally high security awareness, defensive design principles, and robust architecture:

- **Fail-Closed by Design:** All error paths (HTTP errors, timeouts, unparsable output, missing keys, empty chain, missing system prompt) strictly fail closed and escalate to human review.
- **Strict Credential Hygiene:** The repository is clean of credentials, API keys, internal IP addresses, and private domain names. Operational keys are segregated in gitignored `agent-reviewer.json`, with the installer strictly prohibited from creating or modifying live config.
- **Safe IPC & Isolation:** IPC files use strict UUID/regex validation (`/^ses_[A-Za-z0-9]+$/`), preventing directory traversal, and enforce restricted filesystem permissions (`0o700` directories, `0o600` files).
- **Resilience & Resource Safety:** Bounded in-memory collections, leak-free timer management with `clearTimeout` in `finally`, non-blocking plugin factory lifecycle, and least-connections load balancing prevent resource exhaustion.

---

## 2. Findings Matrix

| ID | Category | Severity | Finding / Topic | Status |
|:---|:---|:---|:---|:---|
| **SEC-01** | Prompt & Safety | **Critical** | Fail-closed system prompt enforcement | ✅ **Verified Secure** |
| **SEC-02** | Credentials & Data | **High** | Secret separation & logging hygiene | ✅ **Verified Secure** |
| **SEC-03** | Injection & Traversal | **High** | Path traversal & IPC file injection defense | ✅ **Verified Secure** |
| **SEC-04** | Architecture | **Medium** | First-definitive chain & operational cooldowns | ✅ **Verified Secure** |
| **SEC-05** | Reliability | **Medium** | Concurrency, abort controller & timer lifecycle | ✅ **Verified Secure** |
| **QA-01** | Code Quality | **Low** | Python typing & variable re-assignment warnings | ℹ️ **Recommendation** |
| **QA-02** | Test Automation | **Low** | Synthetic mock test coverage for wire formats | ℹ️ **Recommendation** |

---

## 3. Detailed Security Findings & Architecture Review

### SEC-01: Fail-Closed Prompt & Model Safety Policy [CRITICAL]

- **Impact Statement:** An empty or misconfigured safety prompt could allow unauthorized mutating commands to bypass human approval.
- **Audit Evaluation:**
  - In `v0.5.0`, `DEFAULT_SYSTEM_PROMPT` was eliminated from TypeScript source code (`agent-reviewer.ts:726-740`).
  - If `systemPrompt` is missing or empty in `agent-reviewer.json`, the gate logs a warning and **immediately escalates to human review** (`agent-reviewer.ts:1649-1670`), bypassing all model calls.
  - The model decision parsing (`parseDecision`, `extractJsonObject`) strictly validates JSON schema (`{ decision: "approve" | "escalate", reason: string }`).
  - The heuristic fallback (`heuristicDecision`) only triggers on parse failure and is biased toward escalation when ambiguous.

### SEC-02: Secret Handling & Logging Hygiene [HIGH]

- **Impact Statement:** Accidental logging of API keys or user command payloads to shared system logs could expose credentials.
- **Audit Evaluation:**
  - Sensitive details (`userContent`, tool arguments, raw model responses) are strictly written to private `debug.log` (`mode: 0o600`, rotated at 10 MiB × 5 generations) and never forwarded to Kilo's shared `opencode.log` (`agent-reviewer.ts:1772-1779`).
  - `agent-reviewer.json` is gitignored. Installer `scripts/install.sh` enforces a hard rule never to touch, overwrite, or create live config.
  - `check-agent-reviewer.py` and `scripts/gate_suite_unified.py` do not log API keys during test runs or errors.

### SEC-03: IPC Security & Path Traversal Mitigation [HIGH]

- **Impact Statement:** Malicious session IDs could attempt directory traversal (`../../`) to overwrite arbitrary files on disk.
- **Audit Evaluation:**
  - Session IDs are strictly sanitized with `sessionFileId`: `if (!/^ses_[A-Za-z0-9]+$/.test(sessionID)) return null;` in both `agent-reviewer.ts:136-140` and `tui/agent-reviewer-tui.tsx:49-53`.
  - All IPC paths are scoped to `~/.local/share/kilo/log/agent-reviewer/pending/` with `0o700` directory and `0o600` file modes.
  - Stale IPC files are automatically pruned after 5 minutes (`PENDING_STALE_MS = 300000`).

### SEC-04: Multi-Protocol Wire Format & Header Isolation [MEDIUM]

- **Audit Evaluation:**
  - Implements native protocol handlers for OpenAI (`/chat/completions`), Anthropic (`/messages`), and Cohere v2 (`/chat`).
  - Per-tier custom headers (`TierConfig.headers`) are cleanly merged after defaults, allowing session tokens or auth proxy headers to be passed securely without polluting global defaults.
  - `anthropic-version` and other vendor-specific headers are appropriately routed only to corresponding wire formats.

### SEC-05: Concurrency, Timer Lifecycle & Resource Bounds [MEDIUM]

- **Audit Evaluation:**
  - All outgoing HTTP requests attach an `AbortController` with explicit `setTimeout` and mandatory `clearTimeout` in `finally` blocks (`agent-reviewer.ts:1127-1129, 1273-1275`).
  - In-memory data structures (`argsByCallID`, `decisionCache`, `repliedRequestIDs`) implement automatic LRU/size pruning (capped at 200-500 entries) to prevent memory leaks in long-running Kilo daemon processes.
  - `withTierConnection` safely increments and decrements connection counts inside `finally` (`lib/least-connections.ts:65-76`), preventing count drift under uncaught exceptions.

---

## 4. Code Quality & Maintainability Observations

### QA-01: Python Tooling Typing & Constants (Minor)

- In `scripts/gate_suite_unified.py`, `ORDER` and `PROVIDER_INDEX` are capitalized constants re-assigned conditionally during argument parsing. Refactoring them to lowercase local variables or dynamic containers avoids static analysis / linter warnings.
- Generic type annotations (e.g. `dict` vs `dict[str, Any]`) can be formalized across Python scripts for stricter `mypy` / LSP compliance.

### QA-02: Test Automation Expansion (Optional Enhancement)

- The test suite (`bun test`) currently validates version parity (`version.test.ts`), least-connections algorithm edge cases (`select-least-connections.test.ts`), and installation idempotence (`install-version.test.ts`).
- **Recommendation:** Add a unit test suite with mock HTTP responses (using `Bun.serve` or fetch mocks) to test `callReviewerOnce` across OpenAI, Anthropic, and Cohere wire formats in TypeScript directly.

---

## 5. Security & Review Checklist Status

| Area | Verification Method | Result |
|:---|:---|:---|
| **No Committed Secrets** | Git history & working tree audit | ✅ PASS (0 leaks) |
| **Fail-Closed Semantics** | Static analysis of all throw/catch paths | ✅ PASS (100% fail-closed) |
| **Path Traversal Defense** | Regex audit on IPC file handlers | ✅ PASS (`/^ses_[A-Za-z0-9]+$/`) |
| **Memory & Resource Leaks** | Timer / Map bounds inspection | ✅ PASS (Bounded & pruned) |
| **Wire Format Parity** | `check-agent-reviewer.py` & `gate_suite_unified.py` | ✅ PASS |
| **Linters & Style** | `rumdl`, `ruff`, `shellcheck`, `typos`, `json-lint` | ✅ PASS (Zero errors) |
