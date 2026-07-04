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
 *                           Jira story stub; real Jira lands in Phase 2)
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, '../..');

/**
 * Repo resolution, three tiers:
 *  1. Env override (SDLC_DEV_REPO / SDLC_QA_REPO) — set by the client config,
 *     e.g. "${workspaceFolder}" in .vscode/mcp.json
 *  2. Working-directory sniff — clients launch stdio servers with cwd set to
 *     the open project, so a marker file identifies which repo the user is in
 *  3. Standard umbrella-workspace layout (orchestrator/ beside repos/)
 */
function detectRepoFromCwd(markerFile: string): string | undefined {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, markerFile)) ? cwd : undefined;
}

const REPOS = {
  dev: process.env.SDLC_DEV_REPO
    ?? detectRepoFromCwd('sfdx-project.json')
    ?? path.join(WORKSPACE_ROOT, 'repos', 'Salesforce-Dev'),
  qa: process.env.SDLC_QA_REPO
    ?? detectRepoFromCwd('cucumber.js')
    ?? path.join(WORKSPACE_ROOT, 'repos', 'Salesforce-QA-Automation'),
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
  { agent: 'user-story-generator', phase: 2, status: 'planned', keywords: /\b(user stor(y|ies)|requirement|epic|acceptance criteria|as a user)\b/i },
  { agent: 'test-case-writer', phase: 3, status: 'planned', keywords: /\b(test case|manual test|test plan|test scenario)\b/i },
  { agent: 'qa-automation-writer', phase: 4, status: 'planned', keywords: /\b(automat(e|ion)|playwright|cucumber|bdd|feature file|selenium|regression suite)\b/i },
  { agent: 'dev-code-generator', phase: 5, status: 'planned', keywords: /\b(apex|lwc|lightning web component|trigger|flow|validation rule|salesforce code|metadata)\b/i },
  { agent: 'agile-board-connector', phase: 2, status: 'planned', keywords: /\b(jira|board|sprint|backlog|ticket|issue)\b/i },
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
              next_step: 'Fill in the template with the LLM, review with the human, then call create_jira_story with confirm=true.',
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
    // Phase 2 will wire the real Jira API here (scoped token, single project)
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Confirmation received, but Jira integration is not connected yet (Phase 2). Nothing was created. The gated-write flow you just exercised is exactly how the real call will work.',
        },
      ],
    };
  }
);

// --- Sub-agent stubs for later phases -------------------------------------
const STUBS: Array<{ name: string; title: string; phase: number }> = [
  { name: 'write_test_cases', title: 'Write manual test cases from a story', phase: 3 },
  { name: 'generate_qa_automation', title: 'Generate Cucumber/Playwright automation', phase: 4 },
  { name: 'generate_dev_code', title: 'Generate Apex/LWC/Flow changes (local only)', phase: 5 },
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
