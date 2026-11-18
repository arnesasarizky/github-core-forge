# Forge — a GitHub-compatible git forge in one process

A standalone forge that serves, from one Node process and its own
in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol
  v2 (capability advertisement, `ls-refs`, `fetch` with shallow and
  deepen) plus the v0 fetch fallback, and receive-pack v0 with
  report-status over side-band-64k, fast-forward enforcement and
  per-ref ok/ng reporting;
- **REST v3** under `/api/v3` — repositories, branches, git refs,
  commits, contents (create/update/delete with commits), labels,
  issues, comments and pull requests including squash and merge
  merges with real three-way tree merges and conflict detection;
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  github-mcp-server send: viewer, repository reads, issue and
  pull-request connections with cursor pagination, the `__type`
  feature-detection probes, and the create/close/merge/comment
  mutations, with Relay-style global ids that match the REST node ids;
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP in both the
  2026-07-28 (`server/discover`) and initialize-handshake eras, with
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request` and `merge_pull_request` acting on the same
  store as every other surface.

Standard library only — `node:http`, `node:crypto`, `node:zlib`. The
git object model, packfile reader/writer (with ofs/ref delta
resolution), pkt-line framing and the GraphQL parser are all
implemented here from the protocols' specifications.

`main.ts` is the harness lifecycle: bind an ephemeral port, register
it with `$MAKEFUN_ENV_URL/register`, poll `$MAKEFUN_ENV_URL/done`,
exit 0. State is deterministic — timestamps come from a logical clock
seeded by the trial's `MAKEFUN_TRIAL_NOW` — so a replayed trial
produces byte-identical exports.

Layout: `git.ts` (objects, packs, pkt-lines), `store.ts` (state),
`githttp.ts` (smart HTTP), `rest.ts` (REST v3 + merges),
`graphql.ts` (GraphQL), `mcp.ts` (MCP), `app.ts` (the HTTP server).
