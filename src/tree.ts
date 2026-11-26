// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Walks git trees through the Artifacts binding, for the index: which notes a
// commit holds, and which paths differ between two commits. No SQLite, no MCP.
import { checkPath, withRetry, type ReadOptions, type ReadRepo } from "./reads";

export class MissingTreeError extends Error {
	constructor() {
		super("a tree named by the repo could not be read");
		this.name = "MissingTreeError";
	}
}

/** The id of the tree with no entries: what a commit names once its last file is deleted. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Reads each tree object at most once. */
export class TreeCache {
	private readonly trees = new Map<string, Promise<ArtifactsTreeEntry[]>>();

	constructor(
		private readonly repo: Pick<ReadRepo, "readTree">,
		private readonly opts: ReadOptions = {},
	) {}

	/**
	 * The entries of a tree that a commit or another tree names. Such a tree
	 * exists, so an answer of "missing" is a failed read, not an empty folder:
	 * it is retried once and then thrown, and the caller's reindex fails without
	 * deleting anything.
	 */
	entries(hash: string): Promise<ArtifactsTreeEntry[]> {
		// Known to be empty by its id alone, so a "missing" answer for it cannot be
		// mistaken for a failed read. Nothing else is assumed empty.
		if (hash === EMPTY_TREE) return Promise.resolve([]);
		let found = this.trees.get(hash);
		if (!found) {
			found = withRetry(async () => {
				const entries = await this.repo.readTree(hash);
				if (entries === null) throw new MissingTreeError();
				return entries;
			}, this.opts);
			this.trees.set(hash, found);
		}
		return found;
	}
}

function isFile(entry: ArtifactsTreeEntry): boolean {
	// A symlink or a submodule link is not a note, whatever its name.
	return entry.type === "blob" || entry.type === "exec";
}

/** Every note under `rootTree`, as path to blob hash. A note is a regular file whose path the read tools accept. */
export async function listNotes(cache: TreeCache, rootTree: string): Promise<Map<string, string>> {
	const notes = new Map<string, string>();
	async function walk(hash: string, prefix: string): Promise<void> {
		const entries = await cache.entries(hash);
		const folders: Promise<void>[] = [];
		for (const entry of entries) {
			const path = `${prefix}${entry.name}`;
			if (entry.type === "tree") {
				folders.push(walk(entry.hash, `${path}/`));
			} else if (isFile(entry) && checkPath(path) === null) {
				notes.set(path, entry.hash);
			}
		}
		await Promise.all(folders);
	}
	await walk(rootTree, "");
	return notes;
}

/**
 * The file paths whose content differs between two trees (added, changed or
 * removed). Subtrees with the same hash are not read. A null tree is empty.
 */
export async function changedPaths(
	cache: TreeCache,
	a: string | null,
	b: string | null,
): Promise<Set<string>> {
	const changed = new Set<string>();
	async function walk(left: string | null, right: string | null, prefix: string): Promise<void> {
		if (left === right) return;
		const [l, r] = await Promise.all([
			left === null ? [] : cache.entries(left),
			right === null ? [] : cache.entries(right),
		]);
		const rightByName = new Map(r.map((e) => [e.name, e]));
		const names = new Set([...l.map((e) => e.name), ...r.map((e) => e.name)]);
		const leftByName = new Map(l.map((e) => [e.name, e]));
		const folders: Promise<void>[] = [];
		for (const name of names) {
			const x = leftByName.get(name);
			const y = rightByName.get(name);
			if (x && y && x.hash === y.hash && x.type === y.type) continue;
			const path = `${prefix}${name}`;
			const xTree = x?.type === "tree" ? x.hash : null;
			const yTree = y?.type === "tree" ? y.hash : null;
			if (xTree !== null || yTree !== null) folders.push(walk(xTree, yTree, `${path}/`));
			if ((x && isFile(x)) || (y && isFile(y))) changed.add(path);
		}
		await Promise.all(folders);
	}
	await walk(a, b, "");
	return changed;
}
