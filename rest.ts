// The REST v3 surface: repositories, branches, commits, contents,
// labels, issues, comments and pull requests, in GitHub's shapes.
// Handlers are pure functions over the Forge store; app.ts owns the
// HTTP plumbing (auth, request ids, JSON framing).

import {
  buildCommit,
  buildTree,
  identLine,
  parseCommit,
  parseTree,
  type TreeEntry,
} from './git.ts';
import { closureOf, isAncestor, peelToCommit } from './githttp.ts';
import type { Forge, IssueInfo, PullInfo, RepoState } from './store.ts';

export interface RestResult {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const notFound = (): RestResult => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string): RestResult => ({ status: 422, body: { message } });

// ------------------------------------------------------------------ shapes

export function userShape(forge: Forge): Record<string, unknown> {
  const viewer = forge.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: nodeId('User', viewer.id),
    type: 'User',
    site_admin: false,
    name: viewer.name,
    email: viewer.email,
    html_url: `https://forge.invalid/${viewer.login}`,
    url: `/api/v3/users/${viewer.login}`,
  };
}

export function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

export function repoShape(forge: Forge, repo: RepoState): Record<string, unknown> {
  const owner = userShape(forge);
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${forge.viewerLogin}/${repo.name}`,
    owner,
    private: repo.isPrivate,
    html_url: `https://forge.invalid/${forge.viewerLogin}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}`,
    clone_url: `https://forge.invalid/${forge.viewerLogin}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    pushed_at: '2025-01-01T00:00:00Z',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelShape(repo: RepoState, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (!label) return null;
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: `/api/v3/repos/x/y/labels/${encodeURIComponent(label.name)}`,
  };
}

export function issueShape(forge: Forge, repo: RepoState, issue: IssueInfo): Record<string, unknown> {
  const base = `/api/v3/repos/${forge.viewerLogin}/${repo.name}`;
  return {
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    labels: issue.labels.map((name) => labelShape(repo, name)).filter(Boolean),
    user: userShape(forge),
    assignees: [],
    milestone: null,
    locked: false,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
    html_url: `https://forge.invalid/${forge.viewerLogin}/${repo.name}/issues/${issue.number}`,
    labels_url: `${base}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/issues/${issue.number}/comments`,
    events_url: `${base}/issues/${issue.number}/events`,
  };
}

function refShape(forge: Forge, repo: RepoState, refName: string, sha: string): Record<string, unknown> {
  return {
    label: `${forge.viewerLogin}:${refName}`,
    ref: refName,
    sha,
    user: userShape(forge),
    repo: repoShape(forge, repo),
  };
}

export function pullShape(forge: Forge, repo: RepoState, pull: PullInfo): Record<string, unknown> {
  const base = `/api/v3/repos/${forge.viewerLogin}/${repo.name}`;
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const mergeable = pull.merged ? true : computeMergeable(repo, headSha, baseSha);
  return {
    id: pull.id,
    node_id: nodeId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    user: userShape(forge),
    labels: [],
    head: refShape(forge, repo, pull.headRef, headSha),
    base: refShape(forge, repo, pull.baseRef, baseSha),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable,
    mergeable_state: pull.merged ? 'clean' : mergeable ? 'clean' : 'dirty',
    rebaseable: mergeable,
    comments: 0,
    review_comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.mergedAt ?? (pull.state === 'closed' ? pull.updatedAt : null),
    url: `${base}/pulls/${pull.number}`,
    html_url: `https://forge.invalid/${forge.viewerLogin}/${repo.name}/pull/${pull.number}`,
    diff_url: `${base}/pulls/${pull.number}.diff`,
    patch_url: `${base}/pulls/${pull.number}.patch`,
    _links: {},
  };
}

// ------------------------------------------------------------------ git plumbing over the store

/** Flatten a tree (recursively) to path -> entry. */
export function flattenTree(repo: RepoState, treeOid: string, prefix = ''): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const obj = repo.store.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') {
      for (const [p, e] of flattenTree(repo, entry.oid, path)) out.set(p, e);
    } else {
      out.set(path, entry);
    }
  }
  return out;
}

/** Build (and store) nested trees from a flat path -> entry map; returns the root tree id. */
export function unflattenTree(repo: RepoState, flat: Map<string, TreeEntry>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { files: [], dirs: new Map() });
      node = node.dirs.get(parts[i])!;
    }
    node.files.push({ ...entry, name: parts[parts.length - 1] });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, dir] of node.dirs) {
      entries.push({ mode: '40000', name, oid: build(dir) });
    }
    return repo.store.put('tree', buildTree(entries));
  };
  return build(root);
}

/** The flat file map at a commit (or empty for an unborn branch). */
export function filesAtCommit(repo: RepoState, commitOid: string | undefined): Map<string, TreeEntry> {
  if (!commitOid) return new Map();
  const obj = repo.store.get(commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(obj.data).tree);
}

/** Make a commit on a branch with the given flat file map; returns its id. */
export function commitFiles(
  forge: Forge,
  repo: RepoState,
  branchRef: string,
  flat: Map<string, TreeEntry>,
  message: string,
): string {
  const tree = unflattenTree(repo, flat);
  const parent = repo.refs.get(branchRef);
  const ident = identLine(forge.viewer.name, forge.viewer.email, forge.nowUnix());
  const commit = buildCommit({
    tree,
    parents: parent ? [parent] : [],
    author: ident,
    committer: ident,
    message,
  });
  const oid = repo.store.put('commit', commit);
  repo.refs.set(branchRef, oid);
  return oid;
}

function commitShape(repo: RepoState, oid: string): Record<string, unknown> {
  const obj = repo.store.get(oid);
  const info = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const parseIdent = (line: string): Record<string, unknown> => {
    const m = /^(.*) <(.*)> (\d+) /.exec(line);
    return m
      ? { name: m[1], email: m[2], date: new Date(parseInt(m[3], 10) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') }
      : { name: '', email: '', date: '2025-01-01T00:00:00Z' };
  };
  return {
    sha: oid,
    node_id: nodeId('Commit', 0) + oid.slice(0, 8),
    commit: {
      author: info ? parseIdent(info.authorLine) : {},
      committer: info ? parseIdent(info.committerLine) : {},
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? '', url: '' },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: (info?.parents ?? []).map((sha) => ({ sha, url: '', html_url: '' })),
  };
}

// ------------------------------------------------------------------ merges

/** The best common ancestor of two commits, or null. */
export function mergeBaseOf(repo: RepoState, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const stack = [a];
  while (stack.length) {
    const oid = stack.pop()!;
    if (ancestorsOfA.has(oid)) continue;
    const obj = repo.store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    ancestorsOfA.add(oid);
    stack.push(...parseCommit(obj.data).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const obj = repo.store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

interface MergeOutcome {
  readonly tree: Map<string, TreeEntry> | null; // null on conflict
  readonly conflicts: string[];
}

/** A three-way merge of flat file maps: base (merge-base), ours (base branch), theirs (head). */
export function mergeTrees(
  repo: RepoState,
  baseCommit: string,
  oursCommit: string,
  theirsCommit: string,
): MergeOutcome {
  const base = filesAtCommit(repo, baseCommit);
  const ours = filesAtCommit(repo, oursCommit);
  const theirs = filesAtCommit(repo, theirsCommit);
  const result = new Map<string, TreeEntry>();
  const conflicts: string[] = [];
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const same = (x?: TreeEntry, y?: TreeEntry): boolean => x?.oid === y?.oid && x?.mode === y?.mode;
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (same(o, t)) {
      if (o) result.set(path, o);
    } else if (same(b, o)) {
      if (t) result.set(path, t); // only theirs changed it
    } else if (same(b, t)) {
      if (o) result.set(path, o); // only ours changed it
    } else {
      conflicts.push(path);
    }
  }
  return { tree: conflicts.length ? null : result, conflicts };
}

export function computeMergeable(repo: RepoState, headSha: string, baseSha: string): boolean {
  const base = mergeBaseOf(repo, baseSha, headSha);
  if (!base) return false;
  return mergeTrees(repo, base, baseSha, headSha).tree !== null;
}

// ------------------------------------------------------------------ handlers: meta and repos

export function handleRoot(): RestResult {
  return {
    status: 200,
    body: {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
    },
    headers: { 'x-oauth-scopes': 'repo, read:org' },
  };
}

export function handleMeta(): RestResult {
  return { status: 200, body: { installed_version: '1.0.0-forge', verifiable_password_authentication: false } };
}

export function handleUserRepos(forge: Forge, query: URLSearchParams, baseUrl: string): RestResult {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const all = [...forge.repos.values()].sort((a, b) => a.id - b.id);
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < all.length) {
    headers.link = `<${baseUrl}/api/v3/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next", <${baseUrl}/api/v3/user/repos?page=${Math.ceil(all.length / perPage)}&per_page=${perPage}>; rel="last"`;
  }
  return { status: 200, body: slice.map((repo) => repoShape(forge, repo)), headers };
}

export function handleCreateRepo(forge: Forge, body: Record<string, unknown>): RestResult {
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name) return unprocessable('name is required');
  if (forge.repos.has(name)) return unprocessable('name already exists on this account');
  const repo = forge.createRepo(
    name,
    typeof body.description === 'string' ? body.description : '',
    body.private === true,
    typeof body.default_branch === 'string' ? body.default_branch : 'main',
  );
  return { status: 201, body: repoShape(forge, repo) };
}

export function handlePatchRepo(forge: Forge, repo: RepoState, body: Record<string, unknown>): RestResult {
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
  return { status: 200, body: repoShape(forge, repo) };
}

// ------------------------------------------------------------------ handlers: branches, refs, commits

export function handleListBranches(forge: Forge, repo: RepoState): RestResult {
  const branches: Record<string, unknown>[] = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({
      name: ref.slice('refs/heads/'.length),
      commit: { sha: oid, url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}/commits/${oid}` },
      protected: false,
    });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { status: 200, body: branches };
}

export function handleCreateRef(forge: Forge, repo: RepoState, body: Record<string, unknown>): RestResult {
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || !repo.store.has(sha)) return unprocessable('Invalid ref or sha');
  if (repo.refs.has(ref)) return unprocessable('Reference already exists');
  repo.refs.set(ref, sha);
  return {
    status: 201,
    body: {
      ref,
      node_id: nodeId('Ref', repo.id),
      url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}/git/refs/${ref.replace('refs/', '')}`,
      object: { type: repo.store.get(sha)?.type ?? 'commit', sha, url: '' },
    },
  };
}

export function handleListCommits(forge: Forge, repo: RepoState, query: URLSearchParams): RestResult {
  const shaParam = query.get('sha');
  let start: string | undefined;
  if (shaParam) {
    start = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.store.has(shaParam) ? shaParam : undefined);
  } else {
    start = repo.refs.get(repo.headRef);
  }
  if (!start) return { status: 409, body: { message: 'Git Repository is empty.' } };
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    ordered.push(oid);
    queue.push(...parseCommit(obj.data).parents);
  }
  const slice = ordered.slice((page - 1) * perPage, page * perPage);
  return { status: 200, body: slice.map((oid) => commitShape(repo, oid)) };
}

// ------------------------------------------------------------------ handlers: contents

interface ContentTarget {
  readonly repo: RepoState;
  readonly branchRef: string;
  readonly tip: string | undefined;
  readonly flat: Map<string, TreeEntry>;
}

function contentTarget(repo: RepoState, branch: string | undefined): ContentTarget {
  const branchRef = `refs/heads/${branch || repo.defaultBranch}`;
  const tip = repo.refs.get(branchRef);
  return { repo, branchRef, tip, flat: filesAtCommit(repo, tip) };
}

function fileShape(forge: Forge, repo: RepoState, path: string, entry: TreeEntry, withContent: boolean): Record<string, unknown> {
  const blob = repo.store.get(entry.oid);
  const base = `/api/v3/repos/${forge.viewerLogin}/${repo.name}`;
  return {
    type: 'file',
    encoding: 'base64',
    size: blob?.data.length ?? 0,
    name: path.split('/').pop() ?? path,
    path,
    content: withContent && blob ? blob.data.toString('base64') : '',
    sha: entry.oid,
    url: `${base}/contents/${path}`,
    html_url: `https://forge.invalid/${forge.viewerLogin}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `${base}/git/blobs/${entry.oid}`,
    download_url: null,
    _links: {},
  };
}

export function handleGetContents(forge: Forge, repo: RepoState, path: string, query: URLSearchParams): RestResult {
  const ref = query.get('ref') ?? undefined;
  const target = contentTarget(repo, ref && !repo.refs.has(`refs/heads/${ref}`) && repo.store.has(ref) ? undefined : ref);
  void target;
  const flat = filesAtCommit(repo, ref ? repo.refs.get(`refs/heads/${ref}`) ?? (repo.store.has(ref) ? ref : undefined) : repo.refs.get(repo.headRef));
  if (path === '') {
    // root listing
    return { status: 200, body: dirListing(forge, repo, flat, '') };
  }
  const entry = flat.get(path);
  if (entry) return { status: 200, body: fileShape(forge, repo, path, entry, true) };
  const isDir = [...flat.keys()].some((p) => p.startsWith(`${path}/`));
  if (isDir) return { status: 200, body: dirListing(forge, repo, flat, path) };
  return notFound();
}

function dirListing(forge: Forge, repo: RepoState, flat: Map<string, TreeEntry>, dir: string): Record<string, unknown>[] {
  const prefix = dir ? `${dir}/` : '';
  const seen = new Map<string, Record<string, unknown>>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(path, fileShape(forge, repo, path, entry, false));
    } else {
      const sub = prefix + rest.slice(0, slash);
      if (!seen.has(sub)) {
        seen.set(sub, {
          type: 'dir',
          size: 0,
          name: rest.slice(0, slash),
          path: sub,
          sha: '',
          url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}/contents/${sub}`,
          html_url: '',
          git_url: '',
          download_url: null,
          _links: {},
        });
      }
    }
  }
  return [...seen.values()].sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

export function handlePutContents(forge: Forge, repo: RepoState, path: string, body: Record<string, unknown>): RestResult {
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  const branch = typeof body.branch === 'string' ? body.branch : undefined;
  const target = contentTarget(repo, branch);
  const existing = target.flat.get(path);
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (existing) {
    if (!givenSha) return unprocessable('sha wasn\'t supplied');
    if (givenSha !== existing.oid) return { status: 409, body: { message: `${path} does not match ${givenSha}` } };
  }
  const data = Buffer.from(contentB64, 'base64');
  const blobOid = repo.store.put('blob', data);
  target.flat.set(path, { mode: '100644', name: path.split('/').pop() ?? path, oid: blobOid });
  const commit = commitFiles(forge, repo, target.branchRef, target.flat, message);
  const entry = target.flat.get(path)!;
  return {
    status: existing ? 200 : 201,
    body: { content: fileShape(forge, repo, path, entry, false), commit: { sha: commit, message } },
  };
}

export function handleDeleteContents(forge: Forge, repo: RepoState, path: string, body: Record<string, unknown>): RestResult {
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const branch = typeof body.branch === 'string' ? body.branch : undefined;
  const target = contentTarget(repo, branch);
  const existing = target.flat.get(path);
  if (!existing) return notFound();
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (givenSha && givenSha !== existing.oid) return { status: 409, body: { message: `${path} does not match ${givenSha}` } };
  target.flat.delete(path);
  const commit = commitFiles(forge, repo, target.branchRef, target.flat, message);
  return { status: 200, body: { content: null, commit: { sha: commit, message } } };
}

// ------------------------------------------------------------------ handlers: labels and issues

export function handleCreateLabel(forge: Forge, repo: RepoState, body: Record<string, unknown>): RestResult {
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name) return unprocessable('name is required');
  if (repo.labels.has(name)) return unprocessable('Validation Failed: label already exists');
  const label = {
    id: forge.newLabelId(),
    name,
    color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
    description: typeof body.description === 'string' ? body.description : null,
  };
  repo.labels.set(name, label);
  return {
    status: 201,
    body: {
      id: label.id,
      node_id: nodeId('Label', label.id),
      name: label.name,
      color: label.color,
      description: label.description,
      default: false,
      url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}/labels/${encodeURIComponent(name)}`,
    },
  };
}

export function handleListLabels(forge: Forge, repo: RepoState): RestResult {
  const out = [...repo.labels.values()].map((label) => ({
    id: label.id,
    node_id: nodeId('Label', label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
  }));
  return { status: 200, body: out };
}

function validateLabels(repo: RepoState, labels: unknown): string[] | RestResult {
  if (labels === undefined) return [];
  if (!Array.isArray(labels)) return unprocessable('labels must be an array');
  const names: string[] = [];
  for (const item of labels) {
    const name = typeof item === 'string' ? item : (item as { name?: unknown })?.name;
    if (typeof name !== 'string' || !repo.labels.has(name)) {
      return unprocessable(`Label "${String(name)}" does not exist`);
    }
    names.push(name);
  }
  return names;
}

export function handleCreateIssue(forge: Forge, repo: RepoState, body: Record<string, unknown>): RestResult {
  const title = typeof body.title === 'string' ? body.title : '';
  if (!title) return unprocessable('title is required');
  const labels = validateLabels(repo, body.labels);
  if (!Array.isArray(labels)) return labels;
  const now = forge.now();
  const issue: IssueInfo = {
    id: forge.newIssueId(),
    number: repo.nextNumber++,
    title,
    body: typeof body.body === 'string' ? body.body : null,
    state: 'open',
    labels,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    isPull: false,
  };
  repo.issues.set(issue.number, issue);
  return { status: 201, body: issueShape(forge, repo, issue) };
}

export function handleListIssues(forge: Forge, repo: RepoState, query: URLSearchParams): RestResult {
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') ?? 'desc';
  let list = [...repo.issues.values()].filter((issue) => !issue.isPull);
  if (state === 'open') list = list.filter((i) => i.state === 'open');
  else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
  list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  return { status: 200, body: list.slice((page - 1) * perPage, page * perPage).map((i) => issueShape(forge, repo, i)) };
}

export function handlePatchIssue(forge: Forge, repo: RepoState, number: number, body: Record<string, unknown>): RestResult {
  const issue = repo.issues.get(number);
  if (!issue) return notFound();
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string' || body.body === null) issue.body = body.body as string | null;
  if (body.labels !== undefined) {
    const labels = validateLabels(repo, body.labels);
    if (!Array.isArray(labels)) return labels;
    issue.labels = labels;
  }
  if (body.state === 'closed' || body.state === 'open') {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? forge.now() : null;
  }
  issue.updatedAt = forge.now();
  return { status: 200, body: issueShape(forge, repo, issue) };
}

export function handleCreateComment(forge: Forge, repo: RepoState, number: number, body: Record<string, unknown>): RestResult {
  const issue = repo.issues.get(number) ?? repo.pulls.get(number);
  if (!issue) return notFound();
  const text = typeof body.body === 'string' ? body.body : '';
  if (!text) return unprocessable('body is required');
  const now = forge.now();
  const comment = { id: forge.newCommentId(), body: text, createdAt: now, updatedAt: now };
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  return {
    status: 201,
    body: {
      id: comment.id,
      node_id: nodeId('IssueComment', comment.id),
      body: comment.body,
      user: userShape(forge),
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
      url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}/issues/comments/${comment.id}`,
      html_url: `https://forge.invalid/${forge.viewerLogin}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
      issue_url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}/issues/${number}`,
    },
  };
}

export function handleListComments(forge: Forge, repo: RepoState, number: number): RestResult {
  const issue = repo.issues.get(number) ?? repo.pulls.get(number);
  if (!issue) return notFound();
  const list = repo.comments.get(number) ?? [];
  return {
    status: 200,
    body: list.map((comment) => ({
      id: comment.id,
      node_id: nodeId('IssueComment', comment.id),
      body: comment.body,
      user: userShape(forge),
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
      url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}/issues/comments/${comment.id}`,
      html_url: `https://forge.invalid/${forge.viewerLogin}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
      issue_url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}/issues/${number}`,
    })),
  };
}

// ------------------------------------------------------------------ handlers: pull requests

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

export function handleCreatePull(forge: Forge, repo: RepoState, body: Record<string, unknown>): RestResult {
  const title = typeof body.title === 'string' ? body.title : '';
  const head = stripOwnerPrefix(typeof body.head === 'string' ? body.head : '');
  const base = stripOwnerPrefix(typeof body.base === 'string' ? body.base : '');
  if (!title) return unprocessable('title is required');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha) return unprocessable(`Head branch "${head}" does not exist`);
  if (!baseSha) return unprocessable(`Base branch "${base}" does not exist`);
  if (head === base) return unprocessable('Head and base must be different');
  const now = forge.now();
  const pull: PullInfo = {
    id: forge.newPullId(),
    number: repo.nextNumber++,
    title,
    body: typeof body.body === 'string' ? body.body : null,
    state: 'open',
    headRef: head,
    headSha,
    baseRef: base,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.set(pull.number, pull);
  return { status: 201, body: pullShape(forge, repo, pull) };
}

export function handleListPulls(forge: Forge, repo: RepoState, query: URLSearchParams): RestResult {
  const state = query.get('state') ?? 'open';
  let list = [...repo.pulls.values()];
  if (state === 'open') list = list.filter((p) => p.state === 'open');
  else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
  list.sort((a, b) => b.number - a.number);
  return { status: 200, body: list.map((p) => pullShape(forge, repo, p)) };
}

/** Line counts for a blob pair, via a small LCS diff (files here are small). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: n - common, deletions: m - common };
}

export function pullFiles(repo: RepoState, pull: PullInfo): Record<string, unknown>[] {
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const mergeBase = mergeBaseOf(repo, baseSha, headSha) ?? baseSha;
  const before = filesAtCommit(repo, mergeBase);
  const after = filesAtCommit(repo, headSha);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const out: Record<string, unknown>[] = [];
  for (const path of [...paths].sort()) {
    const b = before.get(path);
    const a = after.get(path);
    if (b?.oid === a?.oid) continue;
    const oldText = b ? repo.store.get(b.oid)?.data.toString('utf8') ?? '' : '';
    const newText = a ? repo.store.get(a.oid)?.data.toString('utf8') ?? '' : '';
    const { additions, deletions } = lineDiff(oldText, newText);
    out.push({
      sha: a?.oid ?? b?.oid ?? '',
      filename: path,
      status: !b ? 'added' : !a ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    });
  }
  return out;
}

export function handleMergePull(forge: Forge, repo: RepoState, number: number, body: Record<string, unknown>): RestResult {
  const pull = repo.pulls.get(number);
  if (!pull) return notFound();
  if (pull.state !== 'open' || pull.merged) {
    return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  }
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
  const baseRef = `refs/heads/${pull.baseRef}`;
  const baseTip = repo.refs.get(baseRef) ?? pull.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const mergeBase = mergeBaseOf(repo, baseTip, headTip);
  if (!mergeBase) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  const outcome = mergeTrees(repo, mergeBase, baseTip, headTip);
  if (!outcome.tree) {
    return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  }
  const tree = unflattenTree(repo, outcome.tree);
  const ident = identLine(forge.viewer.name, forge.viewer.email, forge.nowUnix());
  let message: string;
  let parents: string[];
  if (method === 'squash') {
    const title = typeof body.commit_title === 'string' ? body.commit_title : `${pull.title} (#${pull.number})`;
    const extra = typeof body.commit_message === 'string' ? body.commit_message : pull.body ?? '';
    message = extra ? `${title}\n\n${extra}` : title;
    parents = [baseTip];
  } else {
    message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    parents = [baseTip, headTip];
  }
  const commitData = buildCommit({ tree, parents, author: ident, committer: ident, message });
  const sha = repo.store.put('commit', commitData);
  repo.refs.set(baseRef, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.now();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
}

// Re-exported for app.ts routing convenience.
export { closureOf, isAncestor, peelToCommit };
