// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { noteHistory, readNote, type ReadOptions, type ReadRepo } from "../src/reads";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const noSleep = async () => {};

interface FakeCommit {
	/** Blob hash of projects/alpha.md in this commit, or null when absent. */
	alpha: string | null;
	text?: string;
}

/**
 * A linear history, oldest first. Commit i has hash sha(100 + i) and tree hash
 * sha(1000 + i); the tree holds projects/alpha.md (when set) and a constant
 * other.md so every commit has a root tree.
 */
function fakeRepo(commits: FakeCommit[]) {
	const calls = { readFile: 0, readTree: 0, readCommit: 0, log: 0 };
	const failures = { readFile: 0, error: undefined as unknown };
	const meta = commits.map((c, i) => ({
		hash: sha(100 + i),
		treeHash: sha(1000 + i),
		message: `commit ${i}`,
		author: { name: `author${i}`, email: "a@invalid" },
		committer: { name: "c", email: "c@invalid" },
		parents: i === 0 ? [] : [sha(100 + i - 1)],
		authoredAt: 1_700_000_000 + i,
		committedAt: 1_700_000_000 + i,
	}));
	const newestFirst = [...meta].reverse();
	const repo: ReadRepo = {
		async readFile({ path }) {
			calls.readFile += 1;
			if (failures.readFile > 0) {
				failures.readFile -= 1;
				throw failures.error;
			}
			const head = commits[commits.length - 1];
			if (path !== "projects/alpha.md" || head.alpha === null) return null;
			return new Blob([head.text ?? "alpha text"]);
		},
		async log({ limit = 50, offset = 0 } = {}) {
			calls.log += 1;
			return newestFirst.slice(offset, offset + limit);
		},
		async readCommit(hash) {
			calls.readCommit += 1;
			return meta.find((m) => m.hash === hash) ?? null;
		},
		async readTree(hash) {
			calls.readTree += 1;
			const index = Number(BigInt(`0x${hash}`)) - 1000;
			if (index >= 0 && index < commits.length) {
				return [{ name: "projects", mode: "40000", hash: sha(5000 + index), type: "tree" as const }];
			}
			const dir = Number(BigInt(`0x${hash}`)) - 5000;
			if (dir < 0 || dir >= commits.length) return null;
			const alpha = commits[dir].alpha;
			return alpha === null
				? []
				: [{ name: "alpha.md", mode: "100644", hash: alpha, type: "blob" as const }];
		},
	};
	return { repo, calls, failures };
}

const opts = (): ReadOptions & { stats: { retried: boolean } } => ({
	sleep: noSleep,
	stats: { retried: false },
});

describe("readNote", () => {
	it("returns text and a 40-hex version", async () => {
		const { repo } = fakeRepo([{ alpha: sha(1) }, { alpha: sha(2), text: "hello" }]);
		const result = await readNote(repo, { path: "projects/alpha.md" }, opts());
		expect(result).toMatchObject({ ok: true, text: "hello", version: sha(2) });
		if (result.ok) expect(result.version).toMatch(/^[0-9a-f]{40}$/);
	});

	describe("author and updated_at", () => {
		// alpha last changed at commit 1; commits 2 and 3 are other clients' changes
		// to other notes, so the head commit says nothing about alpha.
		const commits = (): FakeCommit[] => [sha(1), sha(2), sha(2), sha(2)].map((alpha) => ({ alpha }));
		const row = { version: sha(2), author: "alpha-author", updated_at: 1_600_000_000 };

		it("come from the index row for the text that was read, not from the head commit", async () => {
			const { repo } = fakeRepo(commits());
			const asked: string[] = [];
			const indexed = async (path: string) => {
				asked.push(path);
				return row;
			};
			const result = await readNote(repo, { path: "projects/alpha.md" }, { ...opts(), indexed });
			expect(result).toMatchObject({
				ok: true,
				version: sha(2),
				author: "alpha-author",
				updated_at: new Date(1_600_000_000_000).toISOString(),
			});
			expect(asked).toEqual(["projects/alpha.md"]);
		});

		it("are null when the index row is for other text", async () => {
			const { repo } = fakeRepo(commits());
			const indexed = async () => ({ ...row, version: sha(1) });
			const result = await readNote(repo, { path: "projects/alpha.md" }, { ...opts(), indexed });
			expect(result).toMatchObject({ ok: true, version: sha(2), author: null, updated_at: null });
		});

		it("are null when the index has no row, or was built without them", async () => {
			const { repo } = fakeRepo(commits());
			const none = await readNote(
				repo,
				{ path: "projects/alpha.md" },
				{ ...opts(), indexed: async () => null },
			);
			expect(none).toMatchObject({ ok: true, author: null, updated_at: null });
			const bare = await readNote(
				repo,
				{ path: "projects/alpha.md" },
				{ ...opts(), indexed: async () => ({ version: sha(2), author: null, updated_at: null }) },
			);
			expect(bare).toMatchObject({ ok: true, author: null, updated_at: null });
		});

		it("are null, and the read still succeeds, when the index cannot be asked", async () => {
			const { repo } = fakeRepo(commits());
			const indexed = async () => {
				throw new Error("store down");
			};
			const result = await readNote(repo, { path: "projects/alpha.md" }, { ...opts(), indexed });
			expect(result).toMatchObject({ ok: true, version: sha(2), author: null, updated_at: null });
		});

		it("say in the stats what the index lookup came to, for the tool log", async () => {
			const outcome = async (
				indexed?: ReadOptions["indexed"],
				ref?: string,
			): Promise<ReadOptions["stats"]> => {
				const { repo } = fakeRepo(commits());
				const o: ReadOptions = { ...opts(), indexed };
				await readNote(repo, { path: "projects/alpha.md", ref }, o);
				return o.stats;
			};
			expect(await outcome(async () => row)).toMatchObject({ index: "hit" });
			expect(await outcome(async () => ({ ...row, version: sha(1) }))).toMatchObject({ index: "stale" });
			expect(await outcome(async () => null)).toMatchObject({ index: "missing" });
			expect(await outcome(async () => ({ ...row, author: null }))).toMatchObject({ index: "bare" });
			const failed = await outcome(async () => {
				throw Object.assign(new TypeError("secret text"), { code: "E_RPC" });
			});
			// The name and code, never the message: it can echo request content.
			expect(failed).toMatchObject({ index: "error", indexError: "TypeError:E_RPC" });
			expect((await outcome())?.index).toBeUndefined();
			expect((await outcome(async () => row, sha(103)))?.index).toBeUndefined();
		});

		it("are null with no index to ask", async () => {
			const { repo } = fakeRepo(commits());
			const result = await readNote(repo, { path: "projects/alpha.md" }, opts());
			expect(result).toMatchObject({ ok: true, author: null, updated_at: null });
		});

		it("are the named commit's own when ref is given, without asking the index", async () => {
			const { repo } = fakeRepo(commits());
			let asked = 0;
			const indexed = async () => {
				asked += 1;
				return row;
			};
			const result = await readNote(
				repo,
				{ path: "projects/alpha.md", ref: sha(103) },
				{ ...opts(), indexed },
			);
			expect(result).toMatchObject({
				ok: true,
				author: "author3",
				updated_at: new Date(1_700_000_003_000).toISOString(),
			});
			expect(asked).toBe(0);
		});
	});

	it("reports a missing note as not found", async () => {
		const { repo } = fakeRepo([{ alpha: sha(1) }]);
		const result = await readNote(repo, { path: "projects/missing.md" }, opts());
		expect(result).toMatchObject({ ok: false, reason: "not_found" });
	});

	it.each([
		["", "empty"],
		["/projects/alpha.md", "leading slash"],
		["projects/../alpha.md", ".. segment"],
		["./alpha.md", ". segment"],
		["projects\\alpha.md", "backslash"],
		["projects/al\u0001pha.md", "control character"],
		["projects/alpha.txt", "not .md"],
		["projects//alpha.md", "empty segment"],
	])("rejects the path %j (%s)", async (path) => {
		const { repo, calls } = fakeRepo([{ alpha: sha(1) }]);
		const result = await readNote(repo, { path }, opts());
		expect(result).toMatchObject({ ok: false, reason: "invalid_path" });
		expect(calls.readFile).toBe(0);
	});

	it("retries once after a thrown error and succeeds", async () => {
		const { repo, failures, calls } = fakeRepo([{ alpha: sha(1) }]);
		failures.readFile = 1;
		failures.error = new Error("503");
		const o = opts();
		const result = await readNote(repo, { path: "projects/alpha.md" }, o);
		expect(result.ok).toBe(true);
		expect(o.stats.retried).toBe(true);
		expect(calls.readFile).toBe(2);
	});

	it("fails when the retry also throws", async () => {
		const { repo, failures, calls } = fakeRepo([{ alpha: sha(1) }]);
		failures.readFile = 2;
		failures.error = new Error("503");
		await expect(readNote(repo, { path: "projects/alpha.md" }, opts())).rejects.toThrow("503");
		expect(calls.readFile).toBe(2);
	});

	it("does not retry INVALID_INPUT", async () => {
		const { repo, failures, calls } = fakeRepo([{ alpha: sha(1) }]);
		failures.readFile = 2;
		failures.error = Object.assign(new Error("bad"), { name: "ArtifactsError", code: "INVALID_INPUT" });
		const o = opts();
		await expect(readNote(repo, { path: "projects/alpha.md" }, o)).rejects.toThrow("bad");
		expect(calls.readFile).toBe(1);
		expect(o.stats.retried).toBe(false);
	});
});

describe("noteHistory", () => {
	// alpha changes at commits 0 (added), 2 (edited), 5 (edited); others touch nothing.
	const history = (): FakeCommit[] =>
		[sha(1), sha(1), sha(2), sha(2), sha(2), sha(3), sha(3)].map((alpha) => ({ alpha }));

	it("returns only commits that changed the path, newest first", async () => {
		const { repo } = fakeRepo(history());
		const result = await noteHistory(repo, { path: "projects/alpha.md" }, opts());
		expect(result.ok && result.commits.map((c) => c.message)).toEqual([
			"commit 5",
			"commit 2",
			"commit 0",
		]);
		expect(result.ok && result.truncated).toBe(false);
		expect(result.ok && result.commits[0]).toMatchObject({ sha: sha(105), author: "author5" });
	});

	it("counts a removal as a change", async () => {
		const { repo } = fakeRepo([{ alpha: sha(1) }, { alpha: null }]);
		const result = await noteHistory(repo, { path: "projects/alpha.md" }, opts());
		expect(result.ok && result.commits.map((c) => c.message)).toEqual(["commit 1", "commit 0"]);
	});

	it("respects limit", async () => {
		const { repo } = fakeRepo(history());
		const result = await noteHistory(repo, { path: "projects/alpha.md", limit: 2 }, opts());
		expect(result.ok && result.commits).toHaveLength(2);
		expect(result.ok && result.truncated).toBe(false);
	});

	it("sets truncated when the walk bound is hit", async () => {
		const many = Array.from({ length: 250 }, () => ({ alpha: sha(1) }));
		const { repo } = fakeRepo(many);
		const result = await noteHistory(repo, { path: "projects/alpha.md" }, opts());
		expect(result.ok && result.commits).toHaveLength(0);
		expect(result.ok && result.truncated).toBe(true);
	});

	it("rejects an invalid path", async () => {
		const { repo } = fakeRepo(history());
		const result = await noteHistory(repo, { path: "../x.md" }, opts());
		expect(result).toMatchObject({ ok: false, reason: "invalid_path" });
	});
});

describe("review fixes (M1 close)", () => {
	it("reads the text from the same commit the version comes from", async () => {
		const { repo } = fakeRepo([{ alpha: sha(1) }, { alpha: sha(2) }]);
		const refs: string[] = [];
		const readFile = repo.readFile.bind(repo);
		repo.readFile = (args) => {
			refs.push(args.ref);
			return readFile(args);
		};
		const note = await readNote(repo, { path: "projects/alpha.md" }, opts());
		expect(note.ok).toBe(true);
		// The head commit's hash, never the moving branch name.
		expect(refs).toEqual([sha(101)]);
	});

	it("does not retry a file too large to buffer", async () => {
		const { repo, calls, failures } = fakeRepo([{ alpha: sha(1) }]);
		failures.readFile = 2;
		failures.error = Object.assign(new Error("too large"), { code: "MEMORY_LIMIT" });
		const o = opts();
		await expect(readNote(repo, { path: "projects/alpha.md" }, o)).rejects.toThrow("too large");
		expect(calls.readFile).toBe(1);
		expect(o.stats.retried).toBe(false);
	});

	it("pins later history pages to the commit the walk started from", async () => {
		const commits = Array.from({ length: 120 }, () => ({ alpha: sha(1) }));
		const { repo } = fakeRepo(commits);
		const refs: (string | undefined)[] = [];
		const log = repo.log.bind(repo);
		repo.log = (o) => {
			refs.push(o?.ref);
			return log(o);
		};
		await noteHistory(repo, { path: "projects/alpha.md", limit: 5 }, opts());
		expect(refs[0]).toBe("main");
		expect(refs.length).toBeGreaterThan(1);
		for (const ref of refs.slice(1)) expect(ref).toBe(sha(100 + 119));
	});
});
