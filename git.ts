// The git object model in one file: loose objects in memory, packfiles in
// and out, and the pkt-line framing the smart-HTTP protocol speaks.
// Standard library only (node:crypto for SHA-1, node:zlib for the deflate
// streams inside packs). Objects are stored once, keyed by their hex id,
// as { type, data } with data the raw uncompressed object body.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The id an object body hashes to: sha1 of "<type> <length>\0" + body. */
export function objectId(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

// ------------------------------------------------------------------ store

/** Every repository's object database: one flat map, objects are immutable. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store a body, returning its id. Idempotent: the same body is the same id. */
  put(type: GitObjectType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id the caller already knows (from a pack). */
  putKnown(oid: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  readonly mode: string; // "100644", "100755", "120000", "40000" for a subtree
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const mode = data.subarray(at, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** Serialize tree entries in git's order: by name, directories as "name/". */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ commits

export interface CommitInfo {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly authorLine: string;
  readonly committerLine: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, message };
}

export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** The identity line git writes: "Name <email> <unix-seconds> +0000". */
export function identLine(name: string, email: string, unixSeconds: number): string {
  return `${name} <${email}> ${unixSeconds} +0000`;
}

// ------------------------------------------------------------------ deltas

function readDeltaVarint(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = at;
  for (;;) {
    const byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }
  return { value, next: pos };
}

/** Apply a git binary delta (the copy/insert instruction stream) to a base. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const src = readDeltaVarint(delta, 0);
  if (src.value !== base.length) throw new Error(`delta base size mismatch: ${src.value} vs ${base.length}`);
  const dst = readDeltaVarint(delta, src.next);
  let pos = dst.next;
  const out: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset |= delta[pos++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size |= delta[pos++] << (8 * i);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      written += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dst.value || written !== dst.value) {
    throw new Error(`delta result size mismatch: ${result.length} vs ${dst.value}`);
  }
  return result;
}

// ------------------------------------------------------------------ packs

/**
 * Inflate one zlib stream starting at `at`, finding where it ends by
 * growing a probe window until the stream decodes. Packs here are small
 * (the suite pushes plain objects), so the doubling search costs little.
 */
function inflateOne(buf: Buffer, at: number): { data: Buffer; next: number } {
  let span = Math.min(buf.length - at, 64);
  for (;;) {
    try {
      const data = inflateSync(buf.subarray(at, at + span));
      // A successful decode of a truncated slice can happen only when the
      // slice ends exactly at the stream end; verify by shrinking is overkill:
      // git streams are self-terminating, so the first span that decodes AND
      // reaches a stream end is found by checking a single extra byte class:
      // we accept the smallest span that decodes fully.
      return { data, next: at + consumedZlibLength(buf, at, span, data) };
    } catch {
      if (at + span >= buf.length) throw new Error('pack object is truncated');
      span = Math.min(buf.length - at, span * 2);
    }
  }
}

/**
 * The exact compressed length of the zlib stream at `at`, given a span
 * known to decode: bisect for the smallest prefix that still decodes to
 * the same bytes.
 */
function consumedZlibLength(buf: Buffer, at: number, span: number, expected: Buffer): number {
  let lo = 1;
  let hi = span;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      const data = inflateSync(buf.subarray(at, at + mid));
      ok = data.equals(expected);
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly count: number;
}

/**
 * Read a packfile into full objects. Delta entries (ofs- and ref-) are
 * resolved against bases in the pack or, for a thin pack, via `resolveBase`.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');

  interface Pending {
    readonly type: GitObjectType;
    readonly data: Buffer;
    readonly offset: number;
  }
  const byOffset = new Map<number, Pending>();
  const result = new Map<string, GitObject>();
  const deltas: Array<{ offset: number; kind: 'ofs' | 'ref'; baseOffset: number; baseOid: string; delta: Buffer }> = [];

  let at = 12;
  for (let i = 0; i < count; i++) {
    const start = at;
    let byte = pack[at++];
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // ofs-delta: negative offset back to the base entry
      let b = pack[at++];
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[at++];
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      const inflated = inflateOne(pack, at);
      at = inflated.next;
      deltas.push({ offset: start, kind: 'ofs', baseOffset: start - baseOffset, baseOid: '', delta: inflated.data });
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
      const inflated = inflateOne(pack, at);
      at = inflated.next;
      deltas.push({ offset: start, kind: 'ref', baseOffset: 0, baseOid, delta: inflated.data });
    } else {
      const type = CODE_TYPES[typeCode];
      if (!type) throw new Error(`pack object type ${typeCode}`);
      const inflated = inflateOne(pack, at);
      at = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      byOffset.set(start, { type, data: inflated.data });
      result.set(objectId(type, inflated.data), { type, data: inflated.data });
    }
  }

  // Resolve deltas, possibly in chains, until none are left.
  let pending = deltas;
  while (pending.length) {
    const rest: typeof pending = [];
    let progressed = false;
    for (const delta of pending) {
      let base: GitObject | undefined;
      if (delta.kind === 'ofs') {
        const found = byOffset.get(delta.baseOffset);
        if (found) base = { type: found.type, data: found.data };
      } else {
        base = result.get(delta.baseOid) ?? resolveBase?.(delta.baseOid);
      }
      if (!base) {
        rest.push(delta);
        continue;
      }
      const data = applyDelta(base.data, delta.delta);
      byOffset.set(delta.offset, { type: base.type, data });
      result.set(objectId(base.type, data), { type: base.type, data });
      progressed = true;
    }
    if (!progressed) throw new Error('pack delta base is missing (thin pack without its base)');
    pending = rest;
  }

  return { objects: result, count };
}

/** Write a packfile of plain objects (no deltas), as the suite's client does. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const code = TYPE_CODES[obj.type];
    let size = obj.data.length;
    const first = (code << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [];
    if (size > 0) {
      headBytes.push(first | 0x80);
      while (size > 0) {
        let b = size & 0x7f;
        size >>= 7;
        if (size > 0) b |= 0x80;
        headBytes.push(b);
      }
    } else {
      headBytes.push(first);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ------------------------------------------------------------------ pkt-line

/** Encode one pkt-line payload (a Buffer, or 'flush' / 'delim'). */
export function pktLine(payload: Buffer | 'flush' | 'delim'): Buffer {
  if (payload === 'flush') return Buffer.from('0000', 'ascii');
  if (payload === 'delim') return Buffer.from('0001', 'ascii');
  const length = payload.length + 4;
  const head = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(head, 'ascii'), payload]);
}

export function pktText(text: string): Buffer {
  return pktLine(Buffer.from(text, 'utf8'));
}

export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' };

/** Parse a complete pkt-line stream (request bodies arrive whole). */
export function parsePktLines(buf: Buffer): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const head = buf.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      break; // a flush ends the framed part; the rest is raw (a pack)
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      at += 4; // response-end packet: no payload, stream continues no further
      break;
    }
    if (at + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, rest: buf.subarray(at) };
}
