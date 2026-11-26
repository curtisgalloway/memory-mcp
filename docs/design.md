<!--
SPDX-FileCopyrightText: 2026 Curtis Galloway
SPDX-License-Identifier: Apache-2.0
-->

# memory-mcp — Design

This document describes the server as built: what it must do, how it does it, and why
each main choice was made.

**Terms** (full list in [GLOSSARY.md](../GLOSSARY.md)):

- **MCP server** — a service that offers tools (functions) to an AI client such as
  claude.ai or Claude Code. *Remote* means it runs on the internet, not on your machine.
- **Worker** — a small program Cloudflare runs on its servers for each HTTP request.
- **Binding** — a handle the Worker gets to another Cloudflare product, here
  `env.ARTIFACTS`.
- **Artifacts** — Cloudflare's hosted git repositories. **Repo token** — a password for
  one repo, `read` (clone and fetch only) or `write` (push too), with an expiry.
- **Durable Object** — a single long-lived instance with its own small SQLite database.
- **Workflow** — a job Cloudflare starts and retries on its own.
- **isomorphic-git** — git written in JavaScript, used because a Worker has no `git`
  program and no disk.
- **FTS5** — SQLite's built-in full-text search.
- **OAuth grant** — the permission a client receives after you sign in once in a browser.

## Goal and non-goals

**Goal.** One memory store that every AI client one person uses can read and write:
claude.ai, Claude Code on any machine, ChatGPT, and other MCP clients. Each memory is a
Markdown file in a git repo, so every change has an author, a date and a diff, and the
whole store with its history can be copied to a machine you own.

**Observable outcomes.**

- In claude.ai, you add the server as a connector, sign in once, and the model can
  search, read, write and list memories.
- Claude Code on another machine sees the same memory seconds later.
- `git log` on a clone shows which client wrote each change.

**Non-goals.**

- More than one person. Sign-in allows exactly one GitHub account.
- Replacing a client's built-in memory. This store sits beside it.
- Semantic or vector search. Full-text search is enough at this size (about 100 to a
  few thousand notes).
- A web UI for browsing. A clone and any git tool serve that purpose.
- Attachments or binary files. Notes are Markdown text only.

## Prior art

The closest existing project is [memshare](https://github.com/gaw008/memshare) (MIT
license): a self-hosted Python server with the same shape, git-committed Markdown, OAuth
for chat apps and an FTS5 index. It needs a server you run; this design needs none.

This design borrows four of memshare's ideas, credited where they appear below: a
start-of-conversation context tool, a duplicate check before creating a note,
server-side blocking of secrets, and tool descriptions written as instructions to the
model. No memshare code is copied.

## Platform facts the design rests on

From Cloudflare's documentation and from measurements against live Artifacts (2026-11):

- The Artifacts binding reads (`readFile`, `readTree`, `readBlob`, `readCommit`, `log`)
  but has no method that writes a file. Writes go through a git client.
- Limits: 32 MiB per file, 64 MiB per push, 1 GB per repo, 2,000 git requests per 10
  seconds per repo.
- Pricing: Workers Paid only; 10,000 operations per month included, then $0.15 per
  1,000; 1 GB-month of storage included. A pull (a clone or a fetch) and a push are one
  operation each, so a write is two. Reading files, trees, commits and logs through the
  binding is billed at 100 reads to one operation.
- Artifacts publishes a `cf.artifacts.repo.pushed` event after each push. An event
  reaches a Worker only by starting a Workflow or through a queue.
- Cloudflare's example in-memory filesystem does not work with isomorphic-git 1.44.17
  as published: it lacks `readlink` and `symlink`, and its errors carry no `code`, so
  `git.init` fails. `src/memory-fs.ts` has both fixes.
- A Durable Object does not hold other calls back while one waits on the network. On
  its own it is a lock only for its database.

## Requirements

- **R0 Shared between clients.** A note written from one client can be found and read
  from another, in both directions, within a minute.
- **R1 Tools.** The server offers `memory_context`, `memory_search`, `memory_read`,
  `memory_write`, `memory_list`, `memory_history` and `memory_delete`.
- **R2 Sign-in.** Only the owner can obtain a grant. Sign-in goes through GitHub, and
  the server accepts exactly one GitHub account ID. A second account is refused at the
  callback; an unauthenticated MCP request gets 401.
- **R3 Git is the truth.** Every write or delete is one commit in the notes repo. The
  commit author names the client (for example `claude.ai`, `claude-code`).
- **R4 No lost updates.** Writes are serialized, and a write that names an outdated
  base version is refused. Two concurrent writes to one note with the same base produce
  one commit and one `conflict`.
- **R5 Search.** `memory_search` does full-text search over path, title, tags and body,
  and returns ranked paths with snippets.
- **R6 Index is a cache.** The search index can be rebuilt from the repo at any time,
  and is brought up to date automatically when a push arrives that this server did not
  make. A push from a git client is searchable within a minute.
- **R7 Layout.** Notes live in topic folders (`projects/`, `people/`, `preferences/`,
  and so on; the writer picks the folder). Paths are lowercase, `[a-z0-9-/]`, end in
  `.md`, have at least one folder and at most three. A note is at most 64 KiB. A
  refusal says which rule failed.
- **R8 Speed.** Measured at the Worker: `memory_read` median under 300 ms,
  `memory_write` median under 2 s, `memory_search` and `memory_context` median under
  200 ms, over 50 calls each.
- **R9 Archive.** A machine you own can keep a full clone with history, updated every
  15 minutes with a read token, and report when a pull fails or the token nears expiry.
  See [`archive/`](../archive/).
- **R10 Cost.** Normal use stays inside the included 10,000 operations per month.
- **R11 No duplicate notes** (from memshare). Creating a note whose title or opening
  sentence equals an existing note's returns the matches instead of writing, unless
  the call says `force: true`.
- **R12 No secrets stored** (from memshare). A write containing text that matches a
  secret pattern (API keys, private-key blocks, card numbers, `password:` lines) is
  refused, and the refusal names the pattern, not the matched text.

## Architecture

```
MCP client ──MCP over HTTPS──▶ Worker
                               ├─ OAuth provider   (sign-in, grants; GitHub upstream)
                               ├─ MCP handler      (stateless; tool dispatch)
                               │     ├─ read, history ──▶ env.ARTIFACTS.readFile / log
                               │     └─ context, search, list, write, delete ──▶ MemoryStore
                               └─ OnRepoPushed     (Workflow: push event ──▶ MemoryStore)

MemoryStore (one Durable Object)
  ├─ SQLite: one row per note (path, version, title, tags, summary, text, author, date)
  │          plus an FTS5 table
  ├─ write queue: one write, delete or reindex at a time
  └─ write path: checks ─▶ shallow clone ─▶ edit ─▶ commit ─▶ push ─▶ update index

Artifacts notes repo ──read token, every 15 min──▶ your clone (the archive)
```

**Source layout.** `src/index.ts` (Worker entry, OAuth wiring), `src/auth.ts` (GitHub
sign-in), `src/html.ts` (the consent page), `src/mcp.ts` (tools and their descriptions),
`src/store.ts` (MemoryStore), `src/git.ts` (isomorphic-git write path),
`src/memory-fs.ts` (in-memory filesystem), `src/notes.ts` (path rules, frontmatter,
duplicate and secret checks, author labels), `src/reads.ts` and `src/context.ts` (read
tools), `src/tree.ts` (listing and comparing the repo's notes), `src/events.ts` (the Workflow), `src/admin.ts` (reindex route). Tests are in
`test/` and run in Cloudflare's local simulator.

### Notes

A note is Markdown with optional YAML frontmatter:

```markdown
---
title: Coffee order
summary: How I take my coffee
tags: [food]
---
Oat-milk flat white, no sugar ...
```

`title` defaults to the first `#` heading, then to the file name. `summary` defaults to
the first sentence of the body, cut to 120 characters. Other fields are kept but not
indexed.

Two folders are special (from memshare's `profile.md` and `preferences.md`):
`profile/` holds who you are and `preferences/` how you like answers. Both are returned
in full by `memory_context`.

### Tools

| Tool | Input | Output | Served by |
|---|---|---|---|
| `memory_context` | none | `notes`: every `profile/` and `preferences/` note in full; then `catalog` (path, title, summary of every other note) or, when that would not fit, `folders` with note counts. Capped at 8,000 characters. `not_included` lists a pinned note too large for the cap. | index |
| `memory_search` | `query`, optional `folder`, `limit` (default 10) | `results`: ranked `path`, `title`, `snippet` | index |
| `memory_read` | `path`, optional `ref` (commit) | `text`, `version` (blob SHA), `updated_at`, `author` | binding `readFile` |
| `memory_list` | optional `folder` | `notes` (at most 500) and `truncated` | index |
| `memory_history` | `path`, optional `limit` | commits: SHA, date, author, message | binding `log` |
| `memory_write` | `path`, `text`, `base_version` (absent means "must be new"), optional `message`, `force` | new `version` and commit SHA; or `conflict`, `duplicates`, `refused`, `retryable` | MemoryStore |
| `memory_delete` | `path`, `base_version`, optional `message` | commit SHA | MemoryStore |

`memory_context` is memshare's `get_context` idea: the one call a model makes at the
start of a conversation.

`memory_search` treats the query as plain words, finds notes holding any of them, ranks
a note holding more of them higher, and matches word forms ("reviewing" finds
"reviews").

Tool descriptions are written as instructions to the model, as memshare does: call
`memory_context` first; search before writing; pass the `version` you read as
`base_version`; store only lasting facts the person stated, not guesses or small talk.
R4 and R11 depend on models following these, and the server enforces both anyway.

Every tool answer carries the time the Worker took in its `_meta` (data about the call,
not text for the model) under `memory-mcp/worker_ms`. The timing run reads it there.

### Write flow (`memory_write`)

1. The Worker checks the path and size (R7) and the secret patterns (R12), then calls
   MemoryStore. A refusal returns before anything else happens.
2. MemoryStore puts the write in its queue, so writes cannot interleave.
3. For a new note without `force`, it compares the note with the index on two keys: the
   title and the opening sentence, each reduced to lowercase words. An existing note
   with an equal key is returned under `duplicates` and nothing is pushed (R11). A
   title that is only the file name, or an opening under 20 characters, is not compared.
4. It mints a 5-minute write token, shallow-clones the repo into memory, and compares
   `base_version` with the note in that clone. On a mismatch it returns `conflict` with
   the current version; nothing is pushed.
5. It writes the file, commits with the client's label as author, and pushes.
6. On a successful push it updates the index rows and returns the new version.

**Failures.** A rejected push (someone else pushed first) is retried once from a fresh
clone, which repeats the version check. After a network error during a push, the store
asks the binding whether its commit is on `main`; if it is, the write succeeded. When
it cannot tell, it answers `retryable`, and repeating the same call is safe: if the
change did arrive, the repeat succeeds without a second commit. No long-lived secret is
stored; every write token is minted on demand and expires in 5 minutes.

### Read flow

`memory_read` and `memory_history` call the binding from the Worker, not the Durable
Object, so reads never wait behind a write. Reads retry once, after 250 ms, on a
non-JSON or 5xx response.

### Index maintenance

- After every write MemoryStore updates its own rows.
- The index is built the first time it is needed.
- A `cf.artifacts.repo.pushed` event starts the `OnRepoPushed` Workflow, which hands
  the event to MemoryStore. If the pushed commit is not one the store made, it
  reindexes: it reads the tree, compares versions, and re-reads only changed notes. A
  reindex that must read more than 16 notes fetches them with one shallow clone
  instead of one binding call each.
- A write that finds `main` somewhere other than where the index left it reindexes at
  once, so the index does not depend on the event alone.
- `POST /mcp/admin/reindex` does the same on request, for recovery; `?full=1` empties
  the index first. It needs the same grant as the tools.
- A symlink in the repo is never followed, never indexed, and never replaced or deleted
  by the tools.

### Sign-in

`@cloudflare/workers-oauth-provider` handles OAuth for MCP clients, including dynamic
client registration, so a client registers itself and there are no static tokens to
manage. The server shows a consent page naming the client before it redirects to
GitHub, which stops a self-registered client from borrowing your GitHub session
unseen. On the callback the Worker compares the GitHub account ID to the configured
`ALLOWED_GITHUB_ID` and refuses any other. Grant and client records live in Workers KV.

A grant lasts 90 days and the clock restarts each time the client uses it, so a client
in regular use never asks again and an unused one lapses.

The commit author is a fixed label for known clients: `claude.ai` for the client that
registers as "Claude", `claude-code` for "Claude Code", `chatgpt` for "ChatGPT". Any
other client keeps the name it registered with.

### Archive

[`archive/`](../archive/) holds a small job for a Linux machine you own: a systemd
timer runs `git fetch` every 15 minutes with a read-only repo token and moves the local
branch only by fast-forward, so a rewritten remote history cannot replace the copy. It
can publish the time of its last success and the token's expiry as metrics, so a
failed pull or an expiring token can raise an alert.

### Environments

The tracked `wrangler.jsonc` describes local development and tests only. Each deployed
environment is described by a values file, `deploy/<name>.json`, that stays out of git.
Each environment is its own Worker with its own Durable Object, sign-in records,
Workflow and notes repo, so a second environment can serve as a place to test without
touching real notes.

## Key decisions

| Decision | Alternatives | Why |
|---|---|---|
| Artifacts git repo is the truth | D1 or Durable Object rows; R2 objects | History, authorship and a plain-git copy come free; the cost is under a second per write. |
| Whole-note files | memshare's one fact per line, with a source suffix per line | Notes hold context that a single line cannot; git already records who changed each line (`git blame`). |
| One Durable Object with a write queue serializes writes | Optimistic pushes from Workers with retry | Concurrent pushes would race; one instance holds both the queue and the index. |
| Shallow clone per write | Keep a working tree in the Durable Object between writes | A clone measured about 0.2 s. |
| Version check through `base_version` | Last writer wins | Agents overwrite each other's notes silently otherwise. |
| GitHub as sign-in provider, one account allowed | Cloudflare Access; a password page; static bearer tokens | claude.ai connectors need OAuth; there is no password to store. |
| Reads go straight to the binding | Serve note bodies from SQLite | Reads stay independent of the write queue and always show the repo. |
| Duplicate check is key equality | A search for close matches | Predictable, and cheap enough to run on every create. |
| TypeScript | JavaScript; Python Worker | isomorphic-git is JavaScript, and Workers run it natively. |

## Cross-cutting concerns

- **Security.** The server is on the public internet; every MCP route, including the
  admin reindex route, needs a grant. Client registration is open, as MCP clients
  require, but a registered client can do nothing until the one allowed GitHub account
  approves it. Logs record paths and timings, never note bodies or search queries. R12
  keeps the most damaging content out of git, where deleting it later would not remove
  it from history.
- **Privacy.** Notes may hold private facts. The Artifacts repo is private to your
  Cloudflare account. Every connected client reads every note, so connecting a client
  shares the store with that client's vendor.
- **Platform maturity.** Artifacts is in open beta as of 2026-11. The archive is the
  recovery path if the service changes or disappears: a full git repo that can be
  pushed anywhere.
- **Dependencies.** Exact versions are pinned.
- **Cost.** Expected use is tens of writes and a few hundred reads a day, well under
  10,000 operations a month. `scripts/operations.mjs` reports the actual count.

## Verification

- **Unit and integration tests** in Cloudflare's local simulator: path rules,
  frontmatter, secret patterns, duplicate matching, version conflicts, concurrent
  writes (R4), push failure handling, index update and reindex. `npm test`.
- **Live checks** against a deployed environment: `scripts/live-checks.mjs` and the
  timing run, `scripts/timing.mjs` (R8).
- **Client checks** (manual): add the connector in each client, sign in, write a note
  in one and find it from another, in both directions (R0); sign in with a second
  GitHub account and confirm the refusal (R2).
- **Archive check:** write a note and confirm it in the clone's `git log` within 15
  minutes (R9).

Medians measured at the Worker on the author's deployment, 2026-11-25, 50 calls each:
`memory_read` 136 ms, `memory_write` 858 ms, `memory_search` 14 ms, `memory_context`
13 ms, `memory_list` 14 ms, `memory_delete` 794 ms, `memory_history` 1,019 ms.

## Known risks

| Risk | Impact | Handling |
|---|---|---|
| Artifacts open beta changes its API | Rework | The compatibility date is pinned; the archive keeps the data safe. |
| A transient read failure from the binding | Wrong answer to the model | Reads retry once. |
| Secret patterns miss something or refuse ordinary text | A secret lands in git history, or a note cannot be saved | The list is short and specific; a refusal names the pattern, so a false match is easy to report. |
