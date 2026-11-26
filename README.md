<!--
SPDX-FileCopyrightText: 2026 Curtis Galloway
SPDX-License-Identifier: Apache-2.0
-->

# memory-mcp

One shared memory for claude.ai, Claude Code, ChatGPT and other MCP clients. Memories
are Markdown files in a git repository hosted on Cloudflare Artifacts. A Cloudflare
Worker serves them as a remote MCP server with GitHub sign-in. Every change is a git
commit that names the client that made it, and a small job can keep a full copy on a
machine you own.

It is built for one person: sign-in accepts exactly one GitHub account.

**Terms** (full list in [GLOSSARY.md](GLOSSARY.md)):

- **MCP server** — a service that offers tools to an AI client. *Remote* means it runs
  on the internet, so every client you use can reach the same one.
- **Worker** — a small program Cloudflare runs for each HTTP request.
- **Artifacts** — Cloudflare's hosted git repositories (open beta as of 2026-11).
- **KV namespace** — a small Cloudflare key-value store; this server keeps sign-in
  records in one.
- **OAuth app** (GitHub) — a registration that lets this server ask GitHub who is
  signing in.
- **Environment** — one deployed copy of the server, described by a values file
  `deploy/<name>.json`.

## What a client gets

Seven tools: `memory_context` (profile, preferences and a catalog, for the start of a
conversation), `memory_search`, `memory_read`, `memory_write`, `memory_list`,
`memory_history` and `memory_delete`. Writes are checked: a stale write is refused
rather than overwriting, a near-duplicate note is reported instead of created, and text
that looks like a credential is refused. [docs/design.md](docs/design.md) has the
details.

## What you need

- A Cloudflare account on the Workers Paid plan (Artifacts requires it). Normal
  personal use stays inside the included 10,000 Artifacts operations a month.
- A GitHub account, for sign-in.
- Node.js 22 or newer.

## Deploy your own

About 20 minutes. The steps use the environment name `production`; any name works.

1. Get the code and sign in to Cloudflare.

   ```bash
   git clone https://github.com/curtisgalloway/memory-mcp.git
   cd memory-mcp
   npm ci
   npx wrangler login
   ```

2. Create the notes repo and the KV namespace. The first command prints a repo token;
   you do not need it, so do not save it. The second prints the namespace `id` you need
   in step 5.

   ```bash
   npx wrangler artifacts repos create memory --namespace memory
   npx wrangler kv namespace create memory-mcp-oauth
   ```

3. Find your Worker's address. It will be
   `https://memory-mcp.<your-subdomain>.workers.dev`; your subdomain is shown in the
   Cloudflare dashboard under Workers & Pages.

4. Create a GitHub OAuth app at <https://github.com/settings/developers> ("New OAuth
   App"). Set **Homepage URL** to the Worker's address and **Authorization callback
   URL** to that address followed by `/callback`. Note the **Client ID**, then generate
   a **client secret** and keep it for step 7.

5. Write the values file. Copy the example, then replace the four `REPLACE-WITH-...`
   values in `deploy/production.json`: the address followed by `/mcp`, the KV namespace
   id, the OAuth app's client ID, and your numeric GitHub account ID. The last command
   prints that ID if you use the GitHub CLI. Files in `deploy/` stay out of git.

   ```bash
   cp deploy/example.json deploy/production.json
   gh api user --jq .id
   ```

6. Deploy. This checks the values, writes `wrangler.production.jsonc`, and uploads the
   Worker.

   ```bash
   npm run deploy -- production
   ```

7. Store the OAuth app's client secret. The command asks for it; paste the secret from
   step 4.

   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.production.jsonc
   ```

8. Check that the server is up and refuses strangers. Replace the address with yours;
   the expected answer is HTTP 401.

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://memory-mcp.YOUR-SUBDOMAIN.workers.dev/mcp
   ```

## Connect your clients

The server's MCP address is your Worker's address followed by `/mcp`. Each client
registers itself and sends you through GitHub sign-in once.

- **claude.ai:** Settings → Connectors → add a custom connector with the MCP address.
- **Claude Code:**

  ```bash
  claude mcp add --transport http --scope user memory https://memory-mcp.YOUR-SUBDOMAIN.workers.dev/mcp
  ```

- **ChatGPT and other clients:** add the MCP address wherever the client accepts a
  remote MCP server that uses OAuth.

Every connected client can read every note, so connecting a client shares the store
with that client's vendor.

## Keep your own copy

[`archive/`](archive/) is a small job for a Linux machine you own. It fetches the notes
repo every 15 minutes with a read-only token and never rewrites what it already holds.
Its [README](archive/README.md) has the install steps.

You can also clone the notes repo and edit notes with ordinary git, using a write
token; the server notices the push and updates its search index.

## Operating it

Each script takes `--env <name>` (reads `deploy/<name>.json`) or `--url <address>`, and
signs in through your browser the first time.

| Command | What it does |
|---|---|
| `node scripts/live-checks.mjs --env staging` | Checks the write rules against a deployed server. It writes and deletes test notes, so it is meant for a test environment; any environment not named `staging` needs `--writes` |
| `node scripts/timing.mjs --env staging` | Times each tool over 50 calls; the same `--writes` rule applies to its write and delete timings |
| `node scripts/reindex.mjs --env production` | Brings the search index in line with the repo; `--full` rebuilds it |
| `node scripts/operations.mjs --env production --days 30` | Counts billed Artifacts operations |

A second values file, such as `deploy/staging.json` with its own Worker name, notes
repo, KV namespace and OAuth app, gives you a separate copy to test against.

## Develop

```bash
npm ci
npm run check
npm test
uv run --with pytest pytest archive
```

`npm run dev` starts the Worker locally. Tests run in Cloudflare's local simulator and
need no account.

## Documents

- [Design](docs/design.md) — requirements, architecture and the reasons behind them
- [Glossary](GLOSSARY.md) — terms from Cloudflare, MCP and OAuth in plain language
- [Archive job](archive/README.md)

## License

Apache 2.0; see [LICENSE](LICENSE).
