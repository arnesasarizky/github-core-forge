// Git smart HTTP: the info/refs advertisements, upload-pack (protocol
// v2 ls-refs and fetch, plus the v0 fetch fallback) and receive-pack
// (v0, report-status over side-band-64k). The suite's client speaks
// exactly this; every reply is framed the way real git frames it.

import {
  ZERO_OID,
  commitInfoOf,
  parsePktLines,
  pktLine,
  pktText,
  readPack,
  treeEntriesOf,
  writePack,
  type GitObject,
} from './git.ts';
import type { RepoState } from './store.ts';

const AGENT = 'forge/1.0';

// ------------------------------------------------------------------ helpers

/** Every object reachable from a root (commit, tree, blob or tag). */
export function closureOf(repo: RepoState, roots: readonly string[], boundary?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.store.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = commitInfoOf(oid, obj.data);
      stack.push(commit.tree);
      if (!boundary || !boundary.has(oid)) stack.push(...commit.parents);
    } else if (obj.type === 'tree') {
      for (const entry of treeEntriesOf(oid, obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const target = /object ([0-9a-f]{40})/.exec(obj.data.toString('utf8'));
      if (target) stack.push(target[1]);
    }
  }
  return seen;
}

/** Commits reachable from `from`, stopping at (and including) boundary commits. */
function commitAncestors(repo: RepoState, from: string, boundary?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    if (boundary && boundary.has(oid)) continue;
    stack.push(...commitInfoOf(oid, obj.data).parents);
  }
  return seen;
}

/**
 * Full ancestor sets, memoized by commit id (content hashes: a
 * commit's ancestors never change). A fast-forward check on a long
 * chain would otherwise re-walk the whole history on every push.
 */
const ancestorsCache = new Map<string, Set<string>>();

function ancestorsOf(repo: RepoState, oid: string): Set<string> {
  let cached = ancestorsCache.get(oid);
  if (cached) return cached;
  if (ancestorsCache.size > 100000) ancestorsCache.clear();
  cached = new Set<string>([oid]);
  ancestorsCache.set(oid, cached);
  const obj = repo.store.get(oid);
  if (obj?.type === 'commit') {
    for (const parent of commitInfoOf(oid, obj.data).parents) {
      for (const ancestor of ancestorsOf(repo, parent)) cached.add(ancestor);
    }
  }
  return cached;
}

export function isAncestor(repo: RepoState, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return ancestorsOf(repo, descendant).has(ancestor);
}

/** Peel a tag (or return the commit itself) to the commit it names. */
export function peelToCommit(repo: RepoState, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 20; hops++) {
    const obj = repo.store.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    const target = /object ([0-9a-f]{40})/.exec(obj.data.toString('utf8'));
    if (!target) return null;
    current = target[1];
  }
  return null;
}

/** Sorted ref list, the way advertisements and ls-refs present it. */
function sortedRefs(repo: RepoState): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ------------------------------------------------------------------ advertisements

export function infoRefs(repo: RepoState | null, service: string, version2: boolean): { status: number; type: string; body: Buffer } {
  if (!repo) {
    return { status: 404, type: 'text/plain; charset=utf-8', body: Buffer.from('not found\n') };
  }
  const type = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && version2) {
    const lines = [
      pktText('version 2\n'),
      pktText(`agent=${AGENT}\n`),
      pktText('ls-refs=unborn\n'),
      pktText('fetch=shallow wait-for-done\n'),
      pktText('server-option\n'),
      pktText('object-format=sha1\n'),
      pktLine('flush'),
    ];
    return { status: 200, type, body: Buffer.concat(lines) };
  }
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k ofs-delta agent=${AGENT}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktText(`# service=${service}\n`), pktLine('flush')];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(repo.headRef) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktText(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktText(`${headOid} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) parts.push(pktText(`${oid} ${ref}\n`));
  }
  parts.push(pktLine('flush'));
  return { status: 200, type, body: Buffer.concat(parts) };
}

// ------------------------------------------------------------------ ls-refs (v2)

function lsRefs(repo: RepoState, args: readonly string[]): Buffer {
  let symrefs = false;
  let peel = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'symrefs') symrefs = true;
    else if (arg === 'peel') peel = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (ref: string): boolean => !prefixes.length || prefixes.some((p) => ref.startsWith(p));
  const out: Buffer[] = [];
  const headOid = repo.refs.get(repo.headRef);
  if (matches('HEAD')) {
    if (headOid) {
      out.push(pktText(`${headOid} HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''}\n`));
    } else if (unborn) {
      out.push(pktText(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${repo.headRef}` : ''} unborn\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const target = repo.store.get(oid);
      if (target?.type === 'tag') {
        const commit = peelToCommit(repo, oid);
        if (commit) line += ` peeled:${commit}`;
      }
    }
    out.push(pktText(`${line}\n`));
  }
  out.push(pktLine('flush'));
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ fetch planning

interface FetchPlan {
  readonly send: string[]; // object ids for the pack, commits first
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly common: string[]; // haves the server also has
}

function planFetch(
  repo: RepoState,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundary: ReadonlySet<string>,
  deepen: number | null,
): FetchPlan {
  const common = haves.filter((h) => repo.store.get(h)?.type === 'commit');
  // What the client already holds: closures of its haves, not crossing
  // its declared shallow boundary.
  const held = new Set<string>();
  for (const have of common) {
    for (const oid of closureOf(repo, [have], shallowBoundary)) held.add(oid);
  }

  const includeCommits = new Set<string>();
  const newShallow = new Set<string>();
  // Breadth-first by generation so deepen counts generations exactly.
  let frontier = [...new Set(wants)].filter((w) => repo.store.get(w)?.type === 'commit');
  const wantTags = [...new Set(wants)].filter((w) => repo.store.get(w)?.type === 'tag');
  let generation = 1;
  const visited = new Set<string>();
  while (frontier.length) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (visited.has(oid)) continue;
      visited.add(oid);
      const isWant = wants.includes(oid);
      if (held.has(oid) && !isWant) continue;
      // The client's declared shallow floor: they hold these commits
      // already; without a deepen instruction nothing at or below the
      // floor is sent.
      if (shallowBoundary.has(oid) && !isWant && deepen === null) continue;
      includeCommits.add(oid);
      const parents = commitInfoOf(oid, repo.store.get(oid)!.data).parents;
      const atLimit = deepen !== null && generation >= deepen;
      if (atLimit) {
        for (const parent of parents) {
          if (repo.store.has(parent) && !held.has(parent)) newShallow.add(oid);
        }
      } else {
        for (const parent of parents) {
          if (repo.store.has(parent)) next.push(parent);
        }
      }
    }
    frontier = next;
    generation += 1;
  }
  // A commit whose parents were all included or held is not a boundary.
  for (const oid of [...newShallow]) {
    const parents = commitInfoOf(oid, repo.store.get(oid)!.data).parents;
    if (parents.every((p) => includeCommits.has(p) || held.has(p))) newShallow.delete(oid);
  }
  const unshallow: string[] = [];
  for (const oid of shallowBoundary) {
    if (includeCommits.has(oid)) {
      const obj = repo.store.get(oid);
      const parents = obj ? commitInfoOf(oid, obj.data).parents : [];
      if (parents.some((p) => includeCommits.has(p))) unshallow.push(oid);
    }
  }
  for (const oid of unshallow) newShallow.delete(oid);

  const sendSet = new Set<string>();
  for (const oid of includeCommits) {
    for (const inner of closureOf(repo, [oid], includeCommits)) {
      if (!held.has(inner)) sendSet.add(inner);
    }
  }
  for (const tag of wantTags) {
    for (const inner of closureOf(repo, [tag])) {
      if (!held.has(inner)) sendSet.add(inner);
    }
  }
  // Order: commits first (in walk order), then trees and blobs.
  const commits = [...sendSet].filter((oid) => repo.store.get(oid)?.type === 'commit');
  const others = [...sendSet].filter((oid) => repo.store.get(oid)?.type !== 'commit');
  return { send: [...commits, ...others], shallow: [...newShallow], unshallow, common };
}

/**
 * Whole-pack cache keyed by the object id list: ids are content
 * hashes, so the same list always yields the same pack bytes, and
 * repeated fetches of one tip (the clone benchmark's fifty shallow
 * clones, a client's retries) skip the rebuild entirely.
 */
const packCache = new Map<string, Buffer>();

function packFor(repo: RepoState, oids: readonly string[]): Buffer {
  const key = oids.join(' ');
  let pack = packCache.get(key);
  if (pack) return pack;
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const obj = repo.store.get(oid);
    if (obj) objects.push(obj);
  }
  pack = writePack(objects);
  if (packCache.size > 256) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

function packfileSection(repo: RepoState, oids: readonly string[]): Buffer {
  const pack = packFor(repo, oids);
  const parts: Buffer[] = [pktText('packfile\n')];
  const CHUNK = 32 * 1024;
  for (let at = 0; at < pack.length; at += CHUNK) {
    const chunk = pack.subarray(at, at + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktLine('flush'));
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ upload-pack

export function uploadPack(repo: RepoState, body: Buffer, version2: boolean): Buffer {
  const { packets } = parsePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }

  if (version2) {
    const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length);
    const args = lines.filter((l) => !l.startsWith('command=') && !l.includes('=') || l.startsWith('ref-prefix ') || l.startsWith('want ') || l.startsWith('have ') || l.startsWith('shallow ') || l.startsWith('deepen'));
    if (command === 'ls-refs') {
      return lsRefs(repo, lines.slice(1));
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow = new Set<string>();
      let deepen: number | null = null;
      let done = false;
      for (const line of lines) {
        if (line.startsWith('want ')) wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) shallow.add(line.slice(8).trim());
        else if (line.startsWith('deepen ')) deepen = parseInt(line.slice(7), 10);
        else if (line === 'done') done = true;
      }
      void args;
      const plan = planFetch(repo, wants, haves, shallow, deepen);
      const parts: Buffer[] = [];
      parts.push(pktText('acknowledgments\n'));
      if (plan.common.length === 0) {
        parts.push(pktText('NAK\n'));
      } else {
        for (const oid of plan.common) parts.push(pktText(`ACK ${oid}\n`));
        if (!done || plan.send.length === 0) parts.push(pktText('ready\n'));
      }
      parts.push(pktLine('delim'));
      if (done) {
        if (plan.shallow.length || plan.unshallow.length) {
          parts.push(pktText('shallow-info\n'));
          for (const oid of plan.shallow) parts.push(pktText(`shallow ${oid}\n`));
          for (const oid of plan.unshallow) parts.push(pktText(`unshallow ${oid}\n`));
          parts.push(pktLine('delim'));
        }
        if (plan.send.length) parts.push(packfileSection(repo, plan.send));
        else parts.push(pktLine('flush'));
      } else {
        parts.push(pktLine('flush'));
      }
      return Buffer.concat(parts);
    }
    return pktLine('flush');
  }

  // ---- v0 fetch: want/have/done lines, NAK or ACK, then the pack framed
  const wants: string[] = [];
  const haves: string[] = [];
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
  }
  const plan = planFetch(repo, wants, haves, new Set(), null);
  const parts: Buffer[] = [];
  if (plan.common.length) parts.push(pktText(`ACK ${plan.common[plan.common.length - 1]}\n`));
  else parts.push(pktText('NAK\n'));
  if (plan.send.length) {
    const pack = packFor(repo, plan.send);
    const CHUNK = 32 * 1024;
    for (let at = 0; at < pack.length; at += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(at, at + CHUNK)])));
    }
  }
  parts.push(pktLine('flush'));
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export function receivePack(repo: RepoState, body: Buffer): Buffer {
  const { packets, rest } = parsePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul !== -1) text = text.slice(0, nul);
    const [oldOid, newOid, ref] = text.split(' ');
    if (oldOid && newOid && ref) commands.push({ oldOid, newOid, ref });
  }

  const report: Buffer[] = [];
  const band = (inner: Buffer): void => {
    report.push(pktLine(Buffer.concat([Buffer.from([1]), inner])));
  };

  let unpackOk = true;
  let unpackLine = 'unpack ok\n';
  if (rest.length > 0) {
    try {
      const pack = readPack(rest, (oid) => repo.store.get(oid));
      for (const [oid, obj] of pack.objects) repo.store.putKnown(oid, obj.type, obj.data);
    } catch (err) {
      unpackOk = false;
      unpackLine = `unpack ${err instanceof Error ? err.message : 'error'}\n`;
    }
  }
  band(pktText(unpackLine));

  for (const command of commands) {
    const fail = (reason: string): void => {
      band(pktText(`ng ${command.ref} ${reason}\n`));
    };
    const ok = (): void => {
      band(pktText(`ok ${command.ref}\n`));
    };
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // delete
      if (current === undefined) {
        fail('reference not found');
      } else if (current !== command.oldOid) {
        fail('reference is at ' + current + ' but expected ' + command.oldOid);
      } else {
        repo.refs.delete(command.ref);
        ok();
      }
      continue;
    }
    const target = repo.store.get(command.newOid);
    if (!target) {
      fail('reference not found');
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        fail('reference already exists');
        continue;
      }
    } else {
      if (current !== command.oldOid) {
        fail('reference is at ' + (current ?? ZERO_OID) + ' but expected ' + command.oldOid);
        continue;
      }
      // fast-forward only, judged on the commits the refs name
      const oldCommit = peelToCommit(repo, command.oldOid);
      const newCommit = peelToCommit(repo, command.newOid);
      if (oldCommit && newCommit && !isAncestor(repo, oldCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    ok();
  }

  report.push(pktLine('flush'));
  return Buffer.concat(report);
}
