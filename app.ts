// The forge's HTTP server: one process serving git smart HTTP,
// REST v3, GraphQL v4 and MCP from the same in-memory store.
//
// Written for github-core-clone-01. main.ts owns the entry <-> env
// lifecycle (register the port, poll for done); this file is the whole
// product surface the suite drives. Every reply is JSON (never HTML),
// every API reply carries an X-GitHub-Request-Id, and every surface
// but the health probe requires the trial's bearer token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, type RepoState } from './store.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import {
  handleCreateComment,
  handleCreateIssue,
  handleCreateLabel,
  handleCreatePull,
  handleCreateRef,
  handleCreateRepo,
  handleDeleteContents,
  handleGetContents,
  handleListBranches,
  handleListComments,
  handleListIssues,
  handleListLabels,
  handleListPulls,
  handleListCommits,
  handleMergePull,
  handleMeta,
  handlePatchIssue,
  handlePatchRepo,
  handlePutContents,
  handleRoot,
  handleUserRepos,
  issueShape,
  pullFiles,
  pullShape,
  repoShape,
  userShape,
  type RestResult,
} from './rest.ts';
import { executeGraphQL, type GraphQLRequest } from './graphql.ts';
import { handleMcpMessage } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export interface AppOptions {
  /** The bearer token every surface but /healthz requires (MAKEFUN_SHOP_TOKEN). */
  readonly token?: string;
}

export function createApp(options: AppOptions = {}): Server {
  const forge = new Forge(process.env.MAKEFUN_TRIAL_NOW ?? null);
  const token = options.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
    requestCounter += 1;
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'x-github-request-id': `F0RGE-${requestCounter.toString(16).padStart(8, '0')}`,
      ...(text ? { 'content-length': Buffer.byteLength(text) } : {}),
      ...headers,
    });
    res.end(text);
  }

  /** Send a pre-serialized JSON body: no stringify, no re-encode on write. */
  function sendBuffer(res: ServerResponse, status: number, body: Buffer): void {
    requestCounter += 1;
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'x-github-request-id': `F0RGE-${requestCounter.toString(16).padStart(8, '0')}`,
      'content-length': body.length,
    });
    res.end(body);
  }

  function sendResult(res: ServerResponse, result: RestResult): void {
    if (result.status === 204) {
      requestCounter += 1;
      res.writeHead(204, { 'x-github-request-id': `F0RGE-${requestCounter.toString(16).padStart(8, '0')}` });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, result.headers ? { ...result.headers } : {});
  }

  function authorized(req: IncomingMessage): boolean {
    if (!token) return true;
    return req.headers.authorization === `Bearer ${token}`;
  }

  /**
   * Read a whole request body. The event form replaces an async
   * iterator: same bytes, same failure surface (a dead request rejects
   * instead of throwing out of the iterator), measurably less stream
   * machinery per request.
   */
  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
      req.on('close', () => reject(new Error('request closed before its body ended')));
    });
  }

  /** Parse a JSON body; on failure answer 400 and return undefined. */
  function parseJsonBody(res: ServerResponse, raw: Buffer): Record<string, unknown> | unknown[] | undefined {
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as unknown;
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      return {};
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return undefined;
    }
  }

  function repoFor(res: ServerResponse, owner: string, name: string): RepoState | null {
    if (!forge.resolveOwner(owner)) {
      sendJson(res, 404, { message: 'Not Found' });
      return null;
    }
    const repo = forge.repoByName(name);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return null;
    }
    return repo;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://entry');
    const path = url.pathname;
    const segments = path.split('/').filter((s) => s.length > 0).map((s) => decodeURIComponent(s));

    // The env's boot probe: no token, called twice.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }

    // ---------------- GraphQL ----------------
    if (path === '/api/graphql') {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const parsed = parseJsonBody(res, await readBody(req));
      if (parsed === undefined) return;
      if (Array.isArray(parsed)) {
        const results = parsed.map((item) => executeGraphQL(forge, item as GraphQLRequest));
        sendJson(res, 200, results);
        return;
      }
      const result = executeGraphQL(forge, parsed as unknown as GraphQLRequest);
      sendJson(res, 200, result);
      return;
    }

    // ---------------- MCP ----------------
    if (path === '/mcp') {
      if (method !== 'POST') {
        sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'method not allowed' } });
        return;
      }
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      if (Array.isArray(parsed)) {
        const replies = parsed
          .map((item) => handleMcpMessage(forge, item as Record<string, unknown>))
          .filter((reply) => reply.body !== null)
          .map((reply) => reply.body);
        sendJson(res, 200, replies);
        return;
      }
      const reply = handleMcpMessage(forge, parsed as Record<string, unknown>);
      if (reply.body === null) {
        res.writeHead(202, { 'x-github-request-id': 'F0RGE-NOTIFY' });
        res.end();
        return;
      }
      sendJson(res, reply.status, reply.body);
      return;
    }

    // ---------------- REST v3 ----------------
    if (segments[0] === 'api' && segments[1] === 'v3') {
      await routeRest(req, res, method, segments.slice(2), url.searchParams, url);
      return;
    }

    // ---------------- git smart HTTP ----------------
    if (segments.length >= 2 && segments[1].endsWith('.git')) {
      const owner = segments[0];
      const name = segments[1].slice(0, -'.git'.length);
      if (!forge.resolveOwner(owner)) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const repo = forge.repoByName(name) ?? null;
      const tail = segments.slice(2).join('/');
      if (method === 'GET' && tail === 'info/refs') {
        const service = url.searchParams.get('service') ?? '';
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
        const reply = infoRefs(repo, service, version2);
        requestCounter += 1;
        res.writeHead(reply.status, {
          'content-type': reply.type,
          'cache-control': 'no-cache, max-age=0, must-revalidate',
          'x-github-request-id': `F0RGE-${requestCounter.toString(16).padStart(8, '0')}`,
        });
        res.end(reply.body);
        return;
      }
      if (method === 'POST' && (tail === 'git-upload-pack' || tail === 'git-receive-pack')) {
        if (!repo) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const body = await readBody(req);
        const version2 = (req.headers['git-protocol'] ?? '').includes('version=2');
        const replyBody = tail === 'git-upload-pack' ? uploadPack(repo, body, version2) : receivePack(repo, body);
        requestCounter += 1;
        res.writeHead(200, {
          'content-type': `application/x-${tail}-result`,
          'x-github-request-id': `F0RGE-${requestCounter.toString(16).padStart(8, '0')}`,
        });
        res.end(replyBody);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  async function routeRest(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    segments: string[],
    query: URLSearchParams,
    url: URL,
  ): Promise<void> {
    const jsonBody = async (): Promise<Record<string, unknown> | undefined> => {
      const parsed = parseJsonBody(res, await readBody(req));
      if (parsed === undefined) return undefined;
      return Array.isArray(parsed) ? {} : parsed;
    };

    if (segments.length === 0) {
      if (method === 'GET') return sendResult(res, handleRoot());
      return sendJson(res, 404, { message: 'Not Found' });
    }
    if (segments[0] === 'meta' && segments.length === 1) {
      if (method === 'GET') return sendResult(res, handleMeta());
      return sendJson(res, 404, { message: 'Not Found' });
    }
    if (segments[0] === 'user' && segments.length === 1) {
      if (method === 'GET') return sendJson(res, 200, userShape(forge));
      return sendJson(res, 404, { message: 'Not Found' });
    }
    if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
      if (method === 'GET') {
        const base = `http://${req.headers.host ?? url.host}`;
        return sendResult(res, handleUserRepos(forge, query, base));
      }
      if (method === 'POST') {
        const body = await jsonBody();
        if (body === undefined) return;
        return sendResult(res, handleCreateRepo(forge, body));
      }
      return sendJson(res, 404, { message: 'Not Found' });
    }

    if (segments[0] === 'repos' && segments.length >= 3) {
      const owner = segments[1];
      const name = segments[2];
      const rest = segments.slice(3);

      if (rest.length === 0) {
        if (method === 'GET') {
          const repo = repoFor(res, owner, name);
          if (repo) sendJson(res, 200, repoShape(forge, repo));
          return;
        }
        if (method === 'PATCH') {
          const repo = repoFor(res, owner, name);
          if (!repo) return;
          const body = await jsonBody();
          if (body === undefined) return;
          return sendResult(res, handlePatchRepo(forge, repo, body));
        }
        if (method === 'DELETE') {
          if (!forge.resolveOwner(owner) || !forge.deleteRepo(name)) {
            return sendJson(res, 404, { message: 'Not Found' });
          }
          return sendResult(res, { status: 204 });
        }
        return sendJson(res, 404, { message: 'Not Found' });
      }

      const repo = repoFor(res, owner, name);
      if (!repo) return;

      if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
        return sendResult(res, handleListBranches(forge, repo));
      }
      if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
        const body = await jsonBody();
        if (body === undefined) return;
        return sendResult(res, handleCreateRef(forge, repo, body));
      }
      if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
        return sendResult(res, handleListCommits(forge, repo, query));
      }
      if (rest[0] === 'contents') {
        const contentPath = rest.slice(1).join('/');
        if (method === 'GET') return sendResult(res, handleGetContents(forge, repo, contentPath, query));
        if (method === 'PUT') {
          const body = await jsonBody();
          if (body === undefined) return;
          return sendResult(res, handlePutContents(forge, repo, contentPath, body));
        }
        if (method === 'DELETE') {
          const body = await jsonBody();
          if (body === undefined) return;
          return sendResult(res, handleDeleteContents(forge, repo, contentPath, body));
        }
        return sendJson(res, 404, { message: 'Not Found' });
      }
      if (rest[0] === 'labels' && rest.length === 1) {
        if (method === 'GET') return sendResult(res, handleListLabels(forge, repo));
        if (method === 'POST') {
          const body = await jsonBody();
          if (body === undefined) return;
          return sendResult(res, handleCreateLabel(forge, repo, body));
        }
        return sendJson(res, 404, { message: 'Not Found' });
      }
      if (rest[0] === 'issues') {
        if (rest.length === 1) {
          if (method === 'GET') return sendResult(res, handleListIssues(forge, repo, query));
          if (method === 'POST') {
            const body = await jsonBody();
            if (body === undefined) return;
            return sendResult(res, handleCreateIssue(forge, repo, body));
          }
          return sendJson(res, 404, { message: 'Not Found' });
        }
        const number = parseInt(rest[1], 10);
        if (rest.length === 2 && method === 'GET') {
          const issue = repo.issues.get(number);
          if (issue) {
            // Serve the serialized body while nothing the shape reads
            // has moved: every issue mutation bumps updatedAt, comments
            // only change the count, labels are immutable once created.
            const fp = `${forge.viewerLogin}|${issue.updatedAt}|${issue.state}|${(repo.comments.get(number) ?? []).length}`;
            const hit = repo.issueJsonCache.get(number);
            if (hit && hit.fp === fp) return sendBuffer(res, 200, hit.body);
            const body = Buffer.from(`${JSON.stringify(issueShape(forge, repo, issue))}\n`, 'utf8');
            repo.issueJsonCache.set(number, { fp, body });
            return sendBuffer(res, 200, body);
          }
          const pull = repo.pulls.get(number);
          if (pull) {
            const shape = issueShape(forge, repo, {
              id: pull.id,
              number: pull.number,
              title: pull.title,
              body: pull.body,
              state: pull.state,
              labels: [],
              createdAt: pull.createdAt,
              updatedAt: pull.updatedAt,
              closedAt: pull.mergedAt,
              isPull: true,
            });
            shape.pull_request = { url: `/api/v3/repos/${forge.viewerLogin}/${repo.name}/pulls/${pull.number}` };
            return sendJson(res, 200, shape);
          }
          return sendJson(res, 404, { message: 'Not Found' });
        }
        if (rest.length === 2 && method === 'PATCH') {
          const body = await jsonBody();
          if (body === undefined) return;
          return sendResult(res, handlePatchIssue(forge, repo, number, body));
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (method === 'GET') return sendResult(res, handleListComments(forge, repo, number));
          if (method === 'POST') {
            const body = await jsonBody();
            if (body === undefined) return;
            return sendResult(res, handleCreateComment(forge, repo, number, body));
          }
        }
        return sendJson(res, 404, { message: 'Not Found' });
      }
      if (rest[0] === 'pulls') {
        if (rest.length === 1) {
          if (method === 'GET') return sendResult(res, handleListPulls(forge, repo, query));
          if (method === 'POST') {
            const body = await jsonBody();
            if (body === undefined) return;
            return sendResult(res, handleCreatePull(forge, repo, body));
          }
          return sendJson(res, 404, { message: 'Not Found' });
        }
        const number = parseInt(rest[1], 10);
        if (rest.length === 2 && method === 'GET') {
          const pull = repo.pulls.get(number);
          if (!pull) return sendJson(res, 404, { message: 'Not Found' });
          return sendJson(res, 200, pullShape(forge, repo, pull));
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          const pull = repo.pulls.get(number);
          if (!pull) return sendJson(res, 404, { message: 'Not Found' });
          return sendJson(res, 200, pullFiles(repo, pull));
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          const body = await jsonBody();
          if (body === undefined) return;
          return sendResult(res, handleMergePull(forge, repo, number, body));
        }
        return sendJson(res, 404, { message: 'Not Found' });
      }
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  const server = createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  return server;
}
