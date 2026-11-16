// graphql.ts — a small GraphQL executor for the v4 endpoint.
//
// The suite uses a fixed set of documents (viewer login, repository
// fields, issue and pull-request connections, node round-trips, the four
// mutations, __type probes and batched arrays), so this is a focused
// parser and executor, not a full GraphQL implementation. Unknown fields
// are reported in `errors` with the field name in the message while the
// rest of the document still resolves, and an unknown repository
// resolves to `data.repository = null` with no error.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit } from './git.ts';
import { Forge, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';

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

// -------------------------------------------------------------------------------------------
// lexer
// -------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const next = source[j + 1] as string;
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: text.includes('.') || text.includes('e') || text.includes('E') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

type SelectionNode =
  | { kind: 'field'; name: string; alias: string | null; args: Record<string, ValueNode>; selections: SelectionNode[] }
  | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: Array<{ name: string; type: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expect(value: string): Token {
    const token = this.next();
    if (token.value !== value) throw new Error(`Expected ${value} but got ${token.value}`);
    return token;
  }

  private match(value: string): boolean {
    if (this.peek().value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().value === '{') {
        operations.push({ kind: 'query', name: null, variables: [], selections: this.parseSelections() });
        continue;
      }
      const keyword = this.next().value;
      if (keyword === 'fragment') {
        const name = this.next().value;
        this.expect('on');
        this.next(); // the type condition
        fragments.set(name, this.parseSelections());
        continue;
      }
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variables: OperationNode['variables'] = [];
        if (this.match('(')) {
          while (!this.match(')')) {
            this.expect('$');
            const varName = this.next().value;
            this.expect(':');
            const type = this.parseType();
            let defaultValue: ValueNode | null = null;
            if (this.match('=')) defaultValue = this.parseValue();
            variables.push({ name: varName, type, defaultValue });
          }
        }
        // Directives on the operation (@cached etc.) are ignored.
        while (this.peek().value === '@') {
          this.next();
          this.next();
          if (this.peek().value === '(') this.parseValue();
        }
        operations.push({ kind: keyword, name, variables, selections: this.parseSelections() });
        continue;
      }
      throw new Error(`Unexpected token ${keyword} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseType(): string {
    let type = '';
    if (this.match('[')) {
      type = `[${this.parseType()}]`;
    } else {
      type = this.next().value;
    }
    if (this.match('!')) type += '!';
    return type;
  }

  private parseSelections(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.match('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelections() });
        } else {
          selections.push({ kind: 'spread', name: this.next().value });
        }
        continue;
      }
      const first = this.next();
      let alias: string | null = null;
      let name = first.value;
      if (this.match(':')) {
        alias = name;
        name = this.next().value;
      }
      const args: Record<string, ValueNode> = {};
      if (this.match('(')) {
        while (!this.match(')')) {
          const argName = this.next().value;
          this.expect(':');
          args[argName] = this.parseValue();
        }
      }
      while (this.peek().value === '@') {
        this.next();
        this.next();
        if (this.peek().value === '(') this.parseValue();
      }
      const sub = this.peek().value === '{' ? this.parseSelections() : [];
      selections.push({ kind: 'field', name, alias, args, selections: sub });
    }
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.value === '$') return { kind: 'variable', name: this.next().value };
    if (token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.match(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.match('}')) {
        const name = this.next().value;
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.value === 'true') return { kind: 'boolean', value: true };
    if (token.value === 'false') return { kind: 'boolean', value: false };
    if (token.value === 'null') return { kind: 'null' };
    return { kind: 'enum', value: token.value };
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'variable':
      return variables[node.name];
    case 'list':
      return node.values.map((child) => valueOf(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// type tables for __type
// -------------------------------------------------------------------------------------------

interface TypeFieldDef {
  name: string;
  type: string;
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM';
  fields: TypeFieldDef[];
  enumValues: string[];
}

const TYPE_DEFS: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: [
      { name: 'viewer', type: 'User' },
      { name: 'repository', type: 'Repository' },
      { name: 'node', type: 'Node' },
    ],
    enumValues: [],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: [
      { name: 'createIssue', type: 'CreateIssuePayload' },
      { name: 'closeIssue', type: 'CloseIssuePayload' },
      { name: 'createPullRequest', type: 'CreatePullRequestPayload' },
      { name: 'mergePullRequest', type: 'MergePullRequestPayload' },
      { name: 'addComment', type: 'AddCommentPayload' },
    ],
    enumValues: [],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'login', type: 'String' },
      { name: 'name', type: 'String' },
      { name: 'email', type: 'String' },
    ],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'databaseId', type: 'Int' },
      { name: 'name', type: 'String' },
      { name: 'nameWithOwner', type: 'String' },
      { name: 'owner', type: 'User' },
      { name: 'defaultBranchRef', type: 'Ref' },
      { name: 'viewerPermission', type: 'String' },
      { name: 'hasIssuesEnabled', type: 'Boolean' },
      { name: 'description', type: 'String' },
      { name: 'isPrivate', type: 'Boolean' },
      { name: 'url', type: 'String' },
      { name: 'createdAt', type: 'String' },
      { name: 'updatedAt', type: 'String' },
      { name: 'issue', type: 'Issue' },
      { name: 'issues', type: 'IssueConnection' },
      { name: 'pullRequest', type: 'PullRequest' },
      { name: 'pullRequests', type: 'PullRequestConnection' },
    ],
    enumValues: [],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'state', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'createdAt', type: 'String' },
      { name: 'updatedAt', type: 'String' },
      { name: 'author', type: 'User' },
      { name: 'url', type: 'String' },
      { name: 'labels', type: 'LabelConnection' },
      { name: 'comments', type: 'IssueCommentConnection' },
      { name: 'repository', type: 'Repository' },
    ],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'number', type: 'Int' },
      { name: 'title', type: 'String' },
      { name: 'body', type: 'String' },
      { name: 'state', type: 'String' },
      { name: 'merged', type: 'Boolean' },
      { name: 'headRefName', type: 'String' },
      { name: 'baseRefName', type: 'String' },
      { name: 'headRefOid', type: 'String' },
      { name: 'baseRefOid', type: 'String' },
      { name: 'mergeable', type: 'String' },
      { name: 'files', type: 'PullRequestFileConnection' },
      { name: 'createdAt', type: 'String' },
      { name: 'updatedAt', type: 'String' },
      { name: 'author', type: 'User' },
      { name: 'url', type: 'String' },
      { name: 'repository', type: 'Repository' },
    ],
    enumValues: [],
  },
  Ref: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'name', type: 'String' },
      { name: 'target', type: 'Commit' },
    ],
    enumValues: [],
  },
  Commit: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'oid', type: 'String' },
      { name: 'message', type: 'String' },
    ],
    enumValues: [],
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: [
      { name: 'id', type: 'ID' },
      { name: 'body', type: 'String' },
      { name: 'author', type: 'User' },
      { name: 'createdAt', type: 'String' },
    ],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'Issue' },
      { name: 'edges', type: 'IssueEdge' },
      { name: 'totalCount', type: 'Int' },
      { name: 'pageInfo', type: 'PageInfo' },
    ],
    enumValues: [],
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'PullRequest' },
      { name: 'edges', type: 'PullRequestEdge' },
      { name: 'totalCount', type: 'Int' },
      { name: 'pageInfo', type: 'PageInfo' },
    ],
    enumValues: [],
  },
  LabelConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'Label' },
      { name: 'totalCount', type: 'Int' },
    ],
    enumValues: [],
  },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'IssueComment' },
      { name: 'edges', type: 'IssueCommentEdge' },
      { name: 'totalCount', type: 'Int' },
      { name: 'pageInfo', type: 'PageInfo' },
    ],
    enumValues: [],
  },
  PullRequestFileConnection: {
    kind: 'OBJECT',
    fields: [
      { name: 'nodes', type: 'PullRequestFile' },
      { name: 'totalCount', type: 'Int' },
      { name: 'pageInfo', type: 'PageInfo' },
    ],
    enumValues: [],
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: [
      { name: 'hasNextPage', type: 'Boolean' },
      { name: 'hasPreviousPage', type: 'Boolean' },
      { name: 'startCursor', type: 'String' },
      { name: 'endCursor', type: 'String' },
    ],
    enumValues: [],
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'cursor', type: 'String' },
      { name: 'node', type: 'Issue' },
    ],
    enumValues: [],
  },
  PullRequestEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'cursor', type: 'String' },
      { name: 'node', type: 'PullRequest' },
    ],
    enumValues: [],
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: [
      { name: 'cursor', type: 'String' },
      { name: 'node', type: 'IssueComment' },
    ],
    enumValues: [],
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'issue', type: 'Issue' },
      { name: 'clientMutationId', type: 'String' },
    ],
    enumValues: [],
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'issue', type: 'Issue' },
      { name: 'clientMutationId', type: 'String' },
    ],
    enumValues: [],
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'pullRequest', type: 'PullRequest' },
      { name: 'clientMutationId', type: 'String' },
    ],
    enumValues: [],
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'pullRequest', type: 'PullRequest' },
      { name: 'clientMutationId', type: 'String' },
    ],
    enumValues: [],
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: [
      { name: 'commentEdge', type: 'IssueCommentEdge' },
      { name: 'subject', type: 'Issue' },
      { name: 'clientMutationId', type: 'String' },
    ],
    enumValues: [],
  },
  IssueState: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['OPEN', 'CLOSED'],
  },
  Label: {
    kind: 'OBJECT',
    fields: [{ name: 'name', type: 'String' }],
    enumValues: [],
  },
  PullRequestFile: {
    kind: 'OBJECT',
    fields: [
      { name: 'path', type: 'String' },
      { name: 'additions', type: 'Int' },
      { name: 'deletions', type: 'Int' },
      { name: 'changes', type: 'Int' },
      { name: 'changeType', type: 'String' },
      { name: 'status', type: 'String' },
    ],
    enumValues: [],
  },
  PullRequestState: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['OPEN', 'CLOSED', 'MERGED'],
  },
  MergeStateStatus: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  },
};

// -------------------------------------------------------------------------------------------
// object wrappers
// -------------------------------------------------------------------------------------------

type GqlObject =
  | { __typename: 'Label'; name: string }
  | { __typename: 'PullRequestFile'; path: string; additions: number; deletions: number; changes: number; changeType: string }
  | { __typename: 'User'; login: string; id: number; name: string; email: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'Ref'; repo: Repo; name: string; oid: string }
  | { __typename: 'Commit'; repo: Repo; oid: string; message: string }
  | { __typename: 'IssueComment'; repo: Repo; issue: Issue; commentId: number; body: string; createdSeq: number }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[] }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __typename: 'LabelConnection'; repo: Repo; issue: Issue }
  | { __typename: 'IssueCommentConnection'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequestFileConnection'; repo: Repo; pull: Pull }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue | null }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue | null }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull | null }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull | null }
  | { __typename: 'AddCommentPayload'; repo: Repo; issue: Issue | null; commentId: number | null; body: string | null };

function viewerObject(): GqlObject {
  return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
}

function isoOf(forge: Forge, seq: number): string {
  return new Date((forge.baseEpochSec + seq) * 1000).toISOString();
}

function cursorFor(kind: string, n: number): string {
  return Buffer.from(`${kind}:${n}`).toString('base64');
}

function cursorNumber(cursor: unknown, kind: string): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    if (!decoded.startsWith(`${kind}:`)) return null;
    const n = Number(decoded.slice(kind.length + 1));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------

class Executor {
  private errors: Array<{ message: string; path?: Array<string | number> }> = [];
  private forge: Forge;
  private document: DocumentNode;

  constructor(forge: Forge, document: DocumentNode) {
    this.forge = forge;
    this.document = document;
  }

  execute(operation: OperationNode, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
    this.errors = [];
    const resolvedVars: Record<string, unknown> = {};
    for (const def of operation.variables) {
      if (variables[def.name] !== undefined) resolvedVars[def.name] = variables[def.name];
      else if (def.defaultValue !== null) resolvedVars[def.name] = valueOf(def.defaultValue, variables);
    }
    const data: Record<string, unknown> = {};
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    for (const selection of operation.selections) {
      const key = selection.kind === 'field' ? (selection.alias ?? selection.name) : '';
      const value = this.resolveRoot(selection, resolvedVars, rootType);
      if (selection.kind === 'field') data[key] = value;
    }
    const result: { data: Record<string, unknown>; errors?: Array<{ message: string }> } = { data };
    if (this.errors.length > 0) result.errors = this.errors;
    return result;
  }

  private resolveRoot(selection: SelectionNode, variables: Record<string, unknown>, rootType: string): unknown {
    if (selection.kind !== 'field') return null;
    const args: Record<string, unknown> = {};
    for (const [name, node] of Object.entries(selection.args)) args[name] = valueOf(node, variables);
    return this.resolveField(null, rootType, selection.name, args, selection.selections, variables, [selection.alias ?? selection.name]);
  }

  /** Resolve one field on an object (null object means the Query/Mutation root). */
  private resolveField(
    object: GqlObject | null,
    typeName: string,
    field: string,
    args: Record<string, unknown>,
    selections: SelectionNode[],
    variables: Record<string, unknown>,
    path: Array<string | number>,
  ): unknown {
    // Introspection fields.
    if (field === '__typename') return typeName;
    if (field === '__type' && object === null) {
      const name = args.name as string | undefined;
      if (typeof name !== 'string') return null;
      const def = TYPE_DEFS[name];
      if (def === undefined) return null;
      return {
        name,
        kind: def.kind,
        description: null,
        fields: def.fields.map((f) => ({
          name: f.name,
          description: null,
          args: [],
          type: { name: f.type, kind: 'SCALAR', ofType: null },
        })),
        enumValues: def.enumValues.map((value) => ({ name: value, description: null })),
        inputFields: null,
        interfaces: [],
      };
    }
    if (field === '__schema' && object === null) {
      return {
        queryType: { name: 'Query' },
        mutationType: { name: 'Mutation' },
        subscriptionType: null,
        types: Object.keys(TYPE_DEFS).map((name) => ({ name, kind: TYPE_DEFS[name]?.kind ?? 'OBJECT' })),
        directives: [],
      };
    }
    const def = TYPE_DEFS[typeName];
    if (def === undefined || !def.fields.some((f) => f.name === field)) {
      this.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".`, path });
      return null;
    }
    const value = this.fieldValue(object, typeName, field, args, variables);
    if (value === undefined) {
      this.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".`, path });
      return null;
    }
    if (selections.length === 0) return value;
    if (value === null) return null;
    if (Array.isArray(value)) {
      return value.map((item, index) => this.selectOn(item, selections, variables, [...path, index]));
    }
    return this.selectOn(value, selections, variables, path);
  }

  /** Apply a selection set to a resolved object value. */
  private selectOn(value: unknown, selections: SelectionNode[], variables: Record<string, unknown>, path: Array<string | number>): unknown {
    if (value === null || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    // Plain objects (pageInfo, edges, __type results) resolve by property.
    if (!('__typename' in object)) {
      const out: Record<string, unknown> = {};
      for (const selection of selections) {
        if (selection.kind !== 'field') continue;
        const key = selection.alias ?? selection.name;
        const raw = object[selection.name];
        if (raw === undefined) {
          out[key] = null;
          continue;
        }
        if (selection.selections.length === 0) {
          out[key] = raw;
          continue;
        }
        if (Array.isArray(raw)) {
          out[key] = raw.map((item, index) => this.selectOn(item, selection.selections, variables, [...path, key, index]));
        } else {
          out[key] = this.selectOn(raw, selection.selections, variables, [...path, key]);
        }
      }
      return out;
    }
    const typed = value as GqlObject;
    const typeName = typed.__typename;
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'inline') {
        if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
        const sub = this.selectOn(value, selection.selections, variables, path);
        if (sub !== null && typeof sub === 'object') Object.assign(out, sub);
        continue;
      }
      if (selection.kind === 'spread') {
        const fragment = this.document.fragments.get(selection.name);
        if (fragment) {
          const sub = this.selectOn(value, fragment, variables, path);
          if (sub !== null && typeof sub === 'object') Object.assign(out, sub);
        }
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const [name, node] of Object.entries(selection.args)) args[name] = valueOf(node, variables);
      const key = selection.alias ?? selection.name;
      out[key] = this.resolveField(typed, typeName, selection.name, args, selection.selections, variables, [...path, key]);
    }
    return out;
  }

  /** The raw value of a field, before any sub-selection is applied. */
  private fieldValue(
    object: GqlObject | null,
    typeName: string,
    field: string,
    args: Record<string, unknown>,
    _variables: Record<string, unknown>,
  ): unknown {
    const forge = this.forge;
    if (object === null) {
      // Query / Mutation root.
      if (typeName === 'Query') {
        if (field === 'viewer') return viewerObject();
        if (field === 'repository') {
          const owner = args.owner as string | undefined;
          const name = args.name as string | undefined;
          if (typeof owner !== 'string' || typeof name !== 'string') return null;
          const repo = owner === VIEWER_LOGIN ? forge.getRepo(owner, name) : undefined;
          return repo === undefined ? null : ({ __typename: 'Repository', repo } as GqlObject);
        }
        if (field === 'node') {
          const id = args.id as string | undefined;
          if (typeof id !== 'string') return null;
          const entry = forge.globalIds.get(id);
          if (entry === undefined) return null;
          const [owner, repoName] = entry.repoKey.split('/');
          const repo = owner === VIEWER_LOGIN ? forge.getRepo(owner, repoName ?? '') : undefined;
          if (repo === undefined) return null;
          if (entry.kind === 'repo') return { __typename: 'Repository', repo } as GqlObject;
          const number = entry.number ?? 0;
          if (entry.kind === 'issue') {
            const issue = forge.getIssue(repo, number);
            return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } as GqlObject);
          }
          if (entry.kind === 'pull') {
            const pull = forge.getPull(repo, number);
            return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } as GqlObject);
          }
          return null;
        }
        return undefined;
      }
      // Mutation root.
      if (typeName === 'Mutation') {
        if (field === 'createIssue') {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = this.repoFromGlobalId(input.repositoryId as string | undefined);
          if (repo === null) return { __typename: 'CreateIssuePayload', repo: null as unknown as Repo, issue: null } as GqlObject;
          const title = input.title as string | undefined;
          if (typeof title !== 'string') return { __typename: 'CreateIssuePayload', repo, issue: null } as GqlObject;
          const issue = forge.createIssue(repo, title, (input.body as string | undefined) ?? '');
          return { __typename: 'CreateIssuePayload', repo, issue } as GqlObject;
        }
        if (field === 'closeIssue') {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = this.issueFromGlobalId(input.issueId as string | undefined);
          if (found === null) return { __typename: 'CloseIssuePayload', repo: null as unknown as Repo, issue: null } as GqlObject;
          found.issue.state = 'closed';
          found.issue.updatedSeq = forge.nextSeq();
          return { __typename: 'CloseIssuePayload', repo: found.repo, issue: found.issue } as GqlObject;
        }
        if (field === 'createPullRequest') {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = this.repoFromGlobalId(input.repositoryId as string | undefined);
          if (repo === null) return { __typename: 'CreatePullRequestPayload', repo: null as unknown as Repo, pull: null } as GqlObject;
          const head = input.headRefName as string | undefined;
          const base = input.baseRefName as string | undefined;
          const title = input.title as string | undefined;
          if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') {
            return { __typename: 'CreatePullRequestPayload', repo, pull: null } as GqlObject;
          }
          const pull = forge.createPull(repo, title, (input.body as string | undefined) ?? '', head, base);
          return { __typename: 'CreatePullRequestPayload', repo, pull } as GqlObject;
        }
        if (field === 'mergePullRequest') {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = this.pullFromGlobalId(input.pullRequestId as string | undefined);
          if (found === null) return { __typename: 'MergePullRequestPayload', repo: null as unknown as Repo, pull: null } as GqlObject;
          const method = (input.mergeMethod as string | undefined) ?? 'SQUASH';
          if (method !== 'SQUASH' && method !== 'MERGE' && method !== 'REBASE') {
            return { __typename: 'MergePullRequestPayload', repo: found.repo, pull: found.pull } as GqlObject;
          }
          if (found.pull.state === 'open' && forge.mergeable(found.repo, found.pull)) {
            forge.mergePull(found.repo, found.pull);
          }
          return { __typename: 'MergePullRequestPayload', repo: found.repo, pull: found.pull } as GqlObject;
        }
        if (field === 'addComment') {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const subjectId = input.subjectId as string | undefined;
          const body = input.body as string | undefined;
          if (typeof subjectId !== 'string' || typeof body !== 'string') {
            return { __typename: 'AddCommentPayload', repo: null as unknown as Repo, issue: null, commentId: null, body: null } as GqlObject;
          }
          const found = this.issueFromGlobalId(subjectId);
          if (found === null) {
            return { __typename: 'AddCommentPayload', repo: null as unknown as Repo, issue: null, commentId: null, body: null } as GqlObject;
          }
          const comment = forge.createComment(found.repo, found.issue, body);
          return {
            __typename: 'AddCommentPayload',
            repo: found.repo,
            issue: found.issue,
            commentId: comment.idNum,
            body,
          } as GqlObject;
        }
        return undefined;
      }
      return undefined;
    }
    switch (object.__typename) {
      case 'User':
        if (field === 'id') return object.id;
        if (field === 'login') return object.login;
        if (field === 'name') return object.name;
        if (field === 'email') return object.email;
        return undefined;
      case 'Repository': {
        const repo = object.repo;
        if (field === 'id') return forge.repoGlobalId(repo);
        if (field === 'databaseId') return repo.databaseId;
        if (field === 'name') return repo.name;
        if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
        if (field === 'owner') return viewerObject();
        if (field === 'defaultBranchRef') {
          const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (sha === undefined) return null;
          return { __typename: 'Ref', repo, name: repo.defaultBranch, oid: sha } as GqlObject;
        }
        if (field === 'viewerPermission') return 'ADMIN';
        if (field === 'hasIssuesEnabled') return true;
        if (field === 'description') return repo.description;
        if (field === 'isPrivate') return repo.isPrivate;
        if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
        if (field === 'createdAt') return isoOf(forge, repo.createdSeq);
        if (field === 'updatedAt') return isoOf(forge, repo.createdSeq);
        if (field === 'issue') {
          const number = args.number as number | undefined;
          if (typeof number !== 'number') return null;
          const issue = forge.getIssue(repo, number);
          return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } as GqlObject);
        }
        if (field === 'issues') return this.issueConnection(repo, args);
        if (field === 'pullRequest') {
          const number = args.number as number | undefined;
          if (typeof number !== 'number') return null;
          const pull = forge.getPull(repo, number);
          return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } as GqlObject);
        }
        if (field === 'pullRequests') return this.pullConnection(repo, args);
        return undefined;
      }
      case 'Issue': {
        const issue = object.issue;
        if (field === 'id') return forge.issueGlobalId(object.repo, issue);
        if (field === 'number') return issue.number;
        if (field === 'title') return issue.title;
        if (field === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        if (field === 'body') return issue.body;
        if (field === 'createdAt') return isoOf(forge, issue.createdSeq);
        if (field === 'updatedAt') return isoOf(forge, issue.updatedSeq);
        if (field === 'author') return viewerObject();
        if (field === 'url') return `https://github.com/${object.repo.owner}/${object.repo.name}/issues/${issue.number}`;
        if (field === 'labels') return { __typename: 'LabelConnection', repo: object.repo, issue } as GqlObject;
        if (field === 'comments') return { __typename: 'IssueCommentConnection', repo: object.repo, issue } as GqlObject;
        if (field === 'repository') return { __typename: 'Repository', repo: object.repo } as GqlObject;
        return undefined;
      }
      case 'PullRequest': {
        const pull = object.pull;
        if (field === 'id') return forge.pullGlobalId(object.repo, pull);
        if (field === 'number') return pull.number;
        if (field === 'title') return pull.title;
        if (field === 'body') return pull.body;
        if (field === 'state') return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
        if (field === 'merged') return pull.merged;
        if (field === 'headRefName') return pull.headRef;
        if (field === 'baseRefName') return pull.baseRef;
        if (field === 'headRefOid') return forge.resolveRef(object.repo, pull.headRef) ?? null;
        if (field === 'baseRefOid') return forge.resolveRef(object.repo, pull.baseRef) ?? null;
        if (field === 'mergeable') return forge.mergeable(object.repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        if (field === 'files') return { __typename: 'PullRequestFileConnection', repo: object.repo, pull } as GqlObject;
        if (field === 'createdAt') return isoOf(forge, pull.createdSeq);
        if (field === 'updatedAt') return isoOf(forge, pull.updatedSeq);
        if (field === 'author') return viewerObject();
        if (field === 'url') return `https://github.com/${object.repo.owner}/${object.repo.name}/pull/${pull.number}`;
        if (field === 'repository') return { __typename: 'Repository', repo: object.repo } as GqlObject;
        return undefined;
      }
      case 'Ref': {
        if (field === 'id') return forge.repoGlobalId(object.repo);
        if (field === 'name') return object.name;
        if (field === 'target') {
          const commit = object.repo.objects.get(object.oid);
          const message = commit && commit.type === 'commit' ? parseCommit(commit.data).message.replace(/\n$/, '') : '';
          return { __typename: 'Commit', repo: object.repo, oid: object.oid, message } as GqlObject;
        }
        return undefined;
      }
      case 'Commit':
        if (field === 'id') return `C_${object.oid}`;
        if (field === 'oid') return object.oid;
        if (field === 'message') return object.message;
        return undefined;
      case 'IssueComment': {
        if (field === 'id') return forge.commentGlobalId(object.repo, object.issue, { idNum: object.commentId, body: object.body, createdSeq: object.createdSeq });
        if (field === 'body') return object.body;
        if (field === 'author') return viewerObject();
        if (field === 'createdAt') return isoOf(forge, object.createdSeq);
        return undefined;
      }
      case 'IssueConnection': {
        if (field === 'nodes') return object.issues.map((issue) => ({ __typename: 'Issue', repo: object.repo, issue }) as GqlObject);
        if (field === 'edges') {
          return object.issues.map((issue) => ({
            cursor: cursorFor('issue', issue.number),
            node: { __typename: 'Issue', repo: object.repo, issue } as GqlObject,
          }));
        }
        if (field === 'totalCount') return object.issues.length;
        if (field === 'pageInfo') {
          return (object as unknown as { __pageInfo?: Record<string, unknown> }).__pageInfo ?? {
            hasNextPage: false,
            hasPreviousPage: false,
            startCursor: null,
            endCursor: null,
          };
        }
        return undefined;
      }
      case 'PullRequestConnection': {
        if (field === 'nodes') return object.pulls.map((pull) => ({ __typename: 'PullRequest', repo: object.repo, pull }) as GqlObject);
        if (field === 'edges') {
          return object.pulls.map((pull) => ({
            cursor: cursorFor('pull', pull.number),
            node: { __typename: 'PullRequest', repo: object.repo, pull } as GqlObject,
          }));
        }
        if (field === 'totalCount') return object.pulls.length;
        if (field === 'pageInfo') {
          return (object as unknown as { __pageInfo?: Record<string, unknown> }).__pageInfo ?? {
            hasNextPage: false,
            hasPreviousPage: false,
            startCursor: null,
            endCursor: null,
          };
        }
        return undefined;
      }
      case 'Label': {
        if (field === 'name') return (object as { name: string }).name;
        return undefined;
      }
      case 'PullRequestFile': {
        const file = object as { path: string; additions: number; deletions: number; changes: number; changeType: string };
        if (field === 'path') return file.path;
        if (field === 'additions') return file.additions;
        if (field === 'deletions') return file.deletions;
        if (field === 'changes') return file.changes;
        if (field === 'changeType') return file.changeType;
        if (field === 'status') return file.changeType;
        return undefined;
      }
      case 'LabelConnection': {
        if (field === 'nodes') {
          return object.issue.labels.map((name) => ({ __typename: 'Label', name }) as GqlObject);
        }
        if (field === 'totalCount') return object.issue.labels.length;
        return undefined;
      }
      case 'IssueCommentConnection': {
        const comments = object.issue.comments.map((comment) => ({
          __typename: 'IssueComment',
          repo: object.repo,
          issue: object.issue,
          commentId: comment.idNum,
          body: comment.body,
          createdSeq: comment.createdSeq,
        }) as GqlObject);
        if (field === 'nodes') return comments;
        if (field === 'edges') {
          return comments.map((comment) => ({
            cursor: cursorFor('comment', (comment as { commentId: number }).commentId),
            node: comment,
          }));
        }
        if (field === 'totalCount') return comments.length;
        if (field === 'pageInfo') {
          return {
            hasNextPage: false,
            hasPreviousPage: false,
            startCursor: comments.length > 0 ? cursorFor('comment', (comments[0] as { commentId: number }).commentId) : null,
            endCursor: comments.length > 0 ? cursorFor('comment', (comments[comments.length - 1] as { commentId: number }).commentId) : null,
          };
        }
        return undefined;
      }
      case 'PullRequestFileConnection': {
        const files = this.forge.pullFiles(object.repo, object.pull);
        if (field === 'nodes') {
          return files.map((file) => ({
            __typename: 'PullRequestFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            changeType: file.status.toUpperCase(),
          }) as GqlObject);
        }
        if (field === 'totalCount') return files.length;
        if (field === 'pageInfo') {
          return { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
        }
        return undefined;
      }
      case 'CreateIssuePayload': {
        if (field === 'issue') return object.issue === null ? null : ({ __typename: 'Issue', repo: object.repo, issue: object.issue } as GqlObject);
        if (field === 'clientMutationId') return null;
        return undefined;
      }
      case 'CloseIssuePayload': {
        if (field === 'issue') return object.issue === null ? null : ({ __typename: 'Issue', repo: object.repo, issue: object.issue } as GqlObject);
        if (field === 'clientMutationId') return null;
        return undefined;
      }
      case 'CreatePullRequestPayload': {
        if (field === 'pullRequest') return object.pull === null ? null : ({ __typename: 'PullRequest', repo: object.repo, pull: object.pull } as GqlObject);
        if (field === 'clientMutationId') return null;
        return undefined;
      }
      case 'MergePullRequestPayload': {
        if (field === 'pullRequest') return object.pull === null ? null : ({ __typename: 'PullRequest', repo: object.repo, pull: object.pull } as GqlObject);
        if (field === 'clientMutationId') return null;
        return undefined;
      }
      case 'AddCommentPayload': {
        if (field === 'commentEdge') {
          if (object.commentId === null || object.issue === null) return null;
          const comment = object.issue.comments.find((c) => c.idNum === object.commentId);
          if (comment === undefined) return null;
          return {
            cursor: cursorFor('comment', comment.idNum),
            node: {
              __typename: 'IssueComment',
              repo: object.repo,
              issue: object.issue,
              commentId: comment.idNum,
              body: comment.body,
              createdSeq: comment.createdSeq,
            } as GqlObject,
          };
        }
        if (field === 'subject') return object.issue === null ? null : ({ __typename: 'Issue', repo: object.repo, issue: object.issue } as GqlObject);
        if (field === 'clientMutationId') return null;
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private issueConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
    let issues = [...repo.issues];
    const states = args.states as string[] | undefined;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((s) => s.toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const direction = (orderBy.direction as string | undefined) ?? 'DESC';
    issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
    const after = cursorNumber(args.after, 'issue');
    if (after !== null) {
      issues = issues.filter((issue) => (direction === 'ASC' ? issue.number > after : issue.number < after));
    }
    const first = args.first as number | undefined;
    const hasNextPage = typeof first === 'number' && issues.length > first;
    const window = typeof first === 'number' ? issues.slice(0, first) : issues;
    const connection = { __typename: 'IssueConnection', repo, issues: window } as GqlObject;
    // Attach pagination facts through a wrapper the field resolver reads.
    (connection as unknown as { __pageInfo: Record<string, unknown> }).__pageInfo = {
      hasNextPage,
      hasPreviousPage: after !== null,
      startCursor: window.length > 0 ? cursorFor('issue', window[0]?.number ?? 0) : null,
      endCursor: window.length > 0 ? cursorFor('issue', window[window.length - 1]?.number ?? 0) : null,
    };
    return connection;
  }

  private pullConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
    let pulls = [...repo.pulls];
    const states = args.states as string[] | undefined;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states);
      pulls = pulls.filter((pull) => {
        if (pull.state === 'open') return wanted.has('OPEN');
        if (pull.merged) return wanted.has('MERGED');
        return wanted.has('CLOSED');
      });
    }
    pulls.sort((a, b) => b.number - a.number);
    const after = cursorNumber(args.after, 'pull');
    if (after !== null) pulls = pulls.filter((pull) => pull.number < after);
    const first = args.first as number | undefined;
    const hasNextPage = typeof first === 'number' && pulls.length > first;
    const window = typeof first === 'number' ? pulls.slice(0, first) : pulls;
    const connection = { __typename: 'PullRequestConnection', repo, pulls: window } as GqlObject;
    (connection as unknown as { __pageInfo: Record<string, unknown> }).__pageInfo = {
      hasNextPage,
      hasPreviousPage: after !== null,
      startCursor: window.length > 0 ? cursorFor('pull', window[0]?.number ?? 0) : null,
      endCursor: window.length > 0 ? cursorFor('pull', window[window.length - 1]?.number ?? 0) : null,
    };
    return connection;
  }

  private repoFromGlobalId(id: string | undefined): Repo | null {
    if (typeof id !== 'string') return null;
    const entry = this.forge.globalIds.get(id);
    if (entry === undefined || entry.kind !== 'repo') return null;
    const [owner, name] = entry.repoKey.split('/');
    if (owner !== VIEWER_LOGIN) return null;
    return this.forge.getRepo(owner, name ?? '') ?? null;
  }

  private issueFromGlobalId(id: string | undefined): { repo: Repo; issue: Issue } | null {
    if (typeof id !== 'string') return null;
    const entry = this.forge.globalIds.get(id);
    if (entry === undefined || entry.kind !== 'issue') return null;
    const [owner, name] = entry.repoKey.split('/');
    if (owner !== VIEWER_LOGIN) return null;
    const repo = this.forge.getRepo(owner, name ?? '');
    if (repo === undefined) return null;
    const issue = this.forge.getIssue(repo, entry.number ?? 0);
    return issue === undefined ? null : { repo, issue };
  }

  private pullFromGlobalId(id: string | undefined): { repo: Repo; pull: Pull } | null {
    if (typeof id !== 'string') return null;
    const entry = this.forge.globalIds.get(id);
    if (entry === undefined || entry.kind !== 'pull') return null;
    const [owner, name] = entry.repoKey.split('/');
    if (owner !== VIEWER_LOGIN) return null;
    const repo = this.forge.getRepo(owner, name ?? '');
    if (repo === undefined) return null;
    const pull = this.forge.getPull(repo, entry.number ?? 0);
    return pull === undefined ? null : { repo, pull };
  }
}

// -------------------------------------------------------------------------------------------
// HTTP entry point
// -------------------------------------------------------------------------------------------

function sendJson(ctx: Ctx, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.forge.nextRequestId(),
  });
  ctx.res.end(text);
}

function executeDocument(forge: Forge, body: unknown): unknown {
  const payload = body as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (payload === null || typeof payload !== 'object') {
    return { errors: [{ message: 'Request body must be a JSON object with a query string.' }] };
  }
  const query = payload.query;
  if (typeof query !== 'string') {
    return { errors: [{ message: 'Request body must include a query string.' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'Failed to parse GraphQL document' }] };
  }
  const variables = (payload.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof payload.operationName === 'string' ? payload.operationName : null;
  let operation = document.operations[0];
  if (operationName !== null) {
    operation = document.operations.find((op) => op.name === operationName) ?? document.operations[0] as OperationNode;
  }
  if (operation === undefined) {
    return { errors: [{ message: 'No operation in GraphQL document' }] };
  }
  const executor = new Executor(forge, document);
  const result = executor.execute(operation, variables);
  return result;
}

export async function handleGraphQL(ctx: Ctx, rawBody: Buffer): Promise<void> {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = ctx.req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.slice('Bearer '.length) === '') {
    sendJson(ctx, 401, { message: 'Requires authentication' });
    return;
  }
  if (expected !== '' && header.slice('Bearer '.length) !== expected) {
    sendJson(ctx, 401, { message: 'Bad credentials' });
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    sendJson(ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(body)) {
    sendJson(ctx, 200, body.map((entry) => executeDocument(ctx.forge, entry)));
    return;
  }
  sendJson(ctx, 200, executeDocument(ctx.forge, body));
}
