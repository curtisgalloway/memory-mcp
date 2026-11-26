// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// The pure pieces of the index: duplicate keys, query building, folder
// arguments, the context answer, tree diffing, and symlinks in MemoryFS.
import { describe, expect, it } from "vitest";
import { buildContext, CONTEXT_CAP_CHARS, isPinned } from "../src/context";
import { MemoryFS } from "../src/memory-fs";
import { duplicateKeys, folderPrefix, ftsQuery, indexText, MAX_NOTE_BYTES } from "../src/notes";
import { changedPaths, listNotes, MissingTreeError, TreeCache } from "../src/tree";

describe("duplicateKeys", () => {
	it("gives equal title keys for titles that differ only in case and punctuation", () => {
		const a = duplicateKeys("people/alex.md", "# Alex Smith\n\nShort.\n");
		const b = duplicateKeys("people/alex-smith.md", "---\ntitle: alex  SMITH!\n---\nOther.\n");
		expect(a.title).toBe("alex smith");
		expect(b.title).toBe(a.title);
	});

	it("has no title key when the title is only the file name", () => {
		expect(duplicateKeys("people/readme.md", "Some text without a heading.\n").title).toBeNull();
	});

	it("keys the opening sentence, and only when it is long enough to mean something", () => {
		const long = duplicateKeys("a/b.md", "# T\n\nThe kiln fires to cone six in about nine hours. More.\n");
		expect(long.opening).toBe("the kiln fires to cone six in about nine hours");
		expect(duplicateKeys("a/b.md", "# T\n\nTo do.\n").opening).toBeNull();
	});
});

describe("ftsQuery", () => {
	it("quotes each word and joins with OR", () => {
		expect(ftsQuery("Coffee order")).toBe('"coffee" OR "order"');
	});

	it("leaves no FTS5 syntax from the caller's text", () => {
		expect(ftsQuery('alex" AND (title: NEAR* -x')).toBe(
			'"alex" OR "and" OR "title" OR "near" OR "x"',
		);
	});

	it("is null when there is no word, and drops repeats", () => {
		expect(ftsQuery("  \"'()* ")).toBeNull();
		expect(ftsQuery("tea tea TEA")).toBe('"tea"');
	});

	it("keeps at most 16 words", () => {
		const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
		expect(ftsQuery(words)!.split(" OR ")).toHaveLength(16);
	});
});

describe("indexText", () => {
	const bytes = (text: string) => new TextEncoder().encode(text);

	it("cuts by bytes to a note's size and stays well-formed when the cut splits a character", () => {
		// U+1F600 is four bytes; the cut lands after the first.
		const cut = indexText(bytes("a".repeat(MAX_NOTE_BYTES - 1) + "\u{1F600}" + "tail"));
		expect(cut.isWellFormed()).toBe(true);
		expect(cut).toBe("a".repeat(MAX_NOTE_BYTES - 1) + "\uFFFD");
	});

	it("counts bytes, not characters", () => {
		// Each character is two bytes, so half as many characters fit.
		const cut = indexText(bytes("\u00e9".repeat(MAX_NOTE_BYTES)));
		expect(cut).toBe("\u00e9".repeat(MAX_NOTE_BYTES / 2));
	});

	it("gives the same text whether or not the bytes were already cut", () => {
		const whole = bytes("b".repeat(MAX_NOTE_BYTES - 2) + "\u{1F600}\u{1F600}");
		expect(indexText(whole.slice(0, MAX_NOTE_BYTES))).toBe(indexText(whole));
	});

	it("leaves a short text alone", () => {
		expect(indexText(bytes("# Short\n"))).toBe("# Short\n");
	});
});

describe("folderPrefix", () => {
	it("turns a folder into a prefix ending in a slash", () => {
		expect(folderPrefix("people")).toBe("people/");
		expect(folderPrefix("/projects/alpha/")).toBe("projects/alpha/");
	});

	it("treats a missing or empty folder as no filter", () => {
		expect(folderPrefix(undefined)).toBeNull();
		expect(folderPrefix(" / ")).toBeNull();
	});

	it("refuses traversal, empty segments and control characters", () => {
		expect(folderPrefix("../x")).toBe(false);
		expect(folderPrefix("a//b")).toBe(false);
		expect(folderPrefix("a\u0000b")).toBe(false);
	});
});

describe("buildContext", () => {
	const pinned = [
		{ path: "preferences/style.md", title: "Style", text: "# Style\n\nShort answers.\n" },
		{ path: "profile/me.md", title: "Me", text: "# Me\n\nA potter.\n" },
	];

	it("returns pinned notes in full and lists the rest when it fits", () => {
		const others = [{ path: "people/alex.md", title: "Alex", summary: "A coworker." }];
		const answer = buildContext(pinned, others);
		expect(answer.notes).toEqual(pinned);
		expect(answer.catalog).toEqual(others);
		expect(answer.folders).toBeUndefined();
		expect(answer.not_included).toBeUndefined();
		expect(answer.total_notes).toBe(3);
	});

	it("falls back to note counts by folder when the list does not fit", () => {
		const others = Array.from({ length: 500 }, (_, i) => ({
			path: `${["people", "projects/alpha", "projects/beta", "food"][i % 4]}/note-${i}.md`,
			title: `Note number ${i}`,
			summary: `This is the summary sentence of note number ${i}.`,
		}));
		const answer = buildContext(pinned, others);
		expect(JSON.stringify(answer).length).toBeLessThanOrEqual(CONTEXT_CAP_CHARS);
		expect(answer.catalog).toBeUndefined();
		expect(answer.folders).toEqual([
			{ folder: "food", notes: 125 },
			{ folder: "people", notes: 125 },
			{ folder: "projects/alpha", notes: 125 },
			{ folder: "projects/beta", notes: 125 },
		]);
		expect(answer.notes).toEqual(pinned);
		expect(answer.hint).toContain("memory_search");
	});

	it("falls back to top-level folders when there are too many folders", () => {
		const others = Array.from({ length: 900 }, (_, i) => ({
			path: `projects/a-long-folder-name-${i}/note.md`,
			title: "T",
			summary: "S",
		}));
		const answer = buildContext([], others);
		expect(JSON.stringify(answer).length).toBeLessThanOrEqual(CONTEXT_CAP_CHARS);
		expect(answer.folders).toEqual([{ folder: "projects", notes: 900 }]);
	});

	it("names a pinned note it had to leave out, and keeps the ones that fit", () => {
		const big = { path: "profile/big.md", title: "Big", text: "x".repeat(CONTEXT_CAP_CHARS) };
		const answer = buildContext([...pinned, big], []);
		expect(JSON.stringify(answer).length).toBeLessThanOrEqual(CONTEXT_CAP_CHARS);
		expect(answer.notes).toEqual(pinned);
		expect(answer.not_included).toEqual([{ path: "profile/big.md", title: "Big" }]);
	});

	it("pins only the profile and preferences folders", () => {
		expect(isPinned("profile/me.md")).toBe(true);
		expect(isPinned("preferences/a/b.md")).toBe(true);
		expect(isPinned("people/profile/x.md")).toBe(false);
		expect(isPinned("profiles/x.md")).toBe(false);
	});
});

type Entry = { name: string; mode: string; hash: string; type: ArtifactsTreeEntryType };

function fakeRepo(trees: Record<string, Entry[]>) {
	const reads: string[] = [];
	return {
		reads,
		readTree: async (hash: string) => {
			reads.push(hash);
			return trees[hash] ?? null;
		},
	};
}

const file = (name: string, hash: string): Entry => ({ name, mode: "100644", hash, type: "blob" });
const dir = (name: string, hash: string): Entry => ({ name, mode: "40000", hash, type: "tree" });

describe("tree walking", () => {
	const trees: Record<string, Entry[]> = {
		root1: [dir("people", "p1"), dir("projects", "j1"), file("README.md", "r1")],
		root2: [dir("people", "p2"), dir("projects", "j1"), file("README.md", "r1")],
		p1: [file("alex.md", "a1"), file("bo.md", "b1")],
		p2: [
			file("alex.md", "a2"),
			file("cy.md", "c1"),
			{ name: "link.md", mode: "120000", hash: "l1", type: "symlink" },
			{ name: "sub", mode: "160000", hash: "s1", type: "gitlink" },
			file("notes.txt", "t1"),
		],
		j1: [file("kiln.md", "k1")],
	};

	it("lists regular .md files and skips symlinks, submodules and other files", async () => {
		const notes = await listNotes(new TreeCache(fakeRepo(trees)), "root2");
		expect([...notes.entries()].sort()).toEqual([
			["README.md", "r1"],
			["people/alex.md", "a2"],
			["people/cy.md", "c1"],
			["projects/kiln.md", "k1"],
		]);
	});

	it("diffs two trees without reading the unchanged folder", async () => {
		const repo = fakeRepo(trees);
		const changed = await changedPaths(new TreeCache(repo), "root2", "root1");
		expect([...changed].sort()).toEqual([
			"people/alex.md",
			"people/bo.md",
			"people/cy.md",
			"people/notes.txt",
		]);
		expect(repo.reads).not.toContain("j1");
	});

	it("fails when a tree the repo names reads as missing, after one retry", async () => {
		const repo = fakeRepo({ root1: trees.root1, j1: trees.j1 });
		const opts = { sleep: async () => {} };
		await expect(listNotes(new TreeCache(repo, opts), "root1")).rejects.toThrow(MissingTreeError);
		expect(repo.reads.filter((h) => h === "p1")).toHaveLength(2);
		await expect(
			changedPaths(new TreeCache(fakeRepo(trees), opts), "root1", "nope"),
		).rejects.toThrow(MissingTreeError);
	});

	it("treats a missing parent as an empty tree", async () => {
		const changed = await changedPaths(new TreeCache(fakeRepo(trees)), "root1", null);
		expect([...changed].sort()).toEqual([
			"README.md",
			"people/alex.md",
			"people/bo.md",
			"projects/kiln.md",
		]);
	});
});

describe("MemoryFS symlinks", () => {
	it("holds a link without following it", async () => {
		const fs = new MemoryFS();
		await fs.promises.writeFile("/a/real.md", "real");
		await fs.promises.symlink("real.md", "/a/link.md");
		expect(await fs.promises.readlink("/a/link.md")).toBe("real.md");
		const stats = await fs.promises.lstat("/a/link.md");
		expect(stats.isSymbolicLink()).toBe(true);
		expect(stats.isFile()).toBe(false);
		expect(stats.isDirectory()).toBe(false);
		await expect(fs.promises.readFile("/a/link.md")).rejects.toMatchObject({ code: "EINVAL" });
		await expect(fs.promises.readdir("/a/link.md")).rejects.toMatchObject({ code: "ENOTDIR" });
		expect(await fs.promises.readdir("/a")).toEqual(["link.md", "real.md"]);
		await fs.promises.unlink("/a/link.md");
		expect(await fs.promises.readdir("/a")).toEqual(["real.md"]);
	});

	it("refuses a link path that climbs above the root, and readlink on a file", async () => {
		const fs = new MemoryFS();
		await fs.promises.writeFile("/a.md", "x");
		await expect(fs.promises.symlink("x", "/../y")).rejects.toMatchObject({ code: "EACCES" });
		await expect(fs.promises.readlink("/a.md")).rejects.toMatchObject({ code: "EINVAL" });
	});
});
