// The forge's whole state, in memory: one tenant (the bearer token's
// account), its repositories, and inside each repository a git object
// database plus the issue / pull-request / label records GitHub's APIs
// serve. Nothing persists between runs and nothing reads a clock that
// can move backwards: timestamps come from a logical clock so a replay
// of the same trial produces the same bytes.

import { ObjectStore } from './git.ts';

export interface UserInfo {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

export interface LabelInfo {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface IssueInfo {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[]; // label names
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  isPull: boolean;
}

export interface PullInfo {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommentInfo {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export class RepoState {
  readonly store = new ObjectStore();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, LabelInfo>();
  readonly issues = new Map<number, IssueInfo>();
  readonly pulls = new Map<number, PullInfo>();
  readonly comments = new Map<number, CommentInfo[]>();
  nextNumber = 1;

  readonly id: number;
  readonly name: string;
  description: string;
  readonly isPrivate: boolean;
  defaultBranch: string;

  constructor(id: number, name: string, description: string, isPrivate: boolean, defaultBranch: string) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
  }

  /** The full ref the default branch points through (HEAD's target). */
  get headRef(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  tipOf(ref: string): string | undefined {
    return this.refs.get(ref);
  }
}

/**
 * The forge itself. The token's account login starts as the suite's
 * published practice identity and is re-learned from the first
 * owner-bearing path the client uses, so the same code serves any
 * trial identity the harness presents.
 */
export class Forge {
  viewerLogin = 'adaiversen';
  private ownerLocked = false;
  readonly repos = new Map<string, RepoState>();
  private nextRepoId = 1;
  private nextLabelId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private clockTick = 0;

  private readonly trialNow: string | null;

  constructor(trialNow: string | null) {
    this.trialNow = trialNow;
  }

  get viewer(): UserInfo {
    return { id: 1000, login: this.viewerLogin, name: this.viewerLogin, email: `${this.viewerLogin}@example.invalid` };
  }

  /**
   * Resolve an owner path segment to this forge's account: the first
   * owner seen locks in as the viewer; any other owner is a stranger
   * and owns nothing here (404, never 403).
   */
  resolveOwner(login: string): boolean {
    if (!this.ownerLocked) {
      this.viewerLogin = login;
      this.ownerLocked = true;
    }
    return login === this.viewerLogin;
  }

  /** The next logical timestamp: trial "now" when given, else a fixed epoch, +1s per event. */
  now(): string {
    const base = this.trialNow ? Date.parse(this.trialNow) : Date.parse('2025-01-01T00:00:00Z');
    const at = new Date(base + this.clockTick * 1000);
    this.clockTick += 1;
    return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** Unix seconds matching now(), for git ident lines. */
  nowUnix(): number {
    const base = this.trialNow ? Date.parse(this.trialNow) : Date.parse('2025-01-01T00:00:00Z');
    return Math.floor(base / 1000) + this.clockTick;
  }

  createRepo(name: string, description: string, isPrivate: boolean, defaultBranch: string): RepoState {
    const repo = new RepoState(this.nextRepoId++, name, description, isPrivate, defaultBranch || 'main');
    this.repos.set(name, repo);
    return repo;
  }

  repoByName(name: string): RepoState | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  newLabelId(): number {
    return this.nextLabelId++;
  }

  newIssueId(): number {
    return this.nextIssueId++;
  }

  newPullId(): number {
    return this.nextPullId++;
  }

  newCommentId(): number {
    return this.nextCommentId++;
  }
}
