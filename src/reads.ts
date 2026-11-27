// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Read-side note logic, independent of MCP. It takes the narrow slice of the
// Artifacts repo binding it uses, so tests can pass a fake.

/** The binding methods the read tools use. `ArtifactsRepo` satisfies it. */
export interface ReadRepo {
	readFile(args: { ref: string; path: string }): Promise<Blob | null>;
	log(opts?: {
		ref?: string;
		limit?: number;
		offset?: number;
	}): Promise<ArtifactsCommitMetadata[]>;
	readCommit(hash: string): Promise<ArtifactsCommitMetadata | null>;
	readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>;
}

export interface ReadOptions {
	/** Waits between the two attempts of a binding call; tests inject a no-op. */
	sleep?: (ms: number) => Promise<void>;
	/** Set to true when any binding call needed its retry; for the tool log. */
	stats?: ReadStats;
	/**
	 * Looks a note up in the index, which records the commit that last changed
	 * each note. Without it a read of main cannot say who changed the note or when.
	 */
	indexed?: (path: string) => Promise<IndexedNote | null>;
}

/**
 * What a read's index lookup came to, for the tool log: `hit` (the row matched
 * the text read), `stale` (a row for other text), `missing` (no row), `bare` (a
 * matching row with no author or date), or `error` (the lookup threw).
 */
export type IndexOutcome = "hit" | "stale" | "missing" | "bare" | "error";

export interface ReadStats {
	retried: boolean;
	/** Unset when the index was not asked: a read that names a ref, or no lookup given. */
	index?: IndexOutcome;
	/** The thrown error's name and code when `index` is `error`; never its message. */
	indexError?: string;
}

/** What the index holds about one note. */
export interface IndexedNote {
	/** The blob SHA the row was built from. */
	version: string;
	/** Null when the index was built without finding the note's commit. */
	author: string | null;
	/** Unix seconds; null as for `author`. */
	updated_at: number | null;
}

export interface Note {
	text: string;
	/** The note's git blob SHA. */
	version: string;
	/** When the note last changed, and who changed it; null when not known. */
	updated_at: string | null;
	author: string | null;
}

export interface HistoryEntry {
	sha: string;
	date: string;
	author: string;
	message: string;
}

export type ReadFailure =
	| { ok: false; reason: "not_found"; message: string }
	| { ok: false; reason: "invalid_path"; message: string };

export type ReadNoteResult = ({ ok: true } & Note) | ReadFailure;
export type NoteHistoryResult =
	| { ok: true; commits: HistoryEntry[]; truncated: boolean }
	| ReadFailure;

const RETRY_DELAY_MS = 250;
const DEFAULT_REF = "main";
const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 50;
const MAX_WALK = 200;
const PAGE = 50;
const PREFETCH = 10;

/**
 * Runs a binding call and retries it once after a short delay when it throws:
 * a transient non-JSON or 5xx response surfaces as a thrown error, and it was
 * seen right after repo creation. A call the binding rejected as invalid, or for
 * a missing repo, or for a file too large to buffer, would fail the same way
 * again, so those are not retried.
 */
export async function withRetry<T>(call: () => Promise<T>, opts: ReadOptions): Promise<T> {
	try {
		return await call();
	} catch (error) {
		const code = (error as { code?: unknown } | null)?.code;
		if (code === "INVALID_INPUT" || code === "NOT_FOUND" || code === "MEMORY_LIMIT") {
			throw error;
		}
		if (opts.stats) opts.stats.retried = true;
		await (opts.sleep ?? defaultSleep)(RETRY_DELAY_MS);
		return await call();
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * M1 confinement only; the full layout rules arrive in M2. Returns the rule a
 * path breaks, or null when it is acceptable.
 */
export function checkPath(path: string): string | null {
	if (path === "") return "path must not be empty";
	if (path.startsWith("/")) return "path must be relative (no leading slash)";
	if (path.includes("\\")) return "path must not contain a backslash";
	if (/[\x00-\x1f\x7f]/.test(path)) return "path must not contain control characters";
	for (const segment of path.split("/")) {
		if (segment === "") return "path must not contain an empty segment";
		if (segment === "." || segment === "..") {
			return 'path must not contain a "." or ".." segment';
		}
	}
	if (!path.endsWith(".md")) return "path must end in .md";
	return null;
}

function invalid(message: string): ReadFailure {
	return { ok: false, reason: "invalid_path", message };
}

/** Looks up blob hashes by path, reading each tree object at most once. */
class TreeWalker {
	private readonly trees = new Map<string, Promise<ArtifactsTreeEntry[] | null>>();
	private readonly hashes = new Map<string, string | null>();

	constructor(
		private readonly repo: ReadRepo,
		private readonly opts: ReadOptions,
	) {}

	private tree(hash: string): Promise<ArtifactsTreeEntry[] | null> {
		let entry = this.trees.get(hash);
		if (!entry) {
			entry = withRetry(() => this.repo.readTree(hash), this.opts);
			this.trees.set(hash, entry);
		}
		return entry;
	}

	/** The blob hash at `path` under the root tree, or null when absent. */
	async blobHash(rootTree: string, path: string): Promise<string | null> {
		const key = `${rootTree}:${path}`;
		const known = this.hashes.get(key);
		if (known !== undefined) return known;
		const segments = path.split("/");
		let treeHash = rootTree;
		let found: string | null = null;
		for (const [i, name] of segments.entries()) {
			const entries = await this.tree(treeHash);
			const entry = entries?.find((e) => e.name === name);
			if (!entry) break;
			if (i === segments.length - 1) {
				if (entry.type === "blob" || entry.type === "exec") found = entry.hash;
			} else if (entry.type === "tree") {
				treeHash = entry.hash;
			} else {
				break;
			}
		}
		this.hashes.set(key, found);
		return found;
	}
}

export async function readNote(
	repo: ReadRepo,
	args: { path: string; ref?: string },
	opts: ReadOptions = {},
): Promise<ReadNoteResult> {
	const rule = checkPath(args.path);
	if (rule) return invalid(rule);
	const ref = args.ref || DEFAULT_REF;
	const notFound: ReadFailure = {
		ok: false,
		reason: "not_found",
		message: `No note at ${args.path} on ${ref}.`,
	};

	// Resolve the ref once, then read both the text and the version from that one
	// commit. Looking the ref up twice would let a push in between pair one
	// commit's text with another's version, and the version is what a later
	// update is checked against.
	const head = await withRetry(() => repo.log({ ref, limit: 1 }), opts);
	if (head.length === 0) return notFound;
	const commit = head[0];
	// The head of main is whichever note changed last, so it says nothing about
	// this one. The index knows the commit that last changed each note, and asking
	// it costs no history walk. A caller that names a commit gets that commit's
	// own author and date: memory_history hands out the commits that changed the
	// note, so for those the two agree.
	const onMain = ref === DEFAULT_REF;
	const [file, version, row] = await Promise.all([
		withRetry(() => repo.readFile({ ref: commit.hash, path: args.path }), opts),
		new TreeWalker(repo, opts).blobHash(commit.treeHash, args.path),
		onMain ? indexedRow(args.path, opts) : null,
	]);
	if (!file || !version) return notFound;
	const text = await file.text();
	if (!onMain) {
		return {
			ok: true,
			text,
			version,
			updated_at: new Date(commit.committedAt * 1000).toISOString(),
			author: commit.author.name,
		};
	}
	// A row built from other text describes another change to the note: the index
	// is a push behind. Saying nothing is better than naming the wrong client.
	const known = row !== null && row.version === version;
	if (opts.stats && opts.indexed && opts.stats.index !== "error") {
		if (row === null) opts.stats.index = "missing";
		else if (!known) opts.stats.index = "stale";
		else opts.stats.index = row.author === null || row.updated_at === null ? "bare" : "hit";
	}
	return {
		ok: true,
		text,
		version,
		updated_at:
			known && row.updated_at !== null ? new Date(row.updated_at * 1000).toISOString() : null,
		author: known ? row.author : null,
	};
}

/** The note's index row, or null: the text is the answer, and the index only adds to it. */
async function indexedRow(path: string, opts: ReadOptions): Promise<IndexedNote | null> {
	if (!opts.indexed) return null;
	try {
		return await opts.indexed(path);
	} catch (error) {
		if (opts.stats) {
			const code = (error as { code?: unknown } | null)?.code;
			opts.stats.index = "error";
			opts.stats.indexError = [
				error instanceof Error ? error.name : typeof error,
				typeof code === "string" ? code : "",
			]
				.filter(Boolean)
				.join(":");
		}
		return null;
	}
}

export async function noteHistory(
	repo: ReadRepo,
	args: { path: string; limit?: number },
	opts: ReadOptions = {},
): Promise<NoteHistoryResult> {
	const rule = checkPath(args.path);
	if (rule) return invalid(rule);
	const requested = Math.floor(args.limit ?? DEFAULT_HISTORY_LIMIT);
	const limit = Math.min(
		MAX_HISTORY_LIMIT,
		Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_HISTORY_LIMIT),
	);

	const walker = new TreeWalker(repo, opts);
	const commits: HistoryEntry[] = [];
	let examined = 0;
	let more = true;
	// After the first page the walk is pinned to the commit it started from, so a
	// push during the walk cannot shift the offsets and list a commit twice.
	let ref = DEFAULT_REF;
	while (commits.length < limit && examined < MAX_WALK && more) {
		const size = Math.min(PAGE, MAX_WALK - examined);
		const offset = examined;
		const page = await withRetry(() => repo.log({ ref, limit: size, offset }), opts);
		more = page.length === size;
		if (offset === 0 && page.length > 0) ref = page[0].hash;
		for (const [i, commit] of page.entries()) {
			if (commits.length >= limit) break;
			// Every commit has its own root tree. Warm the lookups a few commits
			// ahead, in parallel: one at a time made a long walk hundreds of round
			// trips in sequence, and a whole page at once wasted reads on a walk
			// that stops after a commit or two.
			if (i % PREFETCH === 0) {
				await Promise.all(
					page.slice(i, i + PREFETCH).map((c) => walker.blobHash(c.treeHash, args.path)),
				);
			}
			examined += 1;
			const parentHash = commit.parents[0];
			let parentTree: string | null = null;
			if (parentHash) {
				const next = page[i + 1];
				const parent =
					next?.hash === parentHash
						? next
						: await withRetry(() => repo.readCommit(parentHash), opts);
				parentTree = parent?.treeHash ?? null;
			}
			const now = await walker.blobHash(commit.treeHash, args.path);
			const before = parentTree ? await walker.blobHash(parentTree, args.path) : null;
			if (now !== before) {
				commits.push({
					sha: commit.hash,
					date: new Date(commit.authoredAt * 1000).toISOString(),
					author: commit.author.name,
					message: commit.message,
				});
			}
		}
	}
	// Hit the walk bound with room left in the limit: older changes may exist.
	const truncated = commits.length < limit && examined >= MAX_WALK && more;
	return { ok: true, commits, truncated };
}
