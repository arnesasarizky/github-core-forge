// The MCP endpoint: JSON-RPC 2.0 over Streamable HTTP, answering plain
// application/json. It speaks both eras the suite negotiates: the
// 2026-07-28 revision (server/discover) and the classic initialize
// handshake. The six tools act on the same store as REST and GraphQL,
// and answer with the same object shapes those surfaces serve.

import type { Forge, RepoState } from './store.ts';
import {
  handleCreateIssue,
  handleCreatePull,
  handleCreateRepo,
  handleMergePull,
  issueShape,
  pullShape,
  repoShape,
} from './rest.ts';

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly properties: Record<string, { type: string; description: string }>;
  readonly required: readonly string[];
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The name of the repository to create.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body of the issue.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      head: { type: 'string', description: 'The head branch to merge from.' },
      base: { type: 'string', description: 'The base branch to merge into.' },
      body: { type: 'string', description: 'The body of the pull request.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The owner of the repository.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsList(): unknown {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: 'object',
        properties: tool.properties,
        required: [...tool.required],
      },
    })),
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoFor(forge: Forge, args: Record<string, unknown>): RepoState | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner && !forge.resolveOwner(owner)) return null;
  return forge.repoByName(name) ?? null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | 'unknown' {
  const wanted = name.toLowerCase();
  const tool = TOOLS.find((t) => wanted === t.name || wanted.endsWith(`__${t.name}`) || wanted.endsWith(t.name));
  if (!tool) return 'unknown';
  for (const required of tool.required) {
    const alt = required === 'pull_number' ? (args.pull_number ?? args.pullNumber ?? args.number) : args[required];
    if (alt === undefined || alt === null || alt === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  switch (tool.name) {
    case 'create_repo': {
      const result = handleCreateRepo(forge, { name: args.name, description: args.description, private: args.private });
      if (result.status !== 201) return toolError(JSON.stringify(result.body));
      return toolResult(result.body);
    }
    case 'get_repo': {
      const repo = repoFor(forge, args);
      if (!repo) return toolError('repository not found');
      return toolResult(repoShape(forge, repo));
    }
    case 'create_issue': {
      const repo = repoFor(forge, args);
      if (!repo) return toolError('repository not found');
      const result = handleCreateIssue(forge, repo, { title: args.title, body: args.body });
      if (result.status !== 201) return toolError(JSON.stringify(result.body));
      return toolResult(result.body);
    }
    case 'list_issues': {
      const repo = repoFor(forge, args);
      if (!repo) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      let list = [...repo.issues.values()].filter((i) => !i.isPull);
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      return toolResult(list.map((i) => issueShape(forge, repo, i)));
    }
    case 'create_pull_request': {
      const repo = repoFor(forge, args);
      if (!repo) return toolError('repository not found');
      const result = handleCreatePull(forge, repo, { title: args.title, body: args.body, head: args.head, base: args.base });
      if (result.status !== 201) return toolError(JSON.stringify(result.body));
      return toolResult(result.body);
    }
    case 'merge_pull_request': {
      const repo = repoFor(forge, args);
      if (!repo) return toolError('repository not found');
      const number = Number(args.pull_number ?? args.pullNumber ?? args.number);
      const result = handleMergePull(forge, repo, number, { merge_method: 'squash' });
      if (result.status !== 200) return toolError(JSON.stringify(result.body));
      const pull = repo.pulls.get(number);
      return toolResult(pull ? { ...pullShape(forge, repo, pull), ...(result.body as Record<string, unknown>) } : result.body);
    }
  }
  return 'unknown';
}

export interface McpReply {
  readonly status: number;
  readonly body: unknown; // null means: no body (a notification)
}

/** Handle one JSON-RPC message (already parsed). */
export function handleMcpMessage(forge: Forge, message: Record<string, unknown>): McpReply {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = (message.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  const result = (value: unknown): McpReply => ({ status: 200, body: { jsonrpc: '2.0', id, result: value } });
  const error = (code: number, text: string): McpReply => ({
    status: 200,
    body: { jsonrpc: '2.0', id: id ?? null, error: { code, message: text } },
  });

  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return result({
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      });
    }
    case 'server/discover':
      return result({
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      });
    case 'ping':
      return result({});
    case 'tools/list':
      return result(toolsList());
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const outcome = callTool(forge, name, args);
      if (outcome === 'unknown') return error(-32601, `unknown tool: ${name}`);
      return result(outcome);
    }
    case 'resources/list':
      return result({ resources: [] });
    case 'prompts/list':
      return result({ prompts: [] });
    default:
      if (isNotification) return { status: 202, body: null };
      return error(-32601, `method not found: ${method}`);
  }
}
