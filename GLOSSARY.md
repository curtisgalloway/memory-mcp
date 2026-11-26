<!--
SPDX-FileCopyrightText: 2026 Curtis Galloway
SPDX-License-Identifier: Apache-2.0
-->

# Glossary

Plain-language meanings of the borrowed and coined terms used in this repo.

| Term | Meaning |
|---|---|
| **MCP** (Model Context Protocol) | A standard way for an AI client to call tools a server offers. |
| **MCP server, remote** | An MCP server reached over HTTPS on the internet, rather than started on the same machine as the client. |
| **Connector** (claude.ai) | claude.ai's name for a remote MCP server the user has added in settings. |
| **Tool** | One function the MCP server offers, such as `memory_search`. |
| **Note** | One memory: a Markdown file in the memory repo. |
| **Worker** (Cloudflare) | A small program Cloudflare runs on its servers for each HTTP request. No disk, no `git` program. |
| **Binding** (Cloudflare) | A handle the Worker receives to another Cloudflare product, such as `env.ARTIFACTS`. |
| **Artifacts** (Cloudflare) | Cloudflare's hosted git repositories, reachable from a Worker binding and from ordinary git clients. Open beta as of 2026-11. |
| **Namespace** (Artifacts) | A group of Artifacts repos. A Worker's binding names one namespace and opens repos by name within it. A namespace comes into being when the first repo is created under its name. Not related to Kubernetes or code namespaces. |
| **Repo token** (Artifacts) | A password for one repo, either `read` (clone and fetch) or `write` (also push), with an expiry from 60 seconds to one year. |
| **Durable Object** (Cloudflare) | A single named instance with its own SQLite database. It runs one piece of code at a time, but a call that is waiting on the network lets another call start, so on its own it is a lock only for its database. |
| **MemoryStore** | This project's Durable Object: it serializes writes through its write queue and holds the index. |
| **Write queue** | The line MemoryStore keeps so that one write, delete or reindex finishes before the next begins. |
| **isomorphic-git** | Git written in JavaScript. Used here because a Worker has no `git` program. |
| **MemoryFS** | An in-memory filesystem that isomorphic-git writes to inside a Worker. |
| **FTS5** | SQLite's built-in full-text search. |
| **Index** (this project) | The SQLite tables in MemoryStore listing every note, its text, and who last changed it and when. Search, listing and the context call read it. A cache; the repo is the truth. |
| **Reindex** | Bringing the index in line with the repo: the store lists the notes on `main`, compares each one's version with its row, and reads only the notes that differ. A *full* reindex empties the index first. |
| **Indexed commit** | The commit on `main` that the index was last brought in line with. When `main` is at any other commit, the index may be missing something. |
| **Push event** (`cf.artifacts.repo.pushed`) | The message Artifacts sends after every push to a repo, naming the branch and the new commit. It is how the store learns of a push it did not make. |
| **Event trigger** (Cloudflare) | A line of configuration saying "when this event happens, start that Workflow". Events reach a Worker only this way or through a queue. |
| **Workflow** (Cloudflare) | A job the platform starts and retries on its own, written as a class with a `run` method. Used here for one thing: `OnRepoPushed` receives the push event and hands it to MemoryStore. Not related to a git workflow or a GitHub Actions workflow. |
| **Direct push** | A change made to the notes repo with an ordinary git client and a write token, not through the server's tools. |
| **Admin reindex route** | `POST /mcp/admin/reindex`: asks the store to reindex, for recovery. It needs the same grant as the tools. Add `?full=1` to empty the index first. |
| **Context call** | `memory_context`: the one call a model makes at the start of a conversation. |
| **Pinned folders** | `profile/` and `preferences/`: the context call returns their notes in full. |
| **Catalog** | The list of all other notes (path, title, summary) in the context call's answer. When it would not fit under the size cap it becomes note counts by folder. |
| **Snippet** | The few words around a match that `memory_search` returns with each result. |
| **Stemming** | Treating forms of a word as the same word when searching, so "reviewing" finds "reviews". |
| **`duplicates`** | The answer to a create when an existing note has the same title or the same opening sentence. Nothing was written; the answer lists the existing notes (the *candidates*). |
| **`force`** | An input of `memory_write`: create the note even though it looks like a duplicate. |
| **Symlink** (symbolic link) | A git entry that points at another path instead of holding content. The server never follows one and never indexes one. |
| **Version** (this project) | A note's git blob SHA: a fingerprint of its exact content. |
| **`base_version`** | The version a writer last read. A write whose `base_version` is out of date is refused, so it cannot overwrite someone else's change. |
| **`conflict`** | The answer to a write or delete whose `base_version` is out of date (or that tries to create a note that already exists). Nothing was changed; read the note again and retry. |
| **`refused`** | The answer to a write that breaks a rule: a bad path, a path blocked by an existing file, a note over 64 KiB, or text matching a secret pattern. Nothing was changed, and retrying the same call will fail the same way. |
| **`retryable`** | The answer when the store could not reach the repo, or could not confirm whether a push arrived. The same call can be sent again safely: if the change did arrive, the repeat succeeds without making a second commit. |
| **Secret pattern** | A named shape of text that looks like a credential (an API key, a private-key block, a card number, a `password:` line). A write matching one is refused, and the refusal gives the pattern's name, never the matched text. |
| **OAuth** | The sign-in protocol MCP clients use: the user signs in once in a browser and the client receives a grant. |
| **Grant** (OAuth) | The permission a client holds after sign-in; it can be revoked. |
| **DCR** (dynamic client registration) | Part of OAuth: a client registers itself with the server automatically instead of the user creating credentials by hand. |
| **Upstream provider** (OAuth) | The service that actually checks who the user is. Here, GitHub. |
| **McpAgent** | A class in Cloudflare's `agents` library that runs one MCP session. |
| **`createMcpHandler`** / **stateless handler** | The replacement for McpAgent in the same library (McpAgent is deprecated). It answers each MCP request on its own, with no session kept between requests. This project uses it. |
| **Consent page** | The page this server shows before sending you to GitHub: it names the client asking for access and where the access will be sent, with Allow and Deny. It stops a client that registered itself from borrowing your GitHub session unseen. |
| **CIMD** (Client ID Metadata Document) | The newer way for an MCP client to identify itself: its client ID is a web address where its name and redirect addresses are published. Accepted alongside DCR. |
| **Environment** (this project) | One deployed copy of the server, described by a values file `deploy/<name>.json`. Each has its own Worker, Durable Object, sign-in records, Workflow and notes repo. A second environment (often called *staging*) is a place to test without touching real notes. |
| **KV namespace** (Cloudflare) | A small key-value store. This server keeps its sign-in records (grants and registered clients) in one; each environment has its own. |
| **Operation** (Artifacts) | The unit Artifacts bills by. A pull (a clone or a fetch), a push, and creating, forking or deleting a repo are one each; reading files, trees, commits or logs through the binding is billed at 100 reads to one operation. 10,000 a month are included. |
| **Subrequest** (Cloudflare) | One call a Worker makes to another service while answering a request. The paid plan allows 10,000 for one request. |
| **`_meta`** (MCP) | The part of a tool's answer that carries data about the call itself, for the program that made it and not for the model. This server puts one number there, `memory-mcp/worker_ms`: how long the Worker took. |
| **Timing run** | 50 calls to each tool against a deployed server, to check requirement R8's limits (`scripts/timing.mjs`). |
| **`workers.dev`** | The free subdomain Cloudflare gives each deployed Worker. |
| **Archive** (this project) | A full git clone of the notes repo on a machine you own, updated on a timer. See [`archive/`](archive/). |
| **Archive job** | The program the archive machine runs every 15 minutes: it fetches the notes repo with a read-only repo token, moves the clone forward, and can publish metrics. |
| **systemd timer / unit** | systemd is the service manager on Linux. A *unit* is a file describing one job or service; a *timer* is a unit that starts another on a schedule. |
| **Metric** | A number a program publishes for a monitoring system, such as the time of the archive job's last success. |
| **Alert rule** | A condition on metrics, checked on a schedule, that raises an alert when it holds for a set time. |
| **Fast-forward** (git) | Moving a branch to a newer commit that already contains the old one in its history. The archive job refuses any other kind of move, so a rewritten remote history cannot replace the archived one. |
