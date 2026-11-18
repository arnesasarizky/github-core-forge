// The GraphQL v4 surface: a small parser and executor covering the
// documents gh and github-mcp-server send — viewer, repository reads,
// issue and pull-request connections with cursor paging, the feature-
// detection __type probes, and the create/close/merge/comment
// mutations. Global ids are the same node ids the REST API returns,
// so an id read anywhere round-trips everywhere.

import type { Forge, IssueInfo, PullInfo, RepoState } from './store.ts';
import {
  computeMergeable,
  handleCreateIssue,
  handleCreatePull,
  handleMergePull,
  nodeId,
  pullFiles,
} from './rest.ts';

// ------------------------------------------------------------------ parsing

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Map<string, Value>;
  selection: FieldNode[] | null;
  fragmentType: string | null; // set on inline-fragment pseudo-fields
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: FieldNode[];
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (/\s|,/.test(c)) {
      i++;
    } else if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
    } else if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          text += source[j];
          j++;
        }
      }
      tokens.push(`"${text}"`);
      i = j + 1;
    } else if ('{}()[]:$!@='.includes(c)) {
      tokens.push(c);
      i++;
    } else {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_.-]/.test(source[j])) j++;
      tokens.push(source.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

class Parser {
  private at = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.at];
  }

  private next(): string {
    const token = this.tokens[this.at++];
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, { type: string; selection: FieldNode[] }> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, { type: string; selection: FieldNode[] }>();
    while (this.at < this.tokens.length) {
      const head = this.peek();
      if (head === 'query' || head === 'mutation') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() && /^[A-Za-z_]/.test(this.peek()!)) name = this.next();
        if (this.peek() === '(') this.skipParens();
        operations.push({ type, name, selection: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const type = this.next();
        fragments.set(fragName, { type, selection: this.parseSelectionSet() });
      } else if (head === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private skipParens(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(') depth++;
      else if (token === ')') depth--;
    } while (depth > 0);
  }

  parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const type = this.next();
          fields.push({ name: '', alias: null, args: new Map(), selection: this.parseSelectionSet(), fragmentType: type });
        } else {
          const fragName = this.next();
          fields.push({ name: `...${fragName}`, alias: null, args: new Map(), selection: null, fragmentType: null });
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args = new Map<string, Value>();
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.set(argName, this.parseValue());
        }
        this.next();
      }
      if (this.peek() === '@') {
        // a directive: skip its name and any argument list
        this.next();
        this.next();
        if (this.peek() === '(') this.skipParens();
      }
      const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
      fields.push({ name, alias, args, selection, fragmentType: null });
    }
    this.next();
    return fields;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true' || token === 'false') return { kind: 'bool', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: parseInt(token, 10) };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'int', value: Math.trunc(parseFloat(token)) };
    return { kind: 'enum', value: token };
  }
}

// ------------------------------------------------------------------ schema

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', 'meta'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue'],
  User: ['id', 'login', 'name', 'email', 'url', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt',
    'closedAt', 'closed', 'author', 'repository', 'labels', 'comments',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'url', 'createdAt',
    'updatedAt', 'closedAt', 'author', 'repository', 'mergeCommit',
  ],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['id', 'oid', 'message', 'committedDate'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'databaseId', 'body', 'createdAt', 'updatedAt', 'author'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergePullRequestMethod: ['MERGE', 'SQUASH', 'REBASE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// ------------------------------------------------------------------ execution

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, { type: string; selection: FieldNode[] }>;
}

type Resolver = (ctx: Ctx, source: any, args: Map<string, unknown>, field: FieldNode) => unknown;

function resolveValue(ctx: Ctx, value: Value): unknown {
  switch (value.kind) {
    case 'var':
      return ctx.variables[value.name];
    case 'int':
    case 'string':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(ctx, item));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = resolveValue(ctx, inner);
      return out;
    }
  }
}

function argsOf(ctx: Ctx, field: FieldNode): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of field.args) out.set(key, resolveValue(ctx, value));
  return out;
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? parseInt(m[1], 10) : -1;
  } catch {
    return -1;
  }
}

function paginate<T>(items: readonly T[], args: Map<string, unknown>): { page: T[]; hasNext: boolean; endCursor: string | null; startAt: number } {
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : items.length;
  const after = indexOfCursor(args.get('after'));
  const startAt = after + 1;
  const page = items.slice(startAt, startAt + first);
  return {
    page,
    hasNext: startAt + first < items.length,
    endCursor: page.length ? cursorOf(startAt + page.length - 1) : null,
    startAt,
  };
}

function decodeNodeId(id: unknown): { kind: string; numeric: number } | null {
  if (typeof id !== 'string') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const m = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (m) return { kind: m[1], numeric: parseInt(m[2], 10) };
  } catch {
    /* fall through */
  }
  if (/^\d+$/.test(id)) return { kind: 'Repository', numeric: parseInt(id, 10) };
  return null;
}

function findRepoById(forge: Forge, id: unknown): RepoState | null {
  const decoded = decodeNodeId(id);
  if (!decoded) return null;
  if (decoded.kind === 'Repository') {
    for (const repo of forge.repos.values()) if (repo.id === decoded.numeric) return repo;
  }
  return null;
}

function findIssueById(forge: Forge, id: unknown): { repo: RepoState; issue: IssueInfo } | null {
  const decoded = decodeNodeId(id);
  if (!decoded) return null;
  for (const repo of forge.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === decoded.numeric) return { repo, issue };
    }
  }
  return null;
}

function findPullById(forge: Forge, id: unknown): { repo: RepoState; pull: PullInfo } | null {
  const decoded = decodeNodeId(id);
  if (!decoded) return null;
  for (const repo of forge.repos.values()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === decoded.numeric) return { repo, pull };
    }
  }
  return null;
}

// ---- object resolvers, keyed by type name

function repoObject(forge: Forge, repo: RepoState): Record<string, unknown> {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: RepoState, issue: IssueInfo): Record<string, unknown> {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: RepoState, pull: PullInfo): Record<string, unknown> {
  return { __typename: 'PullRequest', repo, pull };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (ctx) => ({ __typename: 'User' }),
    repository: (ctx, _s, args) => {
      const owner = String(args.get('owner') ?? '');
      const name = String(args.get('name') ?? '');
      if (!ctx.forge.resolveOwner(owner)) return null;
      const repo = ctx.forge.repoByName(name);
      return repo ? repoObject(ctx.forge, repo) : null;
    },
    node: (ctx, _s, args) => {
      const id = args.get('id');
      const repo = findRepoById(ctx.forge, id);
      if (repo) return repoObject(ctx.forge, repo);
      const foundIssue = findIssueById(ctx.forge, id);
      if (foundIssue) return issueObject(foundIssue.repo, foundIssue.issue);
      const foundPull = findPullById(ctx.forge, id);
      if (foundPull) return pullObject(foundPull.repo, foundPull.pull);
      return null;
    },
    rateLimit: () => ({ limit: 5000, cost: 1, remaining: 4999, resetAt: '2025-01-01T01:00:00Z' }),
    meta: () => null,
  },
  Mutation: {
    createIssue: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const repo = findRepoById(ctx.forge, input.repositoryId);
      if (!repo) throw new Error('repository not found');
      const result = handleCreateIssue(ctx.forge, repo, { title: input.title, body: input.body, labels: input.labelIds ? undefined : undefined });
      if (result.status !== 201) throw new Error(`createIssue failed: ${JSON.stringify(result.body)}`);
      const number = (result.body as { number: number }).number;
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, repo.issues.get(number)!), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const found = findIssueById(ctx.forge, input.issueId);
      if (!found) throw new Error('issue not found');
      found.issue.state = 'closed';
      found.issue.closedAt = ctx.forge.now();
      found.issue.updatedAt = found.issue.closedAt;
      return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const repo = findRepoById(ctx.forge, input.repositoryId);
      if (!repo) throw new Error('repository not found');
      const result = handleCreatePull(ctx.forge, repo, {
        title: input.title,
        body: input.body,
        head: input.headRefName,
        base: input.baseRefName,
      });
      if (result.status !== 201) throw new Error(`createPullRequest failed: ${JSON.stringify(result.body)}`);
      const number = (result.body as { number: number }).number;
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, repo.pulls.get(number)!), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const found = findPullById(ctx.forge, input.pullRequestId);
      if (!found) throw new Error('pull request not found');
      const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
      const result = handleMergePull(ctx.forge, found.repo, found.pull.number, {
        merge_method: method,
        commit_title: input.commitTitle,
        commit_message: input.commitBody,
      });
      if (result.status !== 200) throw new Error(`mergePullRequest failed: ${JSON.stringify(result.body)}`);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const foundIssue = findIssueById(ctx.forge, input.subjectId);
      const foundPull = foundIssue ? null : findPullById(ctx.forge, input.subjectId);
      const repo = foundIssue?.repo ?? foundPull?.repo;
      const number = foundIssue?.issue.number ?? foundPull?.pull.number;
      if (!repo || number === undefined) throw new Error('subject not found');
      const now = ctx.forge.now();
      const comment = { id: ctx.forge.newCommentId(), body: String(input.body ?? ''), createdAt: now, updatedAt: now };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      const node = { __typename: 'IssueComment', comment, repo };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorOf(list.length - 1) },
        clientMutationId: input.clientMutationId ?? null,
        subject: foundIssue ? issueObject(foundIssue.repo, foundIssue.issue) : pullObject(foundPull!.repo, foundPull!.pull),
      };
    },
    updateIssue: (ctx, _s, args) => {
      const input = (args.get('input') ?? {}) as Record<string, unknown>;
      const found = findIssueById(ctx.forge, input.id);
      if (!found) throw new Error('issue not found');
      if (typeof input.title === 'string') found.issue.title = input.title;
      if (typeof input.body === 'string') found.issue.body = input.body;
      if (input.state === 'CLOSED') found.issue.state = 'closed';
      if (input.state === 'OPEN') found.issue.state = 'open';
      found.issue.updatedAt = ctx.forge.now();
      return { __typename: 'CreateIssuePayload', issue: issueObject(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    },
  },
  User: {
    id: (ctx) => nodeId('User', ctx.forge.viewer.id),
    databaseId: (ctx) => ctx.forge.viewer.id,
    login: (ctx) => ctx.forge.viewerLogin,
    name: (ctx) => ctx.forge.viewer.name,
    email: (ctx) => ctx.forge.viewer.email,
    url: (ctx) => `https://forge.invalid/${ctx.forge.viewerLogin}`,
  },
  Repository: {
    id: (_ctx, s) => nodeId('Repository', (s.repo as RepoState).id),
    databaseId: (_ctx, s) => (s.repo as RepoState).id,
    name: (_ctx, s) => (s.repo as RepoState).name,
    nameWithOwner: (ctx, s) => `${ctx.forge.viewerLogin}/${(s.repo as RepoState).name}`,
    owner: () => ({ __typename: 'User' }),
    description: (_ctx, s) => (s.repo as RepoState).description,
    isPrivate: (_ctx, s) => (s.repo as RepoState).isPrivate,
    defaultBranchRef: (_ctx, s) => {
      const repo = s.repo as RepoState;
      return { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', repo };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    createdAt: () => '2025-01-01T00:00:00Z',
    updatedAt: () => '2025-01-01T00:00:00Z',
    url: (ctx, s) => `https://forge.invalid/${ctx.forge.viewerLogin}/${(s.repo as RepoState).name}`,
    issue: (_ctx, s, args) => {
      const repo = s.repo as RepoState;
      const issue = repo.issues.get(Number(args.get('number')));
      return issue ? issueObject(repo, issue) : null;
    },
    issues: (_ctx, s, args) => {
      const repo = s.repo as RepoState;
      let list = [...repo.issues.values()].filter((i) => !i.isPull);
      const states = args.get('states') as string[] | undefined;
      if (Array.isArray(states) && states.length) {
        const wanted = states.map((x) => String(x).toLowerCase());
        list = list.filter((i) => wanted.includes(i.state));
      }
      const orderBy = args.get('orderBy') as { field?: string; direction?: string } | undefined;
      const direction = orderBy?.direction === 'ASC' ? 'asc' : 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return { __typename: 'IssueConnection', items: list.map((i) => issueObject(repo, i)), args };
    },
    pullRequest: (_ctx, s, args) => {
      const repo = s.repo as RepoState;
      const pull = repo.pulls.get(Number(args.get('number')));
      return pull ? pullObject(repo, pull) : null;
    },
    pullRequests: (_ctx, s, args) => {
      const repo = s.repo as RepoState;
      let list = [...repo.pulls.values()];
      const states = args.get('states') as string[] | undefined;
      if (Array.isArray(states) && states.length) {
        const wanted = states.map((x) => String(x).toUpperCase());
        list = list.filter((p) => wanted.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
      } else {
        list = list.filter((p) => p.state === 'open');
      }
      list.sort((a, b) => b.number - a.number);
      return { __typename: 'PullRequestConnection', items: list.map((p) => pullObject(repo, p)), args };
    },
  },
  Issue: {
    id: (_ctx, s) => nodeId('Issue', (s.issue as IssueInfo).id),
    databaseId: (_ctx, s) => (s.issue as IssueInfo).id,
    number: (_ctx, s) => (s.issue as IssueInfo).number,
    title: (_ctx, s) => (s.issue as IssueInfo).title,
    body: (_ctx, s) => (s.issue as IssueInfo).body,
    state: (_ctx, s) => (s.issue as IssueInfo).state.toUpperCase(),
    url: (ctx, s) => `https://forge.invalid/${ctx.forge.viewerLogin}/${(s.repo as RepoState).name}/issues/${(s.issue as IssueInfo).number}`,
    createdAt: (_ctx, s) => (s.issue as IssueInfo).createdAt,
    updatedAt: (_ctx, s) => (s.issue as IssueInfo).updatedAt,
    closedAt: (_ctx, s) => (s.issue as IssueInfo).closedAt,
    closed: (_ctx, s) => (s.issue as IssueInfo).state === 'closed',
    author: () => ({ __typename: 'User' }),
    repository: (_ctx, s) => repoObject(null as unknown as Forge, s.repo as RepoState),
    labels: (_ctx, s, args) => {
      const repo = s.repo as RepoState;
      const issue = s.issue as IssueInfo;
      const items = issue.labels
        .map((name) => repo.labels.get(name))
        .filter(Boolean)
        .map((label) => ({ __typename: 'Label', label: label!, repo }));
      return { __typename: 'IssueConnection', items: [], args, labelItems: items };
    },
    comments: (_ctx, s, args) => {
      const repo = s.repo as RepoState;
      const issue = s.issue as IssueInfo;
      const items = (repo.comments.get(issue.number) ?? []).map((comment) => ({ __typename: 'IssueComment', comment, repo }));
      return { __typename: 'IssueConnection', items: [], args, commentItems: items };
    },
  },
  PullRequest: {
    id: (_ctx, s) => nodeId('PullRequest', (s.pull as PullInfo).id),
    databaseId: (_ctx, s) => (s.pull as PullInfo).id,
    number: (_ctx, s) => (s.pull as PullInfo).number,
    title: (_ctx, s) => (s.pull as PullInfo).title,
    body: (_ctx, s) => (s.pull as PullInfo).body,
    state: (_ctx, s) => {
      const pull = s.pull as PullInfo;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (_ctx, s) => (s.pull as PullInfo).merged,
    mergedAt: (_ctx, s) => (s.pull as PullInfo).mergedAt,
    mergeable: (_ctx, s) => {
      const repo = s.repo as RepoState;
      const pull = s.pull as PullInfo;
      if (pull.merged) return 'MERGEABLE';
      const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      return computeMergeable(repo, headSha, baseSha) ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (_ctx, s) => (s.pull as PullInfo).headRef,
    baseRefName: (_ctx, s) => (s.pull as PullInfo).baseRef,
    headRefOid: (_ctx, s) => {
      const repo = s.repo as RepoState;
      const pull = s.pull as PullInfo;
      return repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    },
    baseRefOid: (_ctx, s) => {
      const repo = s.repo as RepoState;
      const pull = s.pull as PullInfo;
      return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    },
    files: (_ctx, s, args) => {
      const repo = s.repo as RepoState;
      const pull = s.pull as PullInfo;
      const items = pullFiles(repo, pull).map((file) => ({
        __typename: 'PullRequestFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: String(file.status).toUpperCase(),
      }));
      return { __typename: 'PullRequestFileConnection', items, args };
    },
    url: (ctx, s) => `https://forge.invalid/${ctx.forge.viewerLogin}/${(s.repo as RepoState).name}/pull/${(s.pull as PullInfo).number}`,
    createdAt: (_ctx, s) => (s.pull as PullInfo).createdAt,
    updatedAt: (_ctx, s) => (s.pull as PullInfo).updatedAt,
    closedAt: (_ctx, s) => (s.pull as PullInfo).mergedAt,
    author: () => ({ __typename: 'User' }),
    repository: (_ctx, s) => repoObject(null as unknown as Forge, s.repo as RepoState),
    mergeCommit: (_ctx, s) => {
      const pull = s.pull as PullInfo;
      return pull.mergeCommitSha ? { __typename: 'Commit', oid: pull.mergeCommitSha } : null;
    },
  },
  Ref: {
    name: (_ctx, s) => (s as { name: string }).name,
    prefix: (_ctx, s) => (s as { prefix: string }).prefix,
    target: (_ctx, s) => {
      const repo = (s as { repo: RepoState }).repo;
      const name = (s as { name: string }).name;
      const oid = repo.refs.get(`refs/heads/${name}`);
      return oid ? { __typename: 'Commit', oid } : null;
    },
  },
  Commit: {
    id: (_ctx, s) => nodeId('Commit', 0) + String((s as { oid: string }).oid).slice(0, 8),
    oid: (_ctx, s) => (s as { oid: string }).oid,
    message: () => '',
    committedDate: () => '2025-01-01T00:00:00Z',
  },
  Label: {
    id: (_ctx, s) => nodeId('Label', (s.label as { id: number }).id),
    name: (_ctx, s) => (s.label as { name: string }).name,
    color: (_ctx, s) => (s.label as { color: string }).color,
    description: (_ctx, s) => (s.label as { description: string | null }).description,
  },
  IssueComment: {
    id: (_ctx, s) => nodeId('IssueComment', (s.comment as { id: number }).id),
    databaseId: (_ctx, s) => (s.comment as { id: number }).id,
    body: (_ctx, s) => (s.comment as { body: string }).body,
    createdAt: (_ctx, s) => (s.comment as { createdAt: string }).createdAt,
    updatedAt: (_ctx, s) => (s.comment as { updatedAt: string }).updatedAt,
    author: () => ({ __typename: 'User' }),
  },
};

// ---- connection field handling (nodes / edges / pageInfo share one shape)

function connectionFields(ctx: Ctx, source: any, field: FieldNode): unknown {
  const items: unknown[] = source.items ?? source.labelItems ?? source.commentItems ?? [];
  const args = (source.args ?? new Map()) as Map<string, unknown>;
  const { page, hasNext, endCursor, startAt } = paginate(items, args);
  switch (field.name) {
    case 'nodes':
      return page;
    case 'edges':
      return page.map((node, i) => ({ __typename: 'Edge', node, cursor: cursorOf(startAt + i) }));
    case 'totalCount':
      return items.length;
    case 'pageInfo':
      return {
        __typename: 'PageInfo',
        hasNextPage: hasNext,
        hasPreviousPage: startAt > 0,
        startCursor: page.length ? cursorOf(startAt) : null,
        endCursor,
      };
    default:
      return null;
  }
}

function executeSelection(ctx: Ctx, typeName: string, source: any, selection: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.fragmentType) {
      if (source?.__typename === field.fragmentType || field.fragmentType === typeName) {
        Object.assign(out, executeSelection(ctx, field.fragmentType, source, field.selection ?? []));
      }
      continue;
    }
    if (field.name.startsWith('...')) {
      const fragment = ctx.fragments.get(field.name.slice(3));
      if (fragment && (source?.__typename === fragment.type || fragment.type === typeName)) {
        Object.assign(out, executeSelection(ctx, fragment.type, source, fragment.selection));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = source?.__typename ?? typeName;
      continue;
    }
    if (field.name === '__type') {
      out[key] = executeTypeQuery(ctx, field);
      continue;
    }
    if (field.name === '__schema') {
      out[key] = { types: Object.keys(TYPE_FIELDS).map((name) => ({ name })), queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
      continue;
    }
    const isConnection = typeof source?.__typename === 'string' && source.__typename.endsWith('Connection');
    let value: unknown;
    if (isConnection && ['nodes', 'edges', 'pageInfo', 'totalCount'].includes(field.name)) {
      value = connectionFields(ctx, source, field);
    } else {
      const resolver = RESOLVERS[typeName]?.[field.name];
      if (!resolver) {
        // Payload and value objects (mutation payloads, PageInfo, __Field,
        // file entries) carry their fields as plain properties.
        if (source !== null && typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, field.name)) {
          value = (source as Record<string, unknown>)[field.name];
          out[key] = completeValue(ctx, value, field);
          continue;
        }
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
        out[key] = null;
        continue;
      }
      try {
        value = resolver(ctx, source, argsOf(ctx, field), field);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[key] = null;
        continue;
      }
    }
    out[key] = completeValue(ctx, value, field);
  }
  return out;
}

function completeValue(ctx: Ctx, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, field));
  if (typeof value === 'object') {
    const typeName = (value as { __typename?: string }).__typename;
    if (typeName && field.selection) {
      return executeSelection(ctx, typeName, value, field.selection);
    }
    if (field.selection && !typeName) {
      // A plain sub-object (PageInfo-like or payload scalars): resolve by keys.
      const out: Record<string, unknown> = {};
      for (const sub of field.selection) {
        const subKey = sub.alias ?? sub.name;
        const inner = (value as Record<string, unknown>)[sub.name];
        out[subKey] = completeValue(ctx, inner, sub);
      }
      return out;
    }
    return value;
  }
  return value;
}

function executeTypeQuery(ctx: Ctx, field: FieldNode): unknown {
  const args = argsOf(ctx, field);
  const name = String(args.get('name') ?? '');
  const fields = TYPE_FIELDS[name];
  const enumValues = ENUM_VALUES[name];
  if (!fields && !enumValues) return null;
  const typeObject: Record<string, unknown> = {
    __typename: '__Type',
    name,
    kind: enumValues ? 'ENUM' : 'OBJECT',
    fields: fields ? fields.map((fieldName) => ({ __typename: '__Field', name: fieldName })) : null,
    enumValues: enumValues ? enumValues.map((valueName) => ({ __typename: '__EnumValue', name: valueName })) : null,
  };
  if (!field.selection) return typeObject;
  const out: Record<string, unknown> = {};
  for (const sub of field.selection) {
    const key = sub.alias ?? sub.name;
    const inner = typeObject[sub.name];
    out[key] = completeValue(ctx, inner, sub);
  }
  return out;
}

// ------------------------------------------------------------------ entry point

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export function executeGraphQL(forge: Forge, request: GraphQLRequest): { data?: unknown; errors?: Array<{ message: string }> } {
  let document: { operations: Operation[]; fragments: Map<string, { type: string; selection: FieldNode[] }> };
  try {
    document = new Parser(tokenize(request.query ?? '')).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const ctx: Ctx = { forge, variables: request.variables ?? {}, errors: [], fragments: document.fragments };
  let operation = document.operations[0];
  if (request.operationName) {
    operation = document.operations.find((op) => op.name === request.operationName) ?? operation;
  }
  if (!operation) return { errors: [{ message: 'no operation in document' }] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, { __typename: rootType }, operation.selection);
  const result: { data?: unknown; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}
