// store.ts — the forge's in-memory store: repositories, git objects and
// refs, issues, pull requests and labels, all in one place so REST,
// GraphQL, MCP and smart HTTP read the same objects.
//
// The viewer is the trial's token owner. The token the suite presents is an
// opaque derived value that names no login, and the scenario the kit ships
// is fixed: its viewer login is "adaiversen" (wire.ts buildScenario, seed
// 6a09e667f3bcc909). That is the login this forge answers as.
//
// Time is deterministic: every timestamp comes from MAKEFUN_TRIAL_NOW (the
// trial's only "now") plus a monotonic counter, so a live trial and its
// replay produce the same ordering and the same values.

import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  commitGenerations,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
} from './git.ts';
import type { GitObject, TreeEntry } from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  idNum: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  idNum: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  updatedSeq: number;
}

export interface Pull {
  idNum: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
}

export interface Repo {
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  databaseId: number;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  nextCommentId: number;
}

export type GlobalKind = 'repo' | 'issue' | 'pull' | 'comment';

export interface GlobalRef {
  kind: GlobalKind;
  repoKey: string;
  number?: number;
  commentId?: number;
}

function globalId(kind: GlobalKind, key: string): string {
  const prefix = kind === 'repo' ? 'R_' : kind === 'issue' ? 'I_' : kind === 'pull' ? 'PR_' : 'IC_';
  return prefix + createHash('sha1').update(`${kind}:${key}`, 'utf8').digest('hex');
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  readonly globalIds = new Map<string, GlobalRef>();
  private clockSeq = 0;
  private nextDatabaseId = 5000;
  private nextObjectId = 100000;
  private requestSeq = 0;
  readonly baseEpochSec: number;

  constructor() {
    const nowText = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = nowText === '' ? NaN : Date.parse(nowText);
    this.baseEpochSec = Number.isFinite(parsed)
      ? Math.floor(parsed / 1000)
      : Math.floor(Date.parse('2026-11-14T06:30:00Z') / 1000);
  }

  /** The next monotonic sequence number (creation order and timestamps share it). */
  nextSeq(): number {
    this.clockSeq += 1;
    return this.clockSeq;
  }

  /** The next deterministic timestamp, one second after the last. */
  nowIso(): string {
    return new Date((this.baseEpochSec + this.nextSeq()) * 1000).toISOString();
  }

  /** The next deterministic commit epoch, one second after the last. */
  nowEpoch(): number {
    return this.baseEpochSec + this.nextSeq();
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  repoGlobalId(repo: Repo): string {
    return globalId('repo', this.repoKey(repo.owner, repo.name));
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return globalId('issue', `${this.repoKey(repo.owner, repo.name)}:${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return globalId('pull', `${this.repoKey(repo.owner, repo.name)}:${pull.number}`);
  }

  commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
    return globalId('comment', `${this.repoKey(repo.owner, repo.name)}:${issue.number}:${comment.idNum}`);
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const key = this.repoKey(VIEWER_LOGIN, name);
    const repo: Repo = {
      owner: VIEWER_LOGIN,
      name,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      databaseId: this.nextDatabaseId,
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextDatabaseId += 1;
    this.repos.set(key, repo);
    this.globalIds.set(this.repoGlobalId(repo), { kind: 'repo', repoKey: key });
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -----------------------------------------------------------------------------------------
  // git objects and trees
  // -----------------------------------------------------------------------------------------

  /** Build nested trees from a flat path -> blob map; stores every tree object. */
  buildTrees(repo: Repo, files: Map<string, string>): string {
    interface DirNode {
      files: Map<string, string>;
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: new Map(), dirs: new Map() };
    for (const [path, oid] of [...files.entries()].sort()) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i] as string;
        let child = node.dirs.get(part);
        if (!child) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.set(parts[parts.length - 1] as string, oid);
    }
    const build = (node: DirNode): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      const data = buildTree(entries);
      const oid = hashObject('tree', data);
      repo.objects.set(oid, { type: 'tree', data });
      return oid;
    };
    return build(root);
  }

  /** Flatten a tree object into path -> blob oid, recursively. */
  flattenTree(repo: Repo, treeOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, entry.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** The flat file map at a ref (branch name or oid), or an empty map when unborn. */
  filesAtRef(repo: Repo, ref: string): Map<string, string> {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return new Map();
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return new Map();
    return this.flattenTree(repo, parseCommit(object.data).tree);
  }

  /** Resolve a branch name, a full ref or a commit oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const full = `refs/heads/${ref}`;
    if (repo.refs.has(full)) return repo.refs.get(full);
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const object = repo.objects.get(ref);
      if (object && object.type === 'commit') return ref;
    }
    return undefined;
  }

  /** Create a commit on `branch` from a flat file map; updates the ref. */
  commitFiles(
    repo: Repo,
    branch: string,
    files: Map<string, string>,
    message: string,
  ): string {
    const treeOid = this.buildTrees(repo, files);
    const parent = repo.refs.get(`refs/heads/${branch}`);
    const parents = parent === undefined ? [] : [parent];
    const epoch = this.nowEpoch();
    const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
    const data = buildCommit({ tree: treeOid, parents, author: identity, committer: identity, message });
    const oid = hashObject('commit', data);
    repo.objects.set(oid, { type: 'commit', data });
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** The peeled commit of a ref: a tag object resolves to its target commit. */
  peelToCommit(repo: Repo, oid: string): string | undefined {
    let current = oid;
    for (let i = 0; i < 8; i += 1) {
      const object = repo.objects.get(current);
      if (!object) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  // -----------------------------------------------------------------------------------------
  // REST shapes
  // -----------------------------------------------------------------------------------------

  repoObject(repo: Repo): Record<string, unknown> {
    return {
      id: repo.databaseId,
      node_id: this.repoGlobalId(repo),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
      created_at: new Date((this.baseEpochSec + repo.createdSeq) * 1000).toISOString(),
      updated_at: this.nowIso(),
      html_url: `https://github.com/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      fork: false,
      archived: false,
      disabled: false,
      visibility: repo.isPrivate ? 'private' : 'public',
    };
  }

  issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.idNum,
      node_id: this.issueGlobalId(repo, issue),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return { name, color: label?.color ?? 'ededed', description: '' };
      }),
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      comments: issue.comments.length,
      created_at: new Date((this.baseEpochSec + issue.createdSeq) * 1000).toISOString(),
      updated_at: new Date((this.baseEpochSec + issue.updatedSeq) * 1000).toISOString(),
      closed_at: issue.state === 'closed' ? new Date((this.baseEpochSec + issue.updatedSeq) * 1000).toISOString() : null,
      html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
    return {
      id: pull.idNum,
      node_id: this.pullGlobalId(repo, pull),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      mergeable: this.mergeable(repo, pull),
      head: {
        ref: pull.headRef,
        sha: this.resolveRef(repo, pull.headRef) ?? pull.headSha,
        label: `${repo.owner}:${pull.headRef}`,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        repo: this.repoObject(repo),
      },
      base: {
        ref: pull.baseRef,
        sha: this.resolveRef(repo, pull.baseRef) ?? pull.baseSha,
        label: `${repo.owner}:${pull.baseRef}`,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        repo: this.repoObject(repo),
      },
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      created_at: new Date((this.baseEpochSec + pull.createdSeq) * 1000).toISOString(),
      updated_at: this.nowIso(),
      html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    };
  }

  commentObject(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
    return {
      id: comment.idNum,
      node_id: this.commentGlobalId(repo, issue, comment),
      body: comment.body,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      created_at: new Date((this.baseEpochSec + comment.createdSeq) * 1000).toISOString(),
      updated_at: new Date((this.baseEpochSec + comment.createdSeq) * 1000).toISOString(),
      html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.idNum}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.idNum}`,
    };
  }

  // -----------------------------------------------------------------------------------------
  // issues, labels, comments
  // -----------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[] = []): Issue {
    const issue: Issue = {
      idNum: this.nextObjectId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.nextSeq(),
      updatedSeq: this.clockSeq,
    };
    this.nextObjectId += 1;
    repo.nextNumber += 1;
    repo.issues.push(issue);
    this.globalIds.set(this.issueGlobalId(repo, issue), {
      kind: 'issue',
      repoKey: this.repoKey(repo.owner, repo.name),
      number: issue.number,
    });
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { idNum: repo.nextCommentId, body, createdSeq: this.nextSeq() };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    this.globalIds.set(this.commentGlobalId(repo, issue, comment), {
      kind: 'comment',
      repoKey: this.repoKey(repo.owner, repo.name),
      number: issue.number,
      commentId: comment.idNum,
    });
    return comment;
  }

  // -----------------------------------------------------------------------------------------
  // pull requests: diff and merge
  // -----------------------------------------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = this.resolveRef(repo, headRef);
    const baseSha = this.resolveRef(repo, baseRef);
    if (headSha === undefined || baseSha === undefined) return null;
    const pull: Pull = {
      idNum: this.nextObjectId,
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      createdSeq: this.nextSeq(),
    };
    this.nextObjectId += 1;
    repo.nextNumber += 1;
    repo.pulls.push(pull);
    this.globalIds.set(this.pullGlobalId(repo, pull), {
      kind: 'pull',
      repoKey: this.repoKey(repo.owner, repo.name),
      number: pull.number,
    });
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  /** The changed paths between two commits' trees, with line counts. */
  pullFiles(repo: Repo, pull: Pull): Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
  }> {
    const baseFiles = this.filesAtRef(repo, pull.baseSha);
    const headFiles = this.filesAtRef(repo, pull.headSha);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const lineCount = (oid: string | undefined): number => {
      if (oid === undefined) return 0;
      const object = repo.objects.get(oid);
      if (!object) return 0;
      const text = object.data.toString('utf8');
      if (text === '') return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    for (const path of [...paths].sort()) {
      const baseOid = baseFiles.get(path);
      const headOid = headFiles.get(path);
      if (baseOid === headOid) continue;
      if (baseOid === undefined) {
        const additions = lineCount(headOid);
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (headOid === undefined) {
        const deletions = lineCount(baseOid);
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else {
        const additions = lineCount(headOid);
        const deletions = lineCount(baseOid);
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** The merge-base of two commits: the first common ancestor found walking the base side. */
  mergeBase(repo: Repo, headSha: string, baseSha: string): string | undefined {
    const headAncestors = new Set<string>();
    const stack = [headSha];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (headAncestors.has(oid) || oid === ZERO_OID) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      headAncestors.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    const generations = commitGenerations([baseSha], (oid) => repo.objects.get(oid));
    const ordered = [...generations.entries()].sort((a, b) => a[1] - b[1]);
    for (const [oid] of ordered) {
      if (headAncestors.has(oid)) return oid;
    }
    return undefined;
  }

  /** Whether a squash merge of the pull would conflict. */
  mergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    const currentBaseTip = this.resolveRef(repo, pull.baseRef);
    if (currentBaseTip === undefined) return false;
    const base = this.mergeBase(repo, pull.headSha, currentBaseTip);
    if (base === undefined) return true;
    const baseFiles = this.filesAtRef(repo, base);
    const headFiles = this.filesAtRef(repo, pull.headSha);
    const currentFiles = this.filesAtRef(repo, currentBaseTip);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
    for (const path of paths) {
      const fromBase = baseFiles.get(path);
      const head = headFiles.get(path);
      const current = currentFiles.get(path);
      const headChanged = head !== fromBase;
      const currentChanged = current !== fromBase;
      if (headChanged && currentChanged && head !== current) return false;
    }
    return true;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge
   * commit sha, or null when the pull is unknown, already closed, or
   * conflicted.
   */
  mergePull(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open') return null;
    if (!this.mergeable(repo, pull)) return null;
    const headFiles = this.filesAtRef(repo, pull.headSha);
    const treeOid = this.buildTrees(repo, headFiles);
    const epoch = this.nowEpoch();
    const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const baseTip = this.resolveRef(repo, pull.baseRef) ?? pull.baseSha;
    const data = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      author: identity,
      committer: identity,
      message,
    });
    const oid = hashObject('commit', data);
    repo.objects.set(oid, { type: 'commit', data });
    repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date(epoch * 1000).toISOString();
    pull.mergeCommitSha = oid;
    pull.baseSha = oid;
    return oid;
  }

  /** Commits reachable from a ref, newest first (generation order). */
  commitsFrom(repo: Repo, ref: string): Array<{ sha: string; message: string; epoch: number }> {
    const tip = this.resolveRef(repo, ref);
    if (tip === undefined) return [];
    const generations = commitGenerations([tip], (oid) => repo.objects.get(oid));
    const ordered = [...generations.entries()].sort((a, b) => a[1] - b[1]);
    const out: Array<{ sha: string; message: string; epoch: number }> = [];
    for (const [oid] of ordered) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      const authorLine = commit.author;
      const epochMatch = / (\d+) [+-]\d{4}$/.exec(authorLine);
      out.push({ sha: oid, message: commit.message.replace(/\n$/, ''), epoch: epochMatch ? Number(epochMatch[1]) : 0 });
    }
    return out;
  }

  /** Every object reachable from a ref tip (used by the git fetch planner). */
  reachableFrom(repo: Repo, tips: string[]): Set<string> {
    return collectReachable(tips, (oid) => repo.objects.get(oid));
  }
}
