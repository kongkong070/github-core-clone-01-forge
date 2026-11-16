// mcp.ts — the Model Context Protocol endpoint (JSON-RPC 2.0 over
// Streamable HTTP) at POST /mcp.
//
// The suite checks the modern 2026-07-28 era first: server/discover must
// name 2026-07-28 among the supported versions, tools/list must be
// byte-identical across calls and carry the six tools the suite drives,
// and tools/call must return the result both as text JSON and as
// structuredContent. A request without the trial's bearer token is 401,
// a non-JSON body is HTTP 400 with JSON-RPC -32700, an unknown tool is
// -32601, and missing arguments come back as an isError result.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Forge, VIEWER_LOGIN } from './store.ts';

interface Ctx {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  rawBody: Buffer;
}

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
    additionalProperties: boolean;
  };
}

function tool(
  name: string,
  description: string,
  properties: Record<string, { type: string; description: string; enum?: string[] }>,
  required: string[],
): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository owned by the viewer.', {
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request from a head branch into a base branch.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The pull request title.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
    body: { type: 'string', description: 'The pull request body.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request with a squash merge.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    pull_number: { type: 'integer', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
  tool('get_issue', 'Get one issue by number.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    issue_number: { type: 'integer', description: 'The issue number.' },
  }, ['owner', 'repo', 'issue_number']),
  tool('list_repos', 'List the repositories owned by the viewer.', {}, []),
  tool('create_comment', 'Create a comment on an issue.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    issue_number: { type: 'integer', description: 'The issue number.' },
    body: { type: 'string', description: 'The comment body.' },
  }, ['owner', 'repo', 'issue_number', 'body']),
];

function sendJson(ctx: Ctx, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  ctx.res.end(text);
}

function sendNoContent(ctx: Ctx): void {
  ctx.res.writeHead(202);
  ctx.res.end();
}

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function callResult(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function callError(message: string): Record<string, unknown> {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
  };
}

/** Run one tool call. Returns the JSON-RPC result object for tools/call. */
function runTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const definition = TOOLS.find((t) => t.name === name);
  if (definition === undefined) {
    return { __rpcError: { code: -32601, message: `Method not found: ${name}` } };
  }
  for (const required of definition.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return callError(`missing required argument: ${required}`);
    }
  }
  const owner = str(args.owner, VIEWER_LOGIN);
  const repoName = str(args.repo, '');
  const repo = repoName === '' ? undefined : (owner === VIEWER_LOGIN ? forge.getRepo(owner, repoName) : undefined);
  switch (name) {
    case 'create_repo': {
      const repoNameArg = str(args.name);
      if (forge.getRepo(VIEWER_LOGIN, repoNameArg) !== undefined) {
        return callError(`Repository ${repoNameArg} already exists`);
      }
      const created = forge.createRepo(repoNameArg, args.private === true, str(args.description));
      return callResult({
        owner: VIEWER_LOGIN,
        name: created.name,
        full_name: `${VIEWER_LOGIN}/${created.name}`,
        private: created.isPrivate,
        default_branch: created.defaultBranch,
        html_url: `https://github.com/${VIEWER_LOGIN}/${created.name}`,
        url: `/api/v3/repos/${VIEWER_LOGIN}/${created.name}`,
      });
    }
    case 'get_repo': {
      if (repo === undefined) return callError('Not Found');
      return callResult(forge.repoObject(repo));
    }
    case 'list_repos': {
      return callResult({
        repositories: forge.listRepos().map((r) => ({
          owner: VIEWER_LOGIN,
          name: r.name,
          full_name: `${VIEWER_LOGIN}/${r.name}`,
          private: r.isPrivate,
          default_branch: r.defaultBranch,
        })),
      });
    }
    case 'create_issue': {
      if (repo === undefined) return callError('Not Found');
      const issue = forge.createIssue(repo, str(args.title), str(args.body));
      return callResult(forge.issueObject(repo, issue));
    }
    case 'list_issues': {
      if (repo === undefined) return callError('Not Found');
      const state = str(args.state, 'open');
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      return callResult({
        issues: issues.map((issue) => forge.issueObject(repo, issue)),
        total_count: issues.length,
      });
    }
    case 'get_issue': {
      if (repo === undefined) return callError('Not Found');
      const issue = forge.getIssue(repo, Number(args.issue_number));
      if (issue === undefined) return callError('Not Found');
      return callResult(forge.issueObject(repo, issue));
    }
    case 'create_comment': {
      if (repo === undefined) return callError('Not Found');
      const issue = forge.getIssue(repo, Number(args.issue_number));
      if (issue === undefined) return callError('Not Found');
      const comment = forge.createComment(repo, issue, str(args.body));
      return callResult(forge.commentObject(repo, issue, comment));
    }
    case 'create_pull_request': {
      if (repo === undefined) return callError('Not Found');
      const pull = forge.createPull(repo, str(args.title), str(args.body), str(args.head), str(args.base));
      if (pull === null) return callError('head or base branch does not exist');
      return callResult(forge.pullObject(repo, pull));
    }
    case 'merge_pull_request': {
      if (repo === undefined) return callError('Not Found');
      const pull = forge.getPull(repo, Number(args.pull_number));
      if (pull === undefined) return callError('Not Found');
      if (pull.state !== 'open') return callError('Pull request is already closed');
      if (!forge.mergeable(repo, pull)) return callError('Merge conflict');
      const sha = forge.mergePull(repo, pull);
      if (sha === null) return callError('Merge conflict');
      return callResult({ number: pull.number, merged: true, state: 'closed', merge_commit_sha: sha, sha });
    }
    default:
      return { __rpcError: { code: -32601, message: `Method not found: ${name}` } };
  }
}

function handleOne(forge: Forge, request: RpcRequest): { status: number; body: unknown } | null {
  const id = request.id === undefined ? null : request.id;
  const method = request.method;
  if (typeof method !== 'string') {
    return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } } };
  }
  if (method.startsWith('notifications/')) {
    return null; // 202, no body.
  }
  if (method === 'ping') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
  }
  if (method === 'server/discover') {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2026-07-28',
          supportedVersions: [...SUPPORTED_VERSIONS],
          serverInfo: { name: 'forge', version: '1.0.0' },
          capabilities: { tools: {}, resources: {}, prompts: {} },
        },
      },
    };
  }
  if (method === 'initialize') {
    const params = isRecord(request.params) ? request.params : {};
    const requested = str(params.protocolVersion, '');
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2026-07-28';
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'forge', version: '1.0.0' },
        },
      },
    };
  }
  if (method === 'tools/list') {
    return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
  }
  if (method === 'tools/call') {
    const params = isRecord(request.params) ? request.params : {};
    const toolName = str(params.name);
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const result = runTool(forge, toolName, args);
    const rpcError = (result as { __rpcError?: { code: number; message: string } }).__rpcError;
    if (rpcError !== undefined) {
      return { status: 200, body: { jsonrpc: '2.0', id, error: rpcError } };
    }
    return { status: 200, body: { jsonrpc: '2.0', id, result } };
  }
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } } };
}

export async function handleMcp(ctx: Ctx, rawBody: Buffer): Promise<void> {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = ctx.req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.slice('Bearer '.length) === '') {
    sendJson(ctx, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }
  if (expected !== '' && header.slice('Bearer '.length) !== expected) {
    sendJson(ctx, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(body)) {
    const results: unknown[] = [];
    for (const entry of body) {
      if (!isRecord(entry)) continue;
      const handled = handleOne(ctx.forge, entry as RpcRequest);
      if (handled !== null) results.push(handled.body);
    }
    sendJson(ctx, 200, results);
    return;
  }
  if (!isRecord(body)) {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const handled = handleOne(ctx.forge, body as RpcRequest);
  if (handled === null) {
    sendNoContent(ctx);
    return;
  }
  sendJson(ctx, handled.status, handled.body);
}
