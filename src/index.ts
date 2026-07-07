#!/usr/bin/env node
/**
 * SDLC Orchestrator — MCP server (Phase 1 skeleton)
 *
 * Vendor-agnostic backend for the multi-agent Salesforce SDLC POC. Both
 * Claude Code (.mcp.json) and GitHub Copilot Chat (.vscode/mcp.json) connect
 * to this same server over stdio, so no sub-agent logic is duplicated per
 * vendor.
 *
 * The server provides three things:
 *  1. Intent routing      — which sub-agent a business input maps to
 *  2. Context assembly    — safe read access to the two local repo clones
 *  3. Confirmation gates  — write-style tools refuse to act without an
 *                           explicit confirm flag (demonstrated on the
 *                           Jira story stub; real Jira lands in Phase 8,
 *                           deliberately the final phase)
 *
 * The LLM client (Claude / Copilot) does the actual generation; this server
 * supplies routing, context, standards, and gates.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This package lives at repos/SDLC-Orchestrator, so sibling clones are one level up
const REPOS_DIR = path.resolve(__dirname, '../..');

/**
 * Repo resolution, three tiers:
 *  1. Env override (SDLC_DEV_REPO / SDLC_QA_REPO) — set by the client config,
 *     e.g. "${workspaceFolder}" in .vscode/mcp.json
 *  2. Working-directory sniff — clients launch stdio servers with cwd set to
 *     the open project, so a marker file identifies which repo the user is in
 *  3. Standard umbrella-workspace layout (this repo cloned at repos/SDLC-Orchestrator beside the Salesforce clones)
 */
function detectRepoFromCwd(markerFile: string): string | undefined {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, markerFile)) ? cwd : undefined;
}

const REPOS = {
  dev: process.env.SDLC_DEV_REPO
    ?? detectRepoFromCwd('sfdx-project.json')
    ?? path.join(REPOS_DIR, 'Salesforce-Dev'),
  qa: process.env.SDLC_QA_REPO
    ?? detectRepoFromCwd('cucumber.js')
    ?? path.join(REPOS_DIR, 'Salesforce-QA-Automation'),
} as const;

// Never expose these through context tools — secrets and machine-local state
const BLOCKED_PATHS = ['.env', '.auth', 'node_modules', 'dist', '.git', 'reports'];

type RepoKey = keyof typeof REPOS;

function isBlocked(relativePath: string): boolean {
  const segments = relativePath.split(path.sep);
  return BLOCKED_PATHS.some(blocked => segments.includes(blocked));
}

function resolveRepoPath(repo: RepoKey, relativePath: string): string {
  const base = REPOS[repo];
  const resolved = path.resolve(base, relativePath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(`Path escapes the ${repo} repository: ${relativePath}`);
  }
  if (isBlocked(path.relative(base, resolved))) {
    throw new Error(`Access to this path is blocked by policy: ${relativePath}`);
  }
  return resolved;
}

function buildTree(dir: string, base: string, depth: number, maxDepth: number): string[] {
  if (depth > maxDepth) return [];
  const lines: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.relative(base, path.join(dir, entry.name));
    if (isBlocked(relative)) continue;
    const indent = '  '.repeat(depth);
    if (entry.isDirectory()) {
      lines.push(`${indent}${entry.name}/`);
      lines.push(...buildTree(path.join(dir, entry.name), base, depth + 1, maxDepth));
    } else {
      lines.push(`${indent}${entry.name}`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Intent routing (rule-based for the skeleton; the orchestrator LLM can refine)
// ---------------------------------------------------------------------------
interface Route {
  agent: string;
  phase: number;
  status: 'available' | 'planned';
  keywords: RegExp;
}

const ROUTES: Route[] = [
  { agent: 'user-story-generator', phase: 1, status: 'available', keywords: /\b(user stor(y|ies)|requirement|epic|acceptance criteria|as a user)\b/i },
  { agent: 'test-case-writer', phase: 2, status: 'available', keywords: /\b(test case|manual test|test plan|test scenario)\b/i },
  { agent: 'qa-automation-writer', phase: 3, status: 'planned', keywords: /\b(automat(e|ion)|playwright|cucumber|bdd|feature file|selenium|regression suite)\b/i },
  { agent: 'dev-code-generator', phase: 4, status: 'planned', keywords: /\b(apex|lwc|lightning web component|trigger|flow|validation rule|salesforce code|metadata)\b/i },
  { agent: 'agile-board-connector', phase: 8, status: 'planned', keywords: /\b(jira|board|sprint|backlog|ticket|issue)\b/i },
  { agent: 'dev-code-reviewer', phase: 1, status: 'available', keywords: /\b(review|audit|security (issue|scan|review)|static analysis|code quality)\b.*\b(apex|lwc|trigger|flow|dev|salesforce)\b|\b(apex|lwc|trigger|flow)\b.*\b(review|audit|scan)\b/i },
  { agent: 'qa-code-reviewer', phase: 1, status: 'available', keywords: /\b(review|audit|security (issue|scan|review)|static analysis|code quality|standards? compliance)\b.*\b(qa|automation|test|framework|playwright|cucumber)\b|\b(automation|framework)\b.*\b(review|audit)\b/i },
];

const server = new McpServer({
  name: 'sdlc-orchestrator',
  version: '0.1.0',
});

server.registerTool(
  'route_intent',
  {
    title: 'Route business input to sub-agents',
    description:
      'Classify a business input and return which sub-agent(s) should handle it, in pipeline order. ' +
      'Use this first for any new business request.',
    inputSchema: {
      business_input: z.string().describe('The raw business requirement or request'),
    },
  },
  async ({ business_input }) => {
    const matches = ROUTES.filter(route => route.keywords.test(business_input));
    const routing = matches.length > 0 ? matches : ROUTES.slice(0, 1); // default: start with a user story
    const pipeline = [...routing].sort((a, b) => a.phase - b.phase);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              matched_agents: pipeline.map(r => ({ agent: r.agent, phase: r.phase, status: r.status })),
              recommended_pipeline:
                'user-story-generator → dev-code-generator → test-case-writer → qa-automation-writer (each step feeds the next; Jira writes and repo pushes always need human approval)',
              note: matches.length === 0 ? 'No keyword match — defaulted to user-story-generator as the pipeline entry point.' : undefined,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.registerTool(
  'list_repo_structure',
  {
    title: 'List repository structure',
    description: 'Directory tree of a local repo clone (dev = Salesforce-Dev, qa = Salesforce-QA-Automation). Secrets and build output are excluded.',
    inputSchema: {
      repo: z.enum(['dev', 'qa']).describe('Which repository to inspect'),
      max_depth: z.number().int().min(1).max(6).default(3).describe('How deep to walk the tree'),
    },
  },
  async ({ repo, max_depth }) => {
    try {
      const base = REPOS[repo];
      if (!fs.existsSync(base)) {
        throw new Error(`Repository clone not found at: ${base}`);
      }
      const tree = buildTree(base, base, 0, max_depth - 1);
      return { content: [{ type: 'text' as const, text: `${path.basename(base)}/\n` + tree.map(l => '  ' + l).join('\n') }] };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
    }
  }
);

server.registerTool(
  'read_repo_file',
  {
    title: 'Read a repository file',
    description: 'Read one file from a local repo clone for context. .env, .auth, build output and git internals are blocked.',
    inputSchema: {
      repo: z.enum(['dev', 'qa']).describe('Which repository'),
      file_path: z.string().describe('Path relative to the repository root'),
    },
  },
  async ({ repo, file_path }) => {
    try {
      const resolved = resolveRepoPath(repo, file_path);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(`File not found: ${file_path}`);
      }
      return { content: [{ type: 'text' as const, text: fs.readFileSync(resolved, 'utf-8') }] };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
    }
  }
);

server.registerTool(
  'get_agent_standards',
  {
    title: 'Get coding standards for generated code',
    description:
      'Returns the mandatory coding standards (AgentInstructions.md) that ALL generated QA automation code must follow: OOP structure, custom exception handling, logging, security, tagging.',
    inputSchema: {},
  },
  async () => {
    const standardsPath = path.join(REPOS.qa, 'AgentInstructions.md');
    const rawUrl = 'https://raw.githubusercontent.com/Game-Changer/Salesforce-QA-Automation/main/AgentInstructions.md';
    try {
      // Tier 1: local QA clone
      if (fs.existsSync(standardsPath)) {
        return { content: [{ type: 'text' as const, text: fs.readFileSync(standardsPath, 'utf-8') }] };
      }
      // Tier 2: fetch from GitHub (GITHUB_TOKEN needed if the repo is private)
      const headers: Record<string, string> = {};
      if (process.env.GITHUB_TOKEN) {
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      }
      const response = await fetch(rawUrl, { headers });
      if (!response.ok) {
        throw new Error(`GitHub fetch returned HTTP ${response.status}`);
      }
      return { content: [{ type: 'text' as const, text: await response.text() }] };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Error: standards not available locally (no QA clone at ${REPOS.qa}) and GitHub fetch failed (${message}). ` +
              `Fallback: read AgentInstructions.md from Game-Changer/Salesforce-QA-Automation using the GitHub MCP server.`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.registerTool(
  'generate_user_story',
  {
    title: 'Draft a user story (local draft only)',
    description:
      'Turn business input into a DRAFT user story structure. This never touches Jira — use create_jira_story (with explicit confirmation) to publish a draft.',
    inputSchema: {
      business_input: z.string().describe('The business requirement to convert'),
      persona: z.string().default('Salesforce user').describe('Who benefits from this story'),
    },
  },
  async ({ business_input, persona }) => {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              status: 'DRAFT — not in Jira',
              template: {
                title: `<one-line summary of: ${business_input.substring(0, 80)}>`,
                story: `As a ${persona}, I want <capability>, so that <business value>.`,
                acceptance_criteria: [
                  'GIVEN <precondition> WHEN <action> THEN <observable outcome>',
                  '<add one criterion per behavior, each independently testable>',
                ],
                definition_of_done: ['Code reviewed', 'Test cases written', 'QA automation added', 'Deployed to sandbox'],
              },
              next_step: 'Fill in the template with the LLM and review with the human. Stories remain local drafts until Phase 8 wires Jira; create_jira_story demonstrates the gated-write flow that will publish them.',
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.registerTool(
  'create_jira_story',
  {
    title: 'Create a Jira story (gated write)',
    description:
      'GATED WRITE: creates a story on the Jira board. Requires confirm=true, which the human must explicitly approve in-session. Without it, returns a preview only.',
    inputSchema: {
      title: z.string().describe('Story title'),
      description: z.string().describe('Full story body including acceptance criteria'),
      confirm: z.boolean().default(false).describe('Must be true, and ONLY after the human has explicitly approved this exact story'),
    },
  },
  async ({ title, description, confirm }) => {
    if (!confirm) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `CONFIRMATION REQUIRED — nothing was created.\n\n` +
              `Preview of the story that WOULD be created:\n` +
              `  Title: ${title}\n  Description: ${description.substring(0, 500)}\n\n` +
              `Show this preview to the human. Only after they explicitly approve, call this tool again with confirm=true.`,
          },
        ],
      };
    }
    // Phase 8 (the final phase) will wire the real Jira API here (scoped token, single project)
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Confirmation received, but Jira integration is deliberately the final phase (Phase 8) and is not connected yet. Nothing was created — save the approved story as a local draft instead. The gated-write flow you just exercised is exactly how the real call will work.',
        },
      ],
    };
  }
);

// --- Test Case Writer (Phase 2 — available) --------------------------------

server.registerTool(
  'write_test_cases',
  {
    title: 'Test Case Writer: protocol + template for manual test cases',
    description:
      'Turn a user story into structured manual test cases. Returns the writing protocol, the document template, and the conventions. ' +
      'Follow the protocol: derive cases from every acceptance criterion, build the coverage matrix, then write the document to ' +
      'repos/TestCases/<story-id> Testcases.md — the staging folder beside the repo clones (outside git; human reviews).',
    inputSchema: {
      story: z.string().describe('The user story text including acceptance criteria (local draft or Jira text)'),
      feature_area: z.string().default('GENERAL').describe('Short area code used in test case IDs, e.g. LOGIN, ACCOUNT'),
    },
  },
  async ({ story, feature_area }) => {
    const area = feature_area.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 12) || 'GENERAL';
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              agent: 'test-case-writer',
              story_received: story.substring(0, 200),
              writing_protocol: [
                '1. Extract every acceptance criterion from the story; number them AC-1, AC-2, ...',
                '2. For EACH criterion derive: one positive case, negative case(s) for every input/validation rule, edge cases (empty, boundary, duplicate), and a permission/profile case where access control is relevant',
                `3. Assign IDs sequentially: TC-${area}-001, TC-${area}-002, ... — check repos/TestCases/ for existing ${area} files first and continue the sequence, never renumber existing cases`,
                '4. Write every step in third person — "User navigates to ...", "User clicks ...", "User enters ...", "User validates ..." — one action per step, with exact URLs, quoted button/field labels, and concrete values, so someone who has never seen the system can execute it. This phrasing matches the Cucumber step definitions, so Candidates lift directly in Phase 3',
                '5. Build the coverage matrix: every AC maps to at least one test case — an unmapped AC means you are not done',
                '6. Mark each case as an automation Candidate (with a proposed tag from the vocabulary) or Manual-only (with the reason)',
                `7. Save as a LOCAL file: repos/TestCases/<story-id> Testcases.md (e.g. "US-002 Testcases.md"), beside the repo clones (template: TestCases/TEMPLATE.md; create the folder if missing). Never commit or push`,
              ],
              conventions: {
                id_scheme: `TC-${area}-NNN`,
                priorities: ['Critical', 'High', 'Medium', 'Low'],
                types: ['Positive', 'Negative', 'Edge', 'Permission'],
                tag_vocabulary: ['@Smoke', '@Regression', '@CriticalPath', '@Login', '@AccountCreation', 'or a new @FeatureArea tag (see AgentInstructions for new-tag follow-ups)'],
                automation_rule: 'Deterministic, repeatable, UI-reachable cases are Candidates; org-policy, email, or visual-judgement cases are Manual-only with a stated reason',
                step_style: 'Third person, one action per step ("User navigates to https://...", "User clicks the \"Log In\" button", "User validates the App Launcher is visible"). Detailed enough to follow with zero system knowledge — never "login as usual"',
              },
              template:
                `# Test Cases — <Story title>\n\n**Story:** <story id / local draft reference>\n**Feature area:** ${area}\n**Author:** <agent + human reviewer>\n**Date:** <YYYY-MM-DD>\n\n## Coverage matrix\n\n| Acceptance criterion | Test cases |\n|---|---|\n| AC-1: <text> | TC-${area}-001, TC-${area}-002 |\n\n---\n\n## TC-${area}-001 — <title>\n\n- **Priority:** Critical | High | Medium | Low\n- **Type:** Positive | Negative | Edge | Permission\n- **Automation:** Candidate (@Tag) | Manual-only (<reason>)\n- **Preconditions:** <state before the test>\n\n| # | Step (action) | Expected result |\n|---|---|---|\n| 1 | User <action — exact URL / quoted label / concrete value> | <exact observable result> |\n`,
              output_location: 'repos/TestCases/<story-id> Testcases.md — staging folder beside the repo clones (see TestCases/README.md; worked example: "TestCases/US-001 Testcases.md")',
              next_step: 'After human review, the QA Automation Writer (Phase 3) converts automation Candidates into Cucumber scenarios.',
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// --- Code review agents (available now — read-only + local test execution) --

server.registerTool(
  'review_dev_code',
  {
    title: 'Dev Code Reviewer: review protocol for Salesforce code',
    description:
      'Returns the review protocol for Salesforce dev code (Apex/LWC/Flow): security checklist, best-practice rules, and testing steps. ' +
      'Follow the protocol: read the files with read_repo_file, evaluate every checklist item, report findings with severity and file:line, then run run_dev_tests.',
    inputSchema: {
      scope: z.string().default('all changed files').describe('What is being reviewed, e.g. a class name, folder, or "all changed files"'),
    },
  },
  async ({ scope }) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            reviewer: 'dev-code-reviewer',
            scope,
            security_checklist: [
              'SOQL injection: no string concatenation in queries — bind variables only',
              'CRUD/FLS: enforce with WITH USER_MODE, Security.stripInaccessible, or explicit isAccessible/isUpdateable checks',
              'Sharing: every class declares "with sharing" (or documents WHY "without sharing" is required)',
              'No hardcoded IDs, credentials, endpoints, or org URLs — use Custom Metadata/Named Credentials',
              'LWC: no unsanitized innerHTML / lwc:dom="manual" misuse; no eval-like patterns',
              'No secrets in Custom Labels, Custom Settings, or debug logs',
            ],
            best_practices_checklist: [
              'Bulkification: no SOQL or DML inside loops; handle 200-record batches',
              'Governor limits: aggregate queries, use Maps for lookups, avoid nested queries in loops',
              'One trigger per object, logic delegated to a handler class',
              'Defensive coding: null checks, empty-list guards, try-catch with meaningful handling',
              'Tests: >= 75% coverage, real assertions (not just coverage), @TestSetup used, no @SeeAllData=true',
              'Naming and ApexDoc consistent with existing classes in force-app/',
            ],
            testing_steps: [
              'Run run_dev_tests (optionally scoped to the relevant test class)',
              'Confirm all tests pass and coverage did not drop',
            ],
            report_format:
              'For each finding: severity (Critical/Major/Minor), file:line, what is wrong, and the concrete fix. End with a verdict: APPROVE / APPROVE WITH COMMENTS / REQUEST CHANGES.',
          },
          null,
          2
        ),
      },
    ],
  })
);

server.registerTool(
  'review_qa_code',
  {
    title: 'QA Code Reviewer: review protocol for automation code',
    description:
      'Returns the review protocol for QA automation code: standards compliance (AgentInstructions.md), security checklist, and testing steps. ' +
      'Follow the protocol: call get_agent_standards for the full standards, read the files with read_repo_file, evaluate every item, report findings with severity and file:line, then run run_qa_tests.',
    inputSchema: {
      scope: z.string().default('all changed files').describe('What is being reviewed, e.g. a page object, feature file, or "all changed files"'),
    },
  },
  async ({ scope }) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            reviewer: 'qa-code-reviewer',
            scope,
            standards_source: 'Call get_agent_standards for the full mandatory standards (AgentInstructions.md). Key items below.',
            oop_checklist: [
              'New page = locator class + page class extending BasePage + exported singleton (never static page classes)',
              'Page implements pageName getter and its own waitForPageLoad()',
              'Pure-static utility/locator classes have a private constructor',
              'Playwright APIs touched ONLY inside src/utils/ — pages call utils, steps call pages',
              'Reuse existing InputUtils/WaitUtils/SalesforceLogin helpers before adding new ones',
            ],
            exception_handling_checklist: [
              'Every method has try/catch — no raw Playwright errors escaping',
              'Typed errors from src/exceptions: BrowserError, ElementActionError, WaitTimeoutError, ConfigurationError',
              'catch (error: unknown) — never any; messages via FrameworkError.messageFrom',
              'Layering: utils wrap+type, pages log+rethrow, steps log business meaning+rethrow',
            ],
            security_checklist: [
              'No hardcoded credentials, usernames, passwords, tokens, or org URLs anywhere (feature files included)',
              'New env vars added to Config, Config.validate(), AND .env.example',
              'Nothing reads or writes .env or .auth/; no secrets in logs',
            ],
            general_checklist: [
              'Logger only — no console.log; no hard sleeps (waitForTimeout as delay)',
              'cucumber.js parallel stays 1; browser lifecycle only in Before/After hooks',
              'New tags: npm scripts + launch.json + README table updated (dashboard auto-discovers)',
            ],
            testing_steps: ['Run run_qa_tests with the affected tag (e.g. @Smoke or the new feature tag)', 'All scenarios must pass'],
            report_format:
              'For each finding: severity (Critical/Major/Minor), file:line, what is wrong, and the concrete fix. End with a verdict: APPROVE / APPROVE WITH COMMENTS / REQUEST CHANGES.',
          },
          null,
          2
        ),
      },
    ],
  })
);

server.registerTool(
  'run_qa_tests',
  {
    title: 'Run QA automation tests by tag',
    description:
      'Executes the QA test suite for one tag (via test-runner.js in the QA repo) and returns the result. Headless, sequential. Used by the qa-code-reviewer to verify changes.',
    inputSchema: {
      tag: z.string().regex(/^@[A-Za-z0-9_-]+$/, 'Tag must look like @Smoke').describe('Cucumber tag to run, e.g. @Smoke'),
    },
  },
  async ({ tag }) => {
    try {
      if (!fs.existsSync(path.join(REPOS.qa, 'test-runner.js'))) {
        throw new Error(`QA repo with test-runner.js not found at: ${REPOS.qa}`);
      }
      const { stdout, stderr } = await execFileAsync('node', ['test-runner.js', tag], {
        cwd: REPOS.qa,
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const output = (stdout + '\n' + stderr).trim();
      return { content: [{ type: 'text' as const, text: `EXIT: success\n\n...${output.slice(-3000)}` }] };
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      const output = ((err.stdout ?? '') + '\n' + (err.stderr ?? '')).trim();
      return {
        content: [{ type: 'text' as const, text: `EXIT: FAILED (${err.message ?? 'unknown error'})\n\n...${output.slice(-3000)}` }],
        isError: true,
      };
    }
  }
);

server.registerTool(
  'run_dev_tests',
  {
    title: 'Run Salesforce Apex tests',
    description:
      'Runs Apex tests against the default authorized org via the Salesforce CLI (sf). Optionally scoped to one test class. Used by the dev-code-reviewer to verify changes. Requires sf CLI installed and an authorized org.',
    inputSchema: {
      test_class: z.string().regex(/^[A-Za-z0-9_]*$/).default('').describe('Optional Apex test class name; empty = run all local tests'),
    },
  },
  async ({ test_class }) => {
    try {
      const args = ['apex', 'run', 'test', '--synchronous', '--result-format', 'human', '--code-coverage'];
      if (test_class) {
        args.push('--class-names', test_class);
      } else {
        args.push('--test-level', 'RunLocalTests');
      }
      const { stdout, stderr } = await execFileAsync('sf', args, {
        cwd: REPOS.dev,
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const output = (stdout + '\n' + stderr).trim();
      return { content: [{ type: 'text' as const, text: `EXIT: success\n\n...${output.slice(-3000)}` }] };
    } catch (error: unknown) {
      const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
      if (err.code === 'ENOENT') {
        return {
          content: [{ type: 'text' as const, text: 'Error: Salesforce CLI (sf) is not installed on this machine — install it or run Apex tests via the CI/CD pipeline instead.' }],
          isError: true,
        };
      }
      const output = ((err.stdout ?? '') + '\n' + (err.stderr ?? '')).trim();
      return {
        content: [{ type: 'text' as const, text: `EXIT: FAILED (${err.message ?? 'unknown error'})\n\n...${output.slice(-3000)}` }],
        isError: true,
      };
    }
  }
);

// --- Sub-agent stubs for later phases -------------------------------------
const STUBS: Array<{ name: string; title: string; phase: number }> = [
  { name: 'generate_qa_automation', title: 'Generate Cucumber/Playwright automation', phase: 3 },
  { name: 'generate_dev_code', title: 'Generate Apex/LWC/Flow changes (local only)', phase: 4 },
];

for (const stub of STUBS) {
  server.registerTool(
    stub.name,
    {
      title: stub.title,
      description: `${stub.title}. NOT IMPLEMENTED YET — planned for Phase ${stub.phase}. Calling it returns guidance, not output.`,
      inputSchema: { input: z.string().describe('The story, test cases, or requirement to work from') },
    },
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: `This sub-agent arrives in Phase ${stub.phase}. Until then: use get_agent_standards + read_repo_file for context and let the LLM generate the artifacts manually, writing only local files.`,
        },
      ],
    })
  );
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout belongs to the MCP protocol — log to stderr only
  console.error('[sdlc-orchestrator] MCP server running on stdio');
}

main().catch(error => {
  console.error('[sdlc-orchestrator] Fatal:', error);
  process.exit(1);
});
