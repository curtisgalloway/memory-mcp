// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// The one place notes are written, and the home of the index. A single
// MemoryStore instance (named "main") pushes every change, one at a time, and
// keeps a SQLite index of the notes for search, listing and the context call.
// The index is a cache: the repo is the truth, and reindex rebuilds it.
import { DurableObject } from "cloudflare:workers";
import {
	buildContext,
	isPinned,
	type CatalogEntry,
	type ContextAnswer,
	type PinnedNote,
} from "./context";
import {
	applyChange,
	readBlobs,
	type ApplyResult,
	type BulkBlobs,
	type Change,
	type HttpClient,
} from "./git";
import {
	checkNotePath,
	duplicateKeys,
	folderPrefix,
	ftsQuery,
	indexText,
	MAX_INDEXED_BLOB_BYTES,
	parseNote,
} from "./notes";
import { withRetry } from "./reads";
import { changedPaths, listNotes, TreeCache } from "./tree";

export interface DuplicateCandidate {
	path: string;
	title: string;
	summary: string;
}

export type StoreResult =
	| { ok: true; version: string | null; commit: string | null }
	| { ok: false; reason: "conflict"; current_version: string | null }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "blocked"; at: string }
	| { ok: false; reason: "duplicates"; candidates: DuplicateCandidate[] }
	| { ok: false; reason: "retryable" };

interface WriteArgs {
	path: string;
	text: string;
	baseVersion: string | null;
	author: string;
	message: string;
	/** Skips the duplicate check on a new note. */
	force?: boolean;
}

interface RemoveArgs {
	path: string;
	baseVersion: string;
	author: string;
	message: string;
}

export interface SearchHit {
	path: string;
	title: string;
	snippet: string;
}

export interface ListedNote {
	path: string;
	title: string;
	updated_at: string | null;
}

export interface ReindexResult {
	/**
	 * `ok`: the index now matches `head`. `current`: it already did. `behind`: the
	 * repo did not yet show a commit known to be on main, so nothing was done.
	 * `incomplete`: some notes could not be read; the next reindex tries again.
	 */
	state: "ok" | "current" | "behind" | "incomplete";
	/** The newest commit on main as the repo showed it; null for an empty repo. */
	head: string | null;
	/** False when the index already matched `head` and nothing was read. */
	ran: boolean;
	changed: number;
	removed: number;
	/** Notes left out of the index: the repo has no such blob, or the file is too large to be a note. */
	skipped: number;
	/** Notes whose read failed. Their rows are untouched and the index is not marked as matching `head`. */
	failed: number;
}

export interface PushedArgs {
	type?: unknown;
	repo?: unknown;
	ref?: unknown;
	after?: unknown;
}

export type PushedResult =
	| { action: "ignored"; why: "not_a_push" | "other_repo" | "other_ref" | "indexed" }
	| ({ action: "reindexed" } & ReindexResult)
	/** The index is not yet in line with the push; the caller should send the event again. */
	| ({ action: "retry"; why: "behind" | "incomplete" } & ReindexResult);

/** What one attempt settled on; a push of unknown outcome has already been resolved. */
type Settled = Exclude<ApplyResult, { kind: "push_uncertain" }> | { kind: "retryable" };

const LANDED_CHECK_COMMITS = 5;
const TOKEN_TTL_SECONDS = 300;
const MAX_ATTEMPTS = 2;
const LANDED_CHECK_TRIES = 2;
const LANDED_CHECK_WAIT_MS = 250;
// How many recent commits are searched for the commit an event names. An event
// can arrive well after its push, with other pushes on top of it.
const EVENT_LOOKBACK_COMMITS = 50;

const SCHEMA_VERSION = "2";
const BRANCH = "main";
const PUSH_EVENT = "cf.artifacts.repo.pushed";
// How far back reindex looks for the commit that last changed a note. Beyond
// this the note is indexed with no author or date.
const MAX_ATTRIBUTION_COMMITS = 200;
const LOG_PAGE = 50;
const READ_BATCH = 8;
// Above this many notes to read, reindex fetches them with one shallow clone in
// place of one binding call each: a first build of a large repo would otherwise
// make more calls than one invocation is allowed.
const BULK_READ_THRESHOLD = 16;
const MAX_DUPLICATES = 5;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const MAX_LIST = 500;
// Column order of notes_fts: path, title, tags, body. A word in the title counts
// for more than the same word in the body.
const BM25_WEIGHTS = "2.0, 6.0, 3.0, 1.0";
const BODY_COLUMN = 3;
const SNIPPET_TOKENS = 24;

export class MemoryStore extends DurableObject<Env> {
	/** Test seam: replaces the HTTP client used for clone and push. */
	http: HttpClient | undefined;
	/** Test seam: replaces the wait between landed-check tries. */
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	// A Durable Object handles one call at a time only between its own storage
	// operations; while a method waits on the network, another call can start. So
	// writes and reindexes line up on this chain by hand.
	private tail: Promise<unknown> = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		if (this.meta("schema") !== SCHEMA_VERSION) {
			// The index is a cache, so a change of shape drops it; the next search,
			// list, context call or write rebuilds it from the repo.
			ctx.storage.transactionSync(() => {
				sql.exec("DROP TABLE IF EXISTS notes_fts");
				sql.exec("DROP TABLE IF EXISTS notes");
				sql.exec(
					`CREATE TABLE notes (
						path TEXT PRIMARY KEY,
						blob_sha TEXT NOT NULL,
						title TEXT NOT NULL,
						summary TEXT NOT NULL,
						tags TEXT NOT NULL,
						text TEXT NOT NULL,
						updated_at INTEGER,
						author TEXT,
						title_key TEXT,
						opening_key TEXT
					)`,
				);
				sql.exec("CREATE INDEX notes_title_key ON notes (title_key)");
				sql.exec("CREATE INDEX notes_opening_key ON notes (opening_key)");
				sql.exec(
					"CREATE VIRTUAL TABLE notes_fts USING fts5(path, title, tags, body, tokenize = 'porter unicode61')",
				);
				sql.exec("DELETE FROM meta WHERE key = 'indexed_commit'");
				this.setMeta("schema", SCHEMA_VERSION);
			});
		}
	}

	// ── Writes ──

	async write(args: WriteArgs): Promise<StoreResult> {
		return await this.enqueue(() =>
			this.job("write", args.path, args.force === true, {
				path: args.path,
				text: args.text,
				baseVersion: args.baseVersion,
				author: args.author,
				message: args.message,
			}),
		);
	}

	async remove(args: RemoveArgs): Promise<StoreResult> {
		return await this.enqueue(() =>
			this.job("remove", args.path, true, {
				path: args.path,
				text: null,
				baseVersion: args.baseVersion,
				author: args.author,
				message: args.message,
			}),
		);
	}

	private enqueue<T>(job: () => Promise<T>): Promise<T> {
		const run = this.tail.then(job, job);
		// A failed job must not break the chain for the next one.
		this.tail = run.catch(() => undefined);
		return run;
	}

	private async job(op: string, path: string, force: boolean, change: Change): Promise<StoreResult> {
		const started = Date.now();
		let attempts = 0;
		let outcome = "error";
		try {
			// Checked here, not before the queue, so a bad path is a thrown job.
			const rule = checkNotePath(path);
			if (rule !== null) throw new Error("invalid note path");
			if (change.text !== null && change.baseVersion === null && !force) {
				const candidates = await this.duplicatesOf(path, change.text);
				if (candidates.length > 0) {
					outcome = "duplicates";
					return { ok: false, reason: "duplicates", candidates };
				}
			}
			let result: StoreResult = { ok: false, reason: "retryable" };
			while (attempts < MAX_ATTEMPTS) {
				attempts += 1;
				const settled = await this.attempt(change);
				// A rejected push may come from a change to some other note: run the
				// whole attempt again from a fresh clone, which repeats the version check.
				if (settled.kind === "rejected") continue;
				result = this.record(change, settled);
				if (this.stale !== false) await this.reindexQuietly(this.stale);
				break;
			}
			outcome = result.ok ? "ok" : result.reason;
			return result;
		} finally {
			console.log(
				JSON.stringify({
					event: "store",
					op,
					outcome,
					ms: Date.now() - started,
					attempts,
					// Only a well-formed note path is logged, as in the tool's own line.
					path: checkNotePath(path) === null ? path : undefined,
				}),
			);
		}
	}

	/**
	 * Existing notes that a new note at `path` would repeat (R11). Runs inside the
	 * queue. The check is advice to the writer, so when the index cannot be built
	 * it finds nothing and the write goes ahead.
	 */
	private async duplicatesOf(path: string, text: string): Promise<DuplicateCandidate[]> {
		if (this.meta("indexed_commit") === undefined) await this.reindexQuietly();
		const sql = this.ctx.storage.sql;
		// A note already at this path is not new: the version check answers that.
		if (sql.exec("SELECT 1 FROM notes WHERE path = ?", path).toArray().length > 0) return [];
		const keys = duplicateKeys(path, text);
		if (keys.title === null && keys.opening === null) return [];
		return sql
			.exec<{ path: string; title: string; summary: string }>(
				"SELECT path, title, summary FROM notes WHERE path <> ? AND (title_key = ? OR opening_key = ?) ORDER BY path LIMIT ?",
				path,
				keys.title,
				keys.opening,
				MAX_DUPLICATES,
			)
			.toArray();
	}

	private async attempt(change: Change): Promise<Settled> {
		try {
			using repo = await this.env.ARTIFACTS.get(this.env.MEMORY_REPO);
			const info = await repo.info();
			const token = await repo.createToken("write", TOKEN_TTL_SECONDS);
			const applied = await applyChange(
				{ url: info.remote, token: token.plaintext.split("?expires=")[0] },
				change,
				{ http: this.http },
			);
			if (applied.kind !== "push_uncertain") return applied;
			// The push failed in a way that does not say whether it landed. Ask the
			// binding whether main now holds our commit, twice: one lookup can fail or
			// run ahead of the push becoming visible.
			for (let tried = 0; tried < LANDED_CHECK_TRIES; tried++) {
				if (tried > 0) await this.sleep(LANDED_CHECK_WAIT_MS);
				try {
					const recent = await repo.log({ ref: BRANCH, limit: LANDED_CHECK_COMMITS });
					if (recent.some((c) => c.hash === applied.commit)) {
						return { ...applied, kind: "pushed" };
					}
				} catch (error) {
					this.logError(error);
				}
			}
			return { kind: "retryable" };
		} catch (error) {
			this.logError(error);
			return { kind: "retryable" };
		}
	}

	private logError(error: unknown): void {
		// Name and code only: an error's message can echo request content.
		const code = (error as { code?: unknown } | null)?.code;
		console.log(
			JSON.stringify({
				event: "store_error",
				name: error instanceof Error ? error.name : typeof error,
				code: typeof code === "string" ? code : undefined,
			}),
		);
	}

	/**
	 * Set by `record` when the index is known to be behind the repo: the commit
	 * the write saw or made, which a reindex must find on main before it trusts
	 * what the binding shows (null when there is none to look for).
	 */
	private stale: string | null | false = false;

	/** Updates the index for a settled attempt and shapes the reply. */
	private record(change: Change, settled: Settled): StoreResult {
		const sql = this.ctx.storage.sql;
		const path = change.path;
		this.stale = false;
		// The index covers the repo up to `indexed_commit`. This change was built on
		// `base`; when the two differ, someone else pushed in between (or the index
		// was never built), and only a reindex can say what else changed.
		const follows = (base: string | null) => (base ?? "") === this.meta("indexed_commit");
		switch (settled.kind) {
			case "pushed":
				this.ctx.storage.transactionSync(() => {
					if (settled.version === null || change.text === null) {
						this.deleteRow(path);
					} else {
						this.upsertRow(path, settled.version, change.text, change.author, settled.at);
					}
					this.setMeta("last_pushed", settled.commit);
					if (follows(settled.base)) this.setMeta("indexed_commit", settled.commit);
					else this.stale = settled.commit;
				});
				return { ok: true, version: settled.version, commit: settled.commit };
			case "unchanged": {
				// The clone just showed this blob. A row that disagrees means the index
				// missed a push: usually our own, whose answer was lost.
				const row = sql.exec("SELECT blob_sha FROM notes WHERE path = ?", path).toArray()[0];
				if (row?.blob_sha !== settled.version) {
					if (follows(settled.base) && change.text !== null) {
						this.upsertRow(path, settled.version, change.text, null, null);
					} else {
						this.stale = settled.base;
					}
				}
				return { ok: true, version: settled.version, commit: null };
			}
			case "conflict":
				return { ok: false, reason: "conflict", current_version: settled.currentVersion };
			case "not_found":
				return { ok: false, reason: "not_found" };
			case "blocked":
				return { ok: false, reason: "blocked", at: settled.at };
			default:
				return { ok: false, reason: "retryable" };
		}
	}

	// ── Index rows ──

	private meta(key: string): string | undefined {
		const row = this.ctx.storage.sql
			.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
			.toArray()[0];
		return row?.value;
	}

	private setMeta(key: string, value: string): void {
		this.ctx.storage.sql.exec(
			"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
			key,
			value,
		);
	}

	private deleteRow(path: string): void {
		const sql = this.ctx.storage.sql;
		const row = sql.exec<{ rowid: number }>("SELECT rowid FROM notes WHERE path = ?", path).toArray()[0];
		if (!row) return;
		sql.exec("DELETE FROM notes_fts WHERE rowid = ?", row.rowid);
		sql.exec("DELETE FROM notes WHERE rowid = ?", row.rowid);
	}

	/** Writes one note's row and its search text. `author` and `at` are null when unknown. */
	private upsertRow(
		path: string,
		version: string,
		text: string,
		author: string | null,
		at: number | null,
	): void {
		const sql = this.ctx.storage.sql;
		const parsed = parseNote(path, text);
		const keys = duplicateKeys(path, text);
		this.deleteRow(path);
		const row = sql
			.exec<{ rowid: number }>(
				`INSERT INTO notes (path, blob_sha, title, summary, tags, text, updated_at, author, title_key, opening_key)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING rowid`,
				path,
				version,
				parsed.title,
				parsed.summary,
				JSON.stringify(parsed.tags),
				text,
				at,
				author,
				keys.title,
				keys.opening,
			)
			.one();
		sql.exec(
			"INSERT INTO notes_fts (rowid, path, title, tags, body) VALUES (?, ?, ?, ?, ?)",
			row.rowid,
			path,
			parsed.title,
			parsed.tags.join(" "),
			parsed.body,
		);
	}

	// ── Reindex ──

	/**
	 * Brings the index in line with `main`: reads the tree, compares blob SHAs with
	 * the rows, and reads only the notes that differ. `full` reads every note again.
	 */
	async reindex(args: { full?: boolean } = {}): Promise<ReindexResult> {
		return await this.enqueue(() => this.reindexNow(args.full === true));
	}

	/**
	 * Called for a repo event. An event naming the commit the index already covers
	 * needs nothing, which is the usual case for a push the store made itself. Any
	 * other push to main triggers a reindex: a direct push, and also the store's
	 * own push when the reindex that should have followed it failed or ran against
	 * a stale answer.
	 */
	async pushed(args: PushedArgs): Promise<PushedResult> {
		if (args.type !== PUSH_EVENT) return { action: "ignored", why: "not_a_push" };
		if (args.repo !== this.env.MEMORY_REPO) return { action: "ignored", why: "other_repo" };
		if (args.ref !== `refs/heads/${BRANCH}`) return { action: "ignored", why: "other_ref" };
		return await this.enqueue(async (): Promise<PushedResult> => {
			// Compared inside the queue, so a write in flight has recorded its push.
			if (args.after === this.meta("indexed_commit")) {
				return { action: "ignored", why: "indexed" };
			}
			// The event says `after` is on main. Until the repo shows it, the repo's
			// answer is behind, and indexing from it could undo a row just written.
			const expect = typeof args.after === "string" ? args.after : null;
			const result = await this.reindexNow(false, expect, EVENT_LOOKBACK_COMMITS);
			if (result.state === "behind" || result.state === "incomplete") {
				return { action: "retry", why: result.state, ...result };
			}
			return { action: "reindexed", ...result };
		});
	}

	/** A reindex whose failure must not fail the caller; runs inside the queue. */
	private async reindexQuietly(expect: string | null = null): Promise<void> {
		try {
			await this.reindexNow(false, expect);
		} catch (error) {
			this.logError(error);
		}
	}

	/** Builds the index if it has never been built. */
	private async ensureIndexed(): Promise<void> {
		if (this.meta("indexed_commit") !== undefined) return;
		await this.enqueue(async () => {
			if (this.meta("indexed_commit") === undefined) await this.reindexNow(false);
		});
	}

	/**
	 * Runs inside the queue. Nothing is deleted or replaced until the tree has
	 * been listed, so a reindex that cannot read the repo leaves the index as it
	 * was, still answering. `expect` names a commit the caller knows is on main:
	 * when the binding does not show it yet, its answer is behind, and indexing
	 * from it would undo what the caller just wrote.
	 */
	private async reindexNow(
		asked: boolean,
		expect: string | null = null,
		lookback: number = LANDED_CHECK_COMMITS,
	): Promise<ReindexResult> {
		const started = Date.now();
		const sql = this.ctx.storage.sql;
		// A full reindex that could not read every note is owed: until one
		// completes, every reindex is a full one.
		const full = asked || this.meta("full_pending") !== undefined;
		const result: ReindexResult = {
			state: "ok",
			head: null,
			ran: false,
			changed: 0,
			removed: 0,
			skipped: 0,
			failed: 0,
		};
		let outcome = "error";
		try {
			using repo = await this.env.ARTIFACTS.get(this.env.MEMORY_REPO);
			const recent = await repo.log({ ref: BRANCH, limit: lookback });
			const head = recent[0];
			result.head = head?.hash ?? null;
			// Asked first: an answer that lacks the expected commit is behind even when
			// it happens to show the commit the index covers.
			if (expect !== null && !recent.some((c) => c.hash === expect)) {
				outcome = result.state = "behind";
				return result;
			}
			if (!full && (head?.hash ?? "") === this.meta("indexed_commit")) {
				outcome = result.state = "current";
				return result;
			}
			result.ran = true;
			if (asked) this.setMeta("full_pending", "1");
			const cache = new TreeCache(repo, { sleep: this.sleep });
			const current = head ? await listNotes(cache, head.treeHash) : new Map<string, string>();
			const rows = new Map(
				sql
					.exec<{ path: string; blob_sha: string }>("SELECT path, blob_sha FROM notes")
					.toArray()
					.map((r) => [r.path, r.blob_sha]),
			);
			const removed = [...rows.keys()].filter((path) => !current.has(path));
			// A full reindex reads every note again, replacing each row as it goes; it
			// does not empty the index first, so a failure partway leaves rows to answer.
			const changed = [...current.entries()].filter(
				([path, hash]) => full || rows.get(path) !== hash,
			);
			const who = head
				? await this.attribute(repo, cache, head.hash, new Set(changed.map(([path]) => path)))
				: new Map<string, { author: string; at: number }>();

			let bulk: BulkBlobs = { blobs: new Map(), oversize: new Set() };
			if (changed.length > BULK_READ_THRESHOLD) {
				try {
					const info = await repo.info();
					const token = await repo.createToken("read", TOKEN_TTL_SECONDS);
					bulk = await readBlobs(
						{ url: info.remote, token: token.plaintext.split("?expires=")[0] },
						changed.map(([, hash]) => hash),
						{ http: this.http },
					);
				} catch (error) {
					// The binding can still read each note, only more slowly.
					this.logError(error);
				}
			}
			/** The note's text; null when the repo has no such blob or it is too large to be a note. */
			const readText = async (hash: string): Promise<string | null> => {
				if (bulk.oversize.has(hash)) return null;
				const bytes = bulk.blobs.get(hash);
				if (bytes) return indexText(bytes);
				let blob: Blob | null;
				try {
					blob = await withRetry(() => repo.readBlob(hash), { sleep: this.sleep });
				} catch (error) {
					// Too large for the binding to hand over: too large to be a note.
					if ((error as { code?: unknown } | null)?.code === "MEMORY_LIMIT") return null;
					throw error;
				}
				if (blob === null || blob.size > MAX_INDEXED_BLOB_BYTES) return null;
				return indexText(new Uint8Array(await blob.arrayBuffer()));
			};

			for (const path of removed) this.deleteRow(path);
			result.removed = removed.length;
			for (let i = 0; i < changed.length; i += READ_BATCH) {
				const batch = await Promise.all(
					changed.slice(i, i + READ_BATCH).map(async ([path, hash]) => {
						try {
							return { path, hash, text: await readText(hash), failed: false };
						} catch (error) {
							this.logError(error);
							return { path, hash, text: null, failed: true };
						}
					}),
				);
				this.ctx.storage.transactionSync(() => {
					for (const { path, hash, text, failed } of batch) {
						if (failed) {
							// The read failed, which says nothing about the note: its row stays
							// as it is, and the mark below is not moved, so the next reindex
							// tries again.
							result.failed += 1;
							continue;
						}
						if (text === null) {
							// Not a note the index can hold: keep it out.
							this.deleteRow(path);
							result.skipped += 1;
							continue;
						}
						const by = who.get(path);
						this.upsertRow(path, hash, text, by?.author ?? null, by?.at ?? null);
						result.changed += 1;
					}
				});
			}
			if (result.failed === 0) {
				this.ctx.storage.transactionSync(() => {
					this.setMeta("indexed_commit", head?.hash ?? "");
					sql.exec("DELETE FROM meta WHERE key = 'full_pending'");
				});
			}
			outcome = result.state = result.failed === 0 ? "ok" : "incomplete";
			return result;
		} finally {
			console.log(
				JSON.stringify({
					event: "reindex",
					outcome,
					full,
					ms: Date.now() - started,
					changed: result.changed,
					removed: result.removed,
					skipped: result.skipped,
					failed: result.failed,
				}),
			);
		}
	}

	/**
	 * Finds, for each path, the newest commit that changed it: its author and date.
	 * Walks first parents from `head`, at most MAX_ATTRIBUTION_COMMITS; a path not
	 * settled by then is left out.
	 */
	private async attribute(
		repo: ArtifactsRepo,
		cache: TreeCache,
		head: string,
		paths: Set<string>,
	): Promise<Map<string, { author: string; at: number }>> {
		const found = new Map<string, { author: string; at: number }>();
		const remaining = new Set(paths);
		let examined = 0;
		while (remaining.size > 0 && examined < MAX_ATTRIBUTION_COMMITS) {
			const size = Math.min(LOG_PAGE, MAX_ATTRIBUTION_COMMITS - examined);
			// Pinned to the head commit, so a push during the walk cannot shift the pages.
			const page = await repo.log({ ref: head, limit: size, offset: examined });
			for (const [i, commit] of page.entries()) {
				if (remaining.size === 0) break;
				examined += 1;
				const parentHash = commit.parents[0];
				let parentTree: string | null = null;
				if (parentHash) {
					const next = page[i + 1];
					const parent = next?.hash === parentHash ? next : await repo.readCommit(parentHash);
					parentTree = parent?.treeHash ?? null;
				}
				for (const path of await changedPaths(cache, commit.treeHash, parentTree)) {
					if (remaining.delete(path)) {
						found.set(path, { author: commit.author.name, at: commit.authoredAt });
					}
				}
			}
			if (page.length < size) break;
		}
		return found;
	}

	// ── Queries ──

	/** Full-text search over path, title, tags and body, best match first. Null when the query holds no word. */
	async search(args: {
		query: string;
		folder?: string;
		limit?: number;
	}): Promise<{ results: SearchHit[] } | null> {
		const match = ftsQuery(args.query);
		const prefix = folderPrefix(args.folder);
		if (match === null || prefix === false) return null;
		await this.ensureIndexed();
		const requested = Math.floor(args.limit ?? DEFAULT_SEARCH_LIMIT);
		const limit = Math.min(
			MAX_SEARCH_LIMIT,
			Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_SEARCH_LIMIT),
		);
		const results = this.ctx.storage.sql
			.exec<{ path: string; title: string; snippet: string }>(
				`SELECT n.path AS path, n.title AS title,
					snippet(notes_fts, ${BODY_COLUMN}, '', '', ' ... ', ${SNIPPET_TOKENS}) AS snippet
				 FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
				 WHERE notes_fts MATCH ? AND (? = '' OR substr(n.path, 1, length(?)) = ?)
				 ORDER BY bm25(notes_fts, ${BM25_WEIGHTS}), n.path
				 LIMIT ?`,
				match,
				prefix ?? "",
				prefix ?? "",
				prefix ?? "",
				limit,
			)
			.toArray();
		return { results };
	}

	/** Notes by path, optionally under one folder. Null when the folder is unusable. */
	async list(args: { folder?: string } = {}): Promise<{ notes: ListedNote[]; truncated: boolean } | null> {
		const prefix = folderPrefix(args.folder);
		if (prefix === false) return null;
		await this.ensureIndexed();
		const rows = this.ctx.storage.sql
			.exec<{ path: string; title: string; updated_at: number | null }>(
				`SELECT path, title, updated_at FROM notes
				 WHERE (? = '' OR substr(path, 1, length(?)) = ?) ORDER BY path LIMIT ?`,
				prefix ?? "",
				prefix ?? "",
				prefix ?? "",
				MAX_LIST + 1,
			)
			.toArray();
		return {
			notes: rows.slice(0, MAX_LIST).map((r) => ({
				path: r.path,
				title: r.title,
				updated_at: r.updated_at === null ? null : new Date(r.updated_at * 1000).toISOString(),
			})),
			truncated: rows.length > MAX_LIST,
		};
	}

	/** The start-of-conversation answer: profile and preferences in full, then a catalog. */
	async context(): Promise<ContextAnswer> {
		await this.ensureIndexed();
		const pinned: PinnedNote[] = [];
		const others: CatalogEntry[] = [];
		// Bodies are read only for the pinned folders.
		const rows = this.ctx.storage.sql
			.exec<{ path: string; title: string; summary: string }>(
				"SELECT path, title, summary FROM notes ORDER BY path",
			)
			.toArray();
		for (const row of rows) {
			if (isPinned(row.path)) {
				const text = this.ctx.storage.sql
					.exec<{ text: string }>("SELECT text FROM notes WHERE path = ?", row.path)
					.one().text;
				pinned.push({ path: row.path, title: row.title, text });
			} else {
				others.push({ path: row.path, title: row.title, summary: row.summary });
			}
		}
		return buildContext(pinned, others);
	}
}
