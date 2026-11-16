// app.ts — the forge's HTTP server: REST v3, git smart HTTP, GraphQL v4
// and MCP, all on the one in-memory store.
//
// Every REST reply is application/json and carries a non-empty
// X-GitHub-Request-Id. An error carries a JSON body with a string
// message. A request without the trial's bearer token is 401, and a
// repository belongs to the login the token names, so the same repository
// name under another owner is 404, never 403.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { hashObject, parseTree } from './git.ts';
import {
  handleReceivePack,
  handleUploadPackV0,
  handleUploadPackV2,
  v0Advertisement,
  v2Advertisement,
} from './githttp.ts';
import { Forge, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './store.ts';
import type { Repo } from './store.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export function createForge(): Forge {
  return new Forge();
}

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

function sendJson(ctx: Ctx, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.forge.nextRequestId(),
    ...extra,
  });
  ctx.res.end(text);
}

function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

function sendNoContent(ctx: Ctx): void {
  ctx.res.writeHead(204, {
    'content-type': JSON_TYPE,
    'x-github-request-id': ctx.forge.nextRequestId(),
  });
  ctx.res.end();
}

function tokenOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

function tokenValid(ctx: Ctx): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const presented = tokenOf(ctx.req);
  if (presented === null || presented === '') return false;
  if (expected === '') return true;
  return presented === expected;
}

/** Read the whole request body. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a JSON request body. Returns {ok:false} when the body is present
 * but not valid JSON (the caller answers 400), {ok:true, value} otherwise.
 */
function parseJsonBody(raw: Buffer): { ok: boolean; value: unknown } {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false, value: undefined };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Pagination: per_page (default 30) and page (default 1), with a Link header. */
function paginate<T>(ctx: Ctx, items: T[]): { page: T[]; link: string | null } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const base = `http://${ctx.req.headers.host ?? 'localhost'}${ctx.url.pathname}`;
  const linkFor = (p: number): string => `${base}?per_page=${perPage}&page=${p}`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${linkFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${linkFor(page - 1)}>; rel="prev"`);
  if (totalPages > 1) {
    links.push(`<${linkFor(1)}>; rel="first"`);
    links.push(`<${linkFor(totalPages)}>; rel="last"`);
  }
  return { page: pageItems, link: links.length > 0 ? links.join(', ') : null };
}

function sendPage<T>(ctx: Ctx, items: T[]): void {
  const { page, link } = paginate(ctx, items);
  sendJson(ctx, 200, page, link === null ? {} : { link });
}

// -------------------------------------------------------------------------------------------
// contents helpers
// -------------------------------------------------------------------------------------------

/** The file map at a branch, creating the branch from the default tip when needed. */
function branchFiles(forge: Forge, repo: Repo, branch: string): Map<string, string> {
  const ref = `refs/heads/${branch}`;
  if (!repo.refs.has(ref)) {
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip !== undefined) repo.refs.set(ref, defaultTip);
  }
  return forge.filesAtRef(repo, branch);
}

function contentEntry(repo: Repo, path: string, blobOid: string, contentBase64: string): Record<string, unknown> {
  const object = repo.objects.get(blobOid);
  const size = object ? object.data.length : 0;
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name,
    path,
    content: contentBase64,
    sha: blobOid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
    download_url: `https://github.com/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
  };
}

// -------------------------------------------------------------------------------------------
// REST v3
// -------------------------------------------------------------------------------------------

async function handleRest(ctx: Ctx): Promise<void> {
  const seg = ctx.segments; // after /api/v3
  const method = ctx.req.method ?? 'GET';

  // The API root and meta are public; everything else needs the token.
  if (method === 'GET' && seg.length === 0) {
    sendJson(ctx, 200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && seg.length === 1 && seg[0] === 'meta') {
    sendJson(ctx, 200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      github_services_sha: '0000000000000000000000000000000000000000',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (method === 'GET' && seg.length === 1 && seg[0] === 'rate_limit') {
    const reset = forge.baseEpochSec + 3600;
    sendJson(ctx, 200, {
      resources: {
        core: { limit: 5000, remaining: 4999, reset, used: 1 },
        search: { limit: 30, remaining: 30, reset, used: 0 },
      },
      rate: { limit: 5000, remaining: 4999, reset, used: 1 },
    });
    return;
  }
  if (!tokenValid(ctx)) {
    sendError(ctx, 401, 'Requires authentication');
    return;
  }

  // A JSON body that does not parse is a 400 on every write route.
  if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && ctx.rawBody.length > 0) {
    const parsed = parseJsonBody(ctx.rawBody);
    if (!parsed.ok) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return;
    }
    ctx.body = parsed.value;
  }

  const forge = ctx.forge;

  // GET /user — the token's own login.
  if (method === 'GET' && seg.length === 1 && seg[0] === 'user') {
    sendJson(ctx, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: `U_${VIEWER_ID}`,
      type: 'User',
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      html_url: `https://github.com/${VIEWER_LOGIN}`,
      url: '/api/v3/user',
    });
    return;
  }

  // GET/POST /user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      sendPage(ctx, forge.listRepos().map((repo) => forge.repoObject(repo)));
      return;
    }
    if (method === 'POST') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const name = str(body.name);
      if (name === '') {
        sendError(ctx, 422, 'name is required');
        return;
      }
      if (forge.getRepo(VIEWER_LOGIN, name) !== undefined) {
        sendError(ctx, 422, 'Repository already exists');
        return;
      }
      const repo = forge.createRepo(
        name,
        body.private === true,
        str(body.description),
      );
      sendJson(ctx, 201, forge.repoObject(repo));
      return;
    }
  }

  // /repos/{owner}/{repo}[...]
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = decodeSegment(seg[1] as string);
    const repoName = decodeSegment(seg[2] as string);
    const repo = owner === VIEWER_LOGIN ? forge.getRepo(owner, repoName) : undefined;
    if (repo === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const rest = seg.slice(3);

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(ctx, 200, forge.repoObject(repo));
        return;
      }
      if (method === 'PATCH') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        sendJson(ctx, 200, forge.repoObject(repo));
        return;
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repo);
        sendNoContent(ctx);
        return;
      }
      sendError(ctx, 404, 'Not Found');
      return;
    }

    // /branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((name) => name.startsWith('refs/heads/'))
          .sort()
          .map((name) => ({
            name: name.slice('refs/heads/'.length),
            commit: { sha: repo.refs.get(name) as string, url: '' },
            protected: false,
          }));
        sendJson(ctx, 200, branches);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decodeSegment(rest[1] as string);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) {
          sendError(ctx, 404, 'Not Found');
          return;
        }
        sendJson(ctx, 200, { name: branch, commit: { sha, url: '' }, protected: false });
        return;
      }
      sendError(ctx, 404, 'Not Found');
      return;
    }

    // /commits
    if (rest[0] === 'commits' && method === 'GET') {
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const commits = forge.commitsFrom(repo, ref).map((entry) => ({
        sha: entry.sha,
        commit: {
          message: entry.message,
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: new Date(entry.epoch * 1000).toISOString() },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: new Date(entry.epoch * 1000).toISOString() },
        },
        author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        url: `/api/v3/repos/${owner}/${repoName}/commits/${entry.sha}`,
        html_url: `https://github.com/${owner}/${repoName}/commit/${entry.sha}`,
      }));
      sendPage(ctx, commits);
      return;
    }

    // /git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
          sendError(ctx, 422, 'Invalid ref or sha');
          return;
        }
        if (repo.objects.get(sha) === undefined) {
          sendError(ctx, 422, 'Object does not exist');
          return;
        }
        if (repo.refs.has(ref)) {
          sendError(ctx, 422, 'Reference already exists');
          return;
        }
        repo.refs.set(ref, sha);
        const type = repo.objects.get(sha)?.type ?? 'commit';
        sendJson(ctx, 201, { ref, node_id: `R_${sha}`, url: '', object: { sha, type, url: '' } });
        return;
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          const all = [...repo.refs.entries()].map(([ref, sha]) => ({
            ref,
            node_id: `R_${sha}`,
            url: '',
            object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' },
          }));
          sendJson(ctx, 200, all);
          return;
        }
        const refPath = rest.slice(2).map(decodeSegment).join('/');
        const ref = `refs/${refPath}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          sendError(ctx, 404, 'Not Found');
          return;
        }
        sendJson(ctx, 200, {
          ref,
          node_id: `R_${sha}`,
          url: '',
          object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' },
        });
        return;
      }
      sendError(ctx, 404, 'Not Found');
      return;
    }

    // /contents/{path...}
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map(decodeSegment).join('/');
      if (method === 'GET') {
        const ref = ctx.query.get('ref') ?? repo.defaultBranch;
        const files = forge.filesAtRef(repo, ref);
        if (filePath === '') {
          // The repository root as a directory listing.
          const entries = directoryEntries(forge, repo, files, '');
          sendJson(ctx, 200, entries);
          return;
        }
        const blobOid = files.get(filePath);
        if (blobOid !== undefined) {
          const object = repo.objects.get(blobOid);
          const base64 = object ? object.data.toString('base64') : '';
          sendJson(ctx, 200, contentEntry(repo, filePath, blobOid, base64));
          return;
        }
        const prefix = `${filePath}/`;
        if ([...files.keys()].some((path) => path.startsWith(prefix))) {
          sendJson(ctx, 200, directoryEntries(forge, repo, files, filePath));
          return;
        }
        sendError(ctx, 404, 'Not Found');
        return;
      }
      if (method === 'PUT') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const contentBase64 = str(body.content);
        if (contentBase64 === '') {
          sendError(ctx, 422, 'content is required');
          return;
        }
        const bytes = Buffer.from(contentBase64, 'base64');
        const branch = str(body.branch, repo.defaultBranch);
        const files = branchFiles(forge, repo, branch);
        const existing = files.get(filePath);
        const sha = str(body.sha, '');
        if (existing !== undefined) {
          if (sha === '') {
            sendError(ctx, 422, 'sha is required to update a file');
            return;
          }
          if (sha !== existing) {
            sendError(ctx, 409, 'sha does not match the current file');
            return;
          }
        }
        const blobOid = hashObject('blob', bytes);
        repo.objects.set(blobOid, { type: 'blob', data: bytes });
        const isNew = existing === undefined;
        files.set(filePath, blobOid);
        const commitSha = forge.commitFiles(repo, branch, files, str(body.message, 'Update file'));
        sendJson(ctx, isNew ? 201 : 200, {
          content: contentEntry(repo, filePath, blobOid, contentBase64),
          commit: {
            sha: commitSha,
            message: str(body.message, 'Update file'),
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: forge.nowIso() },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: forge.nowIso() },
          },
        });
        return;
      }
      if (method === 'DELETE') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const branch = str(body.branch, repo.defaultBranch);
        const files = branchFiles(forge, repo, branch);
        const existing = files.get(filePath);
        if (existing === undefined) {
          sendError(ctx, 404, 'Not Found');
          return;
        }
        const sha = str(body.sha, '');
        if (sha !== '' && sha !== existing) {
          sendError(ctx, 409, 'sha does not match the current file');
          return;
        }
        files.delete(filePath);
        const commitSha = forge.commitFiles(repo, branch, files, str(body.message, 'Delete file'));
        sendJson(ctx, 200, { commit: { sha: commitSha, message: str(body.message, 'Delete file') } });
        return;
      }
      sendError(ctx, 404, 'Not Found');
      return;
    }

    // /labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(ctx, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const name = str(body.name);
        if (name === '') {
          sendError(ctx, 422, 'name is required');
          return;
        }
        const label = repo.labels.get(name) ?? { name, color: str(body.color, 'ededed') };
        repo.labels.set(name, label);
        sendJson(ctx, 201, { name: label.name, color: label.color, description: '' });
        return;
      }
      sendError(ctx, 404, 'Not Found');
      return;
    }

    // /issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const sort = ctx.query.get('sort') ?? 'created';
          const direction = ctx.query.get('direction') ?? 'desc';
          let issues = [...repo.issues];
          if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
          if (sort === 'created') {
            issues.sort((a, b) => {
              const bySeq = a.createdSeq - b.createdSeq;
              const byNumber = a.number - b.number;
              const cmp = bySeq !== 0 ? bySeq : byNumber;
              return direction === 'asc' ? cmp : -cmp;
            });
          }
          sendPage(ctx, issues.map((issue) => forge.issueObject(repo, issue)));
          return;
        }
        if (method === 'POST') {
          const body = isRecord(ctx.body) ? ctx.body : {};
          const title = str(body.title);
          if (title === '') {
            sendError(ctx, 422, 'title is required');
            return;
          }
          const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendError(ctx, 422, `Label "${label}" does not exist`);
              return;
            }
          }
          const issue = forge.createIssue(repo, title, str(body.body), labels);
          sendJson(ctx, 201, forge.issueObject(repo, issue));
          return;
        }
      }
      const issueNumber = Number(rest[1]);
      const issue = Number.isInteger(issueNumber) ? forge.getIssue(repo, issueNumber) : undefined;
      if (rest.length === 2) {
        if (issue === undefined) {
          sendError(ctx, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(ctx, 200, forge.issueObject(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const body = isRecord(ctx.body) ? ctx.body : {};
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
            issue.state = body.state;
            issue.updatedSeq = forge.nextSeq();
          }
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          sendJson(ctx, 200, forge.issueObject(repo, issue));
          return;
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) {
          sendError(ctx, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(ctx, 200, issue.comments.map((comment) => forge.commentObject(repo, issue, comment)));
          return;
        }
        if (method === 'POST') {
          const body = isRecord(ctx.body) ? ctx.body : {};
          const commentBody = str(body.body);
          if (commentBody === '') {
            sendError(ctx, 422, 'body is required');
            return;
          }
          const comment = forge.createComment(repo, issue, commentBody);
          sendJson(ctx, 201, forge.commentObject(repo, issue, comment));
          return;
        }
      }
      sendError(ctx, 404, 'Not Found');
      return;
    }

    // /pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let pulls = [...repo.pulls];
          if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
          else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
          pulls.sort((a, b) => b.createdSeq - a.createdSeq);
          sendPage(ctx, pulls.map((pull) => forge.pullObject(repo, pull)));
          return;
        }
        if (method === 'POST') {
          const body = isRecord(ctx.body) ? ctx.body : {};
          const head = str(body.head);
          const base = str(body.base, repo.defaultBranch);
          const title = str(body.title);
          if (head === '' || title === '') {
            sendError(ctx, 422, 'head and title are required');
            return;
          }
          if (forge.resolveRef(repo, head) === undefined || forge.resolveRef(repo, base) === undefined) {
            sendError(ctx, 422, 'head or base branch does not exist');
            return;
          }
          const existing = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
          if (existing !== undefined) {
            sendError(ctx, 422, 'A pull request already exists for this head and base');
            return;
          }
          const pull = forge.createPull(repo, title, str(body.body), head, base);
          if (pull === null) {
            sendError(ctx, 422, 'head or base branch does not exist');
            return;
          }
          sendJson(ctx, 201, forge.pullObject(repo, pull));
          return;
        }
      }
      const pullNumber = Number(rest[1]);
      const pull = Number.isInteger(pullNumber) ? forge.getPull(repo, pullNumber) : undefined;
      if (rest.length === 2) {
        if (pull === undefined) {
          sendError(ctx, 404, 'Not Found');
          return;
        }
        if (method === 'GET') {
          sendJson(ctx, 200, forge.pullObject(repo, pull));
          return;
        }
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (pull === undefined) {
          sendError(ctx, 404, 'Not Found');
          return;
        }
        sendJson(ctx, 200, forge.pullFiles(repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) {
          sendError(ctx, 404, 'Not Found');
          return;
        }
        if (pull.state !== 'open') {
          sendError(ctx, 405, 'Pull request is already closed');
          return;
        }
        if (!forge.mergeable(repo, pull)) {
          sendError(ctx, 405, 'Merge conflict');
          return;
        }
        const sha = forge.mergePull(repo, pull);
        if (sha === null) {
          sendError(ctx, 405, 'Merge conflict');
          return;
        }
        sendJson(ctx, 200, { sha, merged: true, message: 'Pull request successfully merged' });
        return;
      }
      sendError(ctx, 404, 'Not Found');
      return;
    }

    sendError(ctx, 404, 'Not Found');
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

/** Directory entries for a contents listing at `dir` ('' for the root). */
function directoryEntries(
  forge: Forge,
  repo: Repo,
  files: Map<string, string>,
  dir: string,
): Array<Record<string, unknown>> {
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map<string, { type: 'file' | 'dir'; oid: string }>();
  for (const [path, oid] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) children.set(rest, { type: 'file', oid });
    else children.set(rest.slice(0, slash), { type: 'dir', oid: '' });
  }
  // A directory's sha is its tree object: rebuild the tree for the listing.
  const treeOid = forge.buildTrees(repo, files);
  const treeAt = (targetDir: string): string => {
    if (targetDir === '') return treeOid;
    let current = treeOid;
    for (const part of targetDir.split('/')) {
      const object = repo.objects.get(current);
      if (!object) return '';
      const entry = parseTree(object.data).find((e) => e.name === part && e.mode === '40000');
      if (!entry) return '';
      current = entry.oid;
    }
    return current;
  };
  const out: Array<Record<string, unknown>> = [];
  for (const name of [...children.keys()].sort()) {
    const child = children.get(name) as { type: 'file' | 'dir'; oid: string };
    const path = prefix + name;
    out.push({
      type: child.type,
      name,
      path,
      sha: child.type === 'file' ? child.oid : treeAt(path),
      size: child.type === 'file' ? (repo.objects.get(child.oid)?.data.length ?? 0) : 0,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${path}`,
    });
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// git smart HTTP
// -------------------------------------------------------------------------------------------

async function handleGit(ctx: Ctx): Promise<void> {
  const forge = ctx.forge;
  const seg = ctx.segments; // e.g. ['adaiversen', 'repo.git', 'info', 'refs']
  if (seg.length < 3) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const owner = decodeSegment(seg[0] as string);
  const repoGit = decodeSegment(seg[1] as string);
  if (!repoGit.endsWith('.git')) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const repoName = repoGit.slice(0, -4);
  const repo = owner === VIEWER_LOGIN ? forge.getRepo(owner, repoName) : undefined;
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const method = ctx.req.method ?? 'GET';
  const service = ctx.query.get('service') ?? '';
  const gitProtocol = (ctx.req.headers['git-protocol'] ?? '').toString();

  if (method === 'GET' && seg[2] === 'info' && seg[3] === 'refs') {
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    let body: Buffer;
    let contentType: string;
    if (service === 'git-upload-pack' && gitProtocol.includes('version=2')) {
      body = v2Advertisement();
      contentType = 'application/x-git-upload-pack-advertisement';
    } else {
      body = v0Advertisement(repo, service);
      contentType = `application/x-${service}-advertisement`;
    }
    ctx.res.writeHead(200, {
      'content-type': contentType,
      'content-length': body.length,
      'x-github-request-id': forge.nextRequestId(),
    });
    ctx.res.end(body);
    return;
  }

  if (method === 'POST' && seg.length === 3) {
    const serviceName = seg[2] as string;
    try {
      if (serviceName === 'git-upload-pack') {
        const body = gitProtocol.includes('version=2')
          ? handleUploadPackV2(repo, ctx.rawBody)
          : handleUploadPackV0(repo, ctx.rawBody);
        ctx.res.writeHead(200, {
          'content-type': 'application/x-git-upload-pack-result',
          'content-length': body.length,
          'x-github-request-id': forge.nextRequestId(),
        });
        ctx.res.end(body);
        return;
      }
      if (serviceName === 'git-receive-pack') {
        const { response } = handleReceivePack(forge, repo, ctx.rawBody);
        ctx.res.writeHead(200, {
          'content-type': 'application/x-git-receive-pack-result',
          'content-length': response.length,
          'x-github-request-id': forge.nextRequestId(),
        });
        ctx.res.end(response);
        return;
      }
    } catch (error) {
      console.error('git handler error:', error instanceof Error ? error.message : String(error));
      sendError(ctx, 400, 'Bad Request');
      return;
    }
  }
  sendError(ctx, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// the server
// -------------------------------------------------------------------------------------------

export function createApp(forge: Forge): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const rawBody = await readBody(req);
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const segments = url.pathname.split('/').filter((part) => part !== '');
        const ctx: Ctx = { forge, req, res, url, segments, query: url.searchParams, body: undefined, rawBody };
        const path = url.pathname;
        if (req.method === 'GET' && path === '/healthz') {
          sendJson(ctx, 200, { ok: true });
          return;
        }
        if (path === '/api/graphql' && req.method === 'POST') {
          await handleGraphQL(ctx, rawBody);
          return;
        }
        if (path === '/mcp' && req.method === 'POST') {
          await handleMcp(ctx, rawBody);
          return;
        }
        if (path.startsWith('/api/v3')) {
          ctx.segments = segments.slice(2);
          await handleRest(ctx);
          return;
        }
        if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
          await handleGit(ctx);
          return;
        }
        sendError(ctx, 404, 'Not Found');
      } catch {
        try {
          res.writeHead(500, { 'content-type': JSON_TYPE });
          res.end(JSON.stringify({ message: 'Internal Server Error' }));
        } catch {
          // The connection is already gone.
        }
      }
    })();
  });
}
