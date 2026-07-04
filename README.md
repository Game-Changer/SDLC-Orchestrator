# SDLC Orchestrator

MCP server powering the multi-agent Salesforce SDLC POC. One vendor-agnostic backend that Claude Code **and** GitHub Copilot connect to — in VS Code and on github.com — so no sub-agent logic is ever duplicated per vendor.

**Related repos:** [Salesforce-Dev](https://github.com/Game-Changer/Salesforce-Dev) (metadata + CI/CD) · [Salesforce-QA-Automation](https://github.com/Game-Changer/Salesforce-QA-Automation) (BDD framework + dashboard)

---

## What it does

The LLM client (Claude / Copilot) is the "Main Agent" the user talks to. This server supplies it with:

1. **Intent routing** — which sub-agent a business input maps to, in pipeline order
2. **Context assembly** — safe read access to the two local repo clones
3. **Coding standards** — serves the QA repo's `AgentInstructions.md` to any code-writing agent
4. **Confirmation gates** — write-style tools refuse to act without an explicit, human-approved `confirm=true`

## Tools

| Tool | Purpose | Status |
|---|---|---|
| `route_intent` | Classify business input → sub-agent pipeline | ✅ Phase 1 |
| `list_repo_structure` | Directory tree of dev/qa clone (secrets excluded) | ✅ Phase 1 |
| `read_repo_file` | Read one repo file (`.env`, `.auth`, `.git` blocked) | ✅ Phase 1 |
| `get_agent_standards` | Mandatory coding standards for generated code | ✅ Phase 1 |
| `generate_user_story` | Draft story template (local, never touches Jira) | ✅ Phase 1 |
| `create_jira_story` | Gated write — preview until `confirm=true` | 🔒 Gate live, Jira in Phase 2 |
| `review_dev_code` | Dev Code Reviewer: Salesforce security + best-practice review protocol | ✅ Available |
| `review_qa_code` | QA Code Reviewer: standards-compliance + security review protocol | ✅ Available |
| `run_qa_tests` | Execute the QA suite by tag (test-runner.js, headless) | ✅ Available |
| `run_dev_tests` | Run Apex tests via `sf` against the authorized org | ✅ Available |
| `write_test_cases` | Manual test cases from a story | ⏳ Phase 3 |
| `generate_qa_automation` | Cucumber/Playwright specs | ⏳ Phase 4 |
| `generate_dev_code` | Apex/LWC/Flow changes (local only) | ⏳ Phase 5 |

### Sub-agents (7)

Five pipeline agents — User Story Generator, Agile Board Connector, Test Case Writer, QA Automation Writer, Dev Code Generator (Phases 2–5) — plus two **review agents available today**:

- **dev-code-reviewer** — reviews Salesforce code: SOQL injection, CRUD/FLS, sharing, bulkification, governor limits, test quality; verifies by running Apex tests
- **qa-code-reviewer** — reviews automation code against AgentInstructions.md: OOP structure, typed exception handling, credential hygiene; verifies by running the tagged suite

## Setup

```bash
git clone https://github.com/Game-Changer/SDLC-Orchestrator.git orchestrator
cd orchestrator
npm install
npm run build     # compiles src/ → dist/
```

Expected workspace layout (the context tools resolve `../repos/...` relative to this folder):

```
<workspace>/
├── orchestrator/                      # this repo
└── repos/
    ├── Salesforce-Dev/                # local clone
    └── Salesforce-QA-Automation/      # local clone
```

### Smoke test

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/index.js
```

You should see a `tools/list` response naming all nine tools.

## Connecting a client

**Claude Code (VS Code / CLI)** — `.mcp.json` at the workspace root:

```json
{
  "mcpServers": {
    "sdlc-orchestrator": {
      "command": "node",
      "args": ["orchestrator/dist/index.js"]
    }
  }
}
```

**GitHub Copilot Chat (VS Code, Agent mode)** — `.vscode/mcp.json`:

```json
{
  "servers": {
    "sdlc-orchestrator": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/orchestrator/dist/index.js"]
    }
  }
}
```

> Requires VS Code 1.99+ and the org policy allowing MCP servers in Copilot.

**Copilot coding agent (github.com)** — repo *Settings → Copilot → Coding agent → MCP configuration*; the setup steps must clone + build this repo (and the sibling repo for cross-repo context).

**Claude Code GitHub Action (github.com)** — `@claude` mentions run Claude Code in Actions, which loads the repo's `.mcp.json`; the workflow must clone + build this repo first.

## Security model

- **Read-only context** — no tool writes to either repo; agents write only local files, humans push
- **Test execution is sandboxed to known commands** — `run_qa_tests` / `run_dev_tests` execute only the fixed repo test entry points with regex-validated arguments (no arbitrary commands), with timeouts and bounded output
- **Path traversal guard** — file access is resolved and verified to stay inside the repo root
- **Blocklist** — `.env`, `.auth/`, `.git/`, `node_modules/`, `dist/`, `reports/` are never readable
- **Gated writes** — `create_jira_story` returns a preview until called with `confirm=true`, which agents may only set after explicit human approval of that exact story
- **stdio only** — no network listener; the server runs as a child process of the client

## Roadmap

| Phase | Deliverable | Status |
|---|---|---|
| 1 | MCP layer + orchestrator skeleton (this) | ✅ |
| 2 | User Story Generator + gated Jira integration | ⏳ |
| 3 | Test Case Writer | ⏳ |
| 4 | QA Automation Writer | ⏳ |
| 5 | Dev Code Generator | ⏳ |
| 6 | End-to-end pilot | ⏳ |
