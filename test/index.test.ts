// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// The index in the MemoryStore Durable Object, against the local simulator:
// search, list, context, duplicates, reindex, the push event and the admin route.
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ADMIN_REINDEX_PATH, adminReindex } from "../src/admin";
import { OnRepoPushed, REINDEX_STEP } from "../src/events";
import { applyChange, readBlobs, type GitTarget } from "../src/git";
import { MAX_INDEXED_BLOB_BYTES, MAX_NOTE_BYTES } from "../src/notes";
import type { MemoryStore } from "../src/store";
import { callTool, CLIENT_NAME } from "./helpers/mcp";
import { SEED_EPOCH, seedRepo } from "./helpers/seed";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PUSH = "cf.artifacts.repo.pushed";
const MAIN = "refs/heads/main";
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

const COFFEE = "---\ntitle: Coffee order\nsummary: How the user takes their coffee\ntags: [food, drinks]\n---\nOat-milk flat white, no sugar.\n";
const ALEX = "# Alex Smith\n\nAlex is a coworker on the pottery project who likes espresso.\n";
const KILN = "# Kiln controller\n\nFirmware for the kiln. Alex reviews every change to it.\n";
const ME = "# About me\n\nA potter who writes firmware.\n";
const STYLE = "# Answer style\n\nShort answers, no filler.\n";

function store() {
	return env.MEMORY_STORE.getByName("main");
}

async function target(): Promise<GitTarget> {
	using repo = await env.ARTIFACTS.get(env.MEMORY_REPO);
	const info = await repo.info();
	const token = await repo.createToken("write", 300);
	return { url: info.remote, token: token.plaintext.split("?expires=")[0] };
}

/** A push the store did not make, as a git client with a write token would. */
async function directPush(path: string, text: string | null, baseVersion: string | null = null) {
	const result = await applyChange(await target(), {
		path,
		text,
		baseVersion,
		author: "git-user",
		message: `Direct ${path}`,
	});
	if (result.kind !== "pushed") throw new Error(`direct push: ${result.kind}`);
	return result;
}

async function meta(key: string): Promise<string | undefined> {
	return runInDurableObject(store(), (instance: MemoryStore) => {
		const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
		return sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0]?.value as
			| string
			| undefined;
	});
}

type Repo = Awaited<ReturnType<Artifacts["get"]>>;
interface RepoFaults {
	log?: (real: Repo, opts: { ref?: string; limit?: number; offset?: number }) => ReturnType<Repo["log"]>;
	readBlob?: (real: Repo, hash: string) => ReturnType<Repo["readBlob"]>;
	readTree?: (real: Repo, hash: string) => ReturnType<Repo["readTree"]>;
}

/** Makes the store see a repo whose named calls misbehave; undone by `restoreRepo`. */
async function faultRepo(faults: RepoFaults) {
	await runInDurableObject(store(), (instance: MemoryStore) => {
		const holder = instance as unknown as { env: Env; originalEnv?: Env };
		const original = (holder.originalEnv ??= holder.env);
		const artifacts = {
			get: async (name: string) => {
				const real = await original.ARTIFACTS.get(name);
				return {
					info: () => real.info(),
					createToken: (scope: "read" | "write", ttl: number) => real.createToken(scope, ttl),
					readCommit: (hash: string) => real.readCommit(hash),
					log: (opts: { ref?: string; limit?: number; offset?: number }) =>
						faults.log ? faults.log(real, opts) : real.log(opts),
					readBlob: (hash: string) =>
						faults.readBlob ? faults.readBlob(real, hash) : real.readBlob(hash),
					readTree: (hash: string) =>
						faults.readTree ? faults.readTree(real, hash) : real.readTree(hash),
					[Symbol.dispose]: () => real[Symbol.dispose](),
				};
			},
		};
		Object.defineProperty(holder, "env", {
			value: Object.assign(Object.create(original), { ARTIFACTS: artifacts }),
			configurable: true,
			writable: true,
		});
		instance.sleep = async () => {};
	});
}

async function restoreRepo() {
	await runInDurableObject(store(), (instance: MemoryStore) => {
		const holder = instance as unknown as { env: Env; originalEnv?: Env };
		if (holder.originalEnv) holder.env = holder.originalEnv;
		instance.http = undefined;
	});
}

async function rows() {
	return runInDurableObject(store(), (instance: MemoryStore) => {
		const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
		return sql
			.exec(
				"SELECT path, blob_sha, title, summary, tags, text, updated_at, author, title_key, opening_key FROM notes ORDER BY path",
			)
			.toArray();
	});
}

async function ftsRows() {
	return runInDurableObject(store(), (instance: MemoryStore) => {
		const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
		return sql.exec("SELECT path, title, tags, body FROM notes_fts ORDER BY path").toArray();
	});
}

async function search(query: string, extra: Record<string, unknown> = {}) {
	const result = await callTool("memory_search", { query, ...extra });
	expect(result.isError, result.text).toBeFalsy();
	return (result.json.results as { path: string; title: string; snippet: string }[]).map(
		(r) => r.path,
	);
}

beforeAll(async () => {
	await seedRepo(env.ARTIFACTS, env.MEMORY_REPO, [
		{
			message: "Add first notes",
			files: {
				"food/coffee.md": COFFEE,
				"people/alex-smith.md": ALEX,
				"profile/me.md": ME,
				"README.md": "# Readme\n\nNotes repository.\n",
				"docs/plan.txt": "not a note\n",
			},
		},
		{
			message: "Add more",
			author: "second-author",
			files: { "projects/kiln.md": KILN, "preferences/style.md": STYLE },
		},
	]);
});

describe("A1", () => {
	it("FTS5 is available in Durable Object SQLite, with porter stemming, bm25 and snippet", async () => {
		const found = await runInDurableObject(
			env.MEMORY_STORE.getByName("a1-probe"),
			(instance: MemoryStore) => {
				const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
				sql.exec("CREATE VIRTUAL TABLE a1 USING fts5(title, body, tokenize = 'porter unicode61')");
				sql.exec(
					"INSERT INTO a1 (title, body) VALUES ('Coffee order', 'Flat white.'), ('Alex', 'Sometimes drinks coffees.')",
				);
				return sql
					.exec(
						"SELECT title, snippet(a1, 1, '', '', '...', 8) AS snip FROM a1 WHERE a1 MATCH '\"coffee\"' ORDER BY bm25(a1, 5.0, 1.0)",
					)
					.toArray();
			},
		);
		expect(found).toEqual([
			{ title: "Coffee order", snip: "Flat white." },
			{ title: "Alex", snip: "Sometimes drinks coffees." },
		]);
	});
});

describe("index schema", () => {
	it("replaces the M2 notes table with the M3 index and forgets the indexed commit", async () => {
		const after = await runInDurableObject(
			env.MEMORY_STORE.getByName("old-schema"),
			(instance: MemoryStore) => {
				const holder = instance as unknown as { ctx: DurableObjectState; env: Env };
				const sql = holder.ctx.storage.sql;
				// The state a store deployed before M3 holds.
				sql.exec("DROP TABLE notes_fts");
				sql.exec("DROP TABLE notes");
				sql.exec("CREATE TABLE notes (path TEXT PRIMARY KEY, blob_sha TEXT NOT NULL)");
				sql.exec("INSERT INTO notes (path, blob_sha) VALUES ('people/old.md', 'abc')");
				sql.exec("DELETE FROM meta");
				sql.exec("INSERT INTO meta (key, value) VALUES ('last_pushed', 'abc'), ('indexed_commit', 'abc')");
				const Store = instance.constructor as new (ctx: DurableObjectState, env: Env) => MemoryStore;
				new Store(holder.ctx, holder.env);
				return {
					columns: sql.exec("SELECT name FROM pragma_table_info('notes')").toArray().map((r) => r.name),
					notes: sql.exec("SELECT COUNT(*) AS n FROM notes").one().n,
					fts: sql.exec("SELECT COUNT(*) AS n FROM notes_fts").one().n,
					meta: sql.exec("SELECT key, value FROM meta ORDER BY key").toArray(),
				};
			},
		);
		expect(after.columns).toContain("title_key");
		expect(after.notes).toBe(0);
		expect(after.fts).toBe(0);
		expect(after.meta).toEqual([
			{ key: "last_pushed", value: "abc" },
			{ key: "schema", value: "2" },
		]);
	});
});

describe("memory_search", () => {
	it("builds the index on first use and returns the note holding a seeded word first", async () => {
		const result = await callTool("memory_search", { query: "espresso" });
		expect(result.isError).toBeFalsy();
		expect(result.json.results).toHaveLength(1);
		expect(result.json.results[0].path).toBe("people/alex-smith.md");
		expect(result.json.results[0].title).toBe("Alex Smith");
		expect(result.json.results[0].snippet).toContain("espresso");
	});

	it("ranks a title match above a body match", async () => {
		expect(await search("kiln")).toEqual(["projects/kiln.md"]);
		expect((await search("alex"))[0]).toBe("people/alex-smith.md");
		expect(await search("alex")).toContain("projects/kiln.md");
	});

	it("ranks a note matching more of the words higher", async () => {
		expect((await search("alex firmware kiln"))[0]).toBe("projects/kiln.md");
	});

	it("matches tags, paths and word stems", async () => {
		expect(await search("drinks")).toEqual(["food/coffee.md"]);
		expect(await search("smith")).toEqual(["people/alex-smith.md"]);
		expect(await search("reviewing")).toEqual(["projects/kiln.md"]);
	});

	it("filters by folder and honors the limit", async () => {
		expect(await search("alex", { folder: "projects" })).toEqual(["projects/kiln.md"]);
		expect(await search("alex", { folder: "/people/" })).toEqual(["people/alex-smith.md"]);
		expect(await search("alex", { limit: 1 })).toEqual(["people/alex-smith.md"]);
		expect(await search("alex", { folder: "nowhere" })).toEqual([]);
	});

	it("treats FTS5 syntax in the query as plain words", async () => {
		expect(await search('espresso" OR (title:x NEAR*')).toContain("people/alex-smith.md");
	});

	it("refuses a query with no word and an unusable folder", async () => {
		const empty = await callTool("memory_search", { query: " *() " });
		expect(empty.isError).toBe(true);
		expect(empty.json.error).toBe("invalid_query");
		const folder = await callTool("memory_search", { query: "alex", folder: "../x" });
		expect(folder.json.error).toBe("invalid_query");
	});

	it("indexes a file readable at the top level, and not a non-note file", async () => {
		expect(await search("repository")).toEqual(["README.md"]);
		expect((await rows()).map((r) => r.path)).not.toContain("docs/plan.txt");
	});

	it("never logs the query", async () => {
		const log = vi.spyOn(console, "log");
		try {
			await search("espresso zzqueryword");
			const lines = log.mock.calls.map((c) => String(c[0]));
			expect(lines.some((l) => l.includes('"tool":"memory_search"'))).toBe(true);
			expect(lines.join("\n")).not.toContain("zzqueryword");
		} finally {
			log.mockRestore();
		}
	});
});

describe("memory_list", () => {
	it("lists every note with its title and the date of the commit that last changed it", async () => {
		const result = await callTool("memory_list", {});
		expect(result.isError).toBeFalsy();
		expect(result.json.truncated).toBe(false);
		expect(result.json.notes).toEqual([
			{ path: "README.md", title: "Readme", updated_at: iso(SEED_EPOCH) },
			{ path: "food/coffee.md", title: "Coffee order", updated_at: iso(SEED_EPOCH) },
			{ path: "people/alex-smith.md", title: "Alex Smith", updated_at: iso(SEED_EPOCH) },
			{ path: "preferences/style.md", title: "Answer style", updated_at: iso(SEED_EPOCH + 1) },
			{ path: "profile/me.md", title: "About me", updated_at: iso(SEED_EPOCH) },
			{ path: "projects/kiln.md", title: "Kiln controller", updated_at: iso(SEED_EPOCH + 1) },
		]);
	});

	it("lists one folder", async () => {
		const result = await callTool("memory_list", { folder: "people" });
		expect(result.json.notes.map((n: { path: string }) => n.path)).toEqual(["people/alex-smith.md"]);
		expect((await callTool("memory_list", { folder: "a//b" })).json.error).toBe("invalid_query");
	});

	it("records each note's author from its commit", async () => {
		const byPath = Object.fromEntries((await rows()).map((r) => [r.path, r.author]));
		expect(byPath["food/coffee.md"]).toBe("seed-client");
		expect(byPath["projects/kiln.md"]).toBe("second-author");
	});
});

describe("memory_read", () => {
	it("reports each note's own author and date, not the newest commit's", async () => {
		// The second seeded commit, by another author, did not touch the coffee note.
		const coffee = await callTool("memory_read", { path: "food/coffee.md" });
		expect(coffee.isError, coffee.text).toBeFalsy();
		expect(coffee.json).toMatchObject({ author: "seed-client", updated_at: iso(SEED_EPOCH) });
		const kiln = await callTool("memory_read", { path: "projects/kiln.md" });
		expect(kiln.json).toMatchObject({ author: "second-author", updated_at: iso(SEED_EPOCH + 1) });
	});
});

describe("memory_context", () => {
	it("returns profile and preferences in full and a catalog of the rest", async () => {
		const result = await callTool("memory_context", {});
		expect(result.isError).toBeFalsy();
		expect(result.json.notes).toEqual([
			{ path: "preferences/style.md", title: "Answer style", text: STYLE },
			{ path: "profile/me.md", title: "About me", text: ME },
		]);
		expect(result.json.catalog).toContainEqual({
			path: "food/coffee.md",
			title: "Coffee order",
			summary: "How the user takes their coffee",
		});
		expect(result.json.catalog.map((c: { path: string }) => c.path)).not.toContain("profile/me.md");
		expect(result.json.total_notes).toBe(6);
	});
});

describe("index and the write path", () => {
	it("a written note is searchable at once, an update replaces its text, a delete removes it", async () => {
		const path = "people/bo-tran.md";
		const created = await callTool("memory_write", {
			path,
			text: "# Bo Tran\n\nBo plays the theremin.\n",
		});
		expect(created.isError, created.text).toBeFalsy();
		expect(await search("theremin")).toEqual([path]);
		const row = (await rows()).find((r) => r.path === path)!;
		expect(row.blob_sha).toBe(created.json.version);
		expect(row.author).toBe(CLIENT_NAME);
		expect(row.title).toBe("Bo Tran");

		const updated = await callTool("memory_write", {
			path,
			text: "# Bo Tran\n\nBo plays the marimba.\n",
			base_version: created.json.version,
		});
		expect(updated.isError, updated.text).toBeFalsy();
		expect(await search("theremin")).toEqual([]);
		expect(await search("marimba")).toEqual([path]);

		const deleted = await callTool("memory_delete", { path, base_version: updated.json.version });
		expect(deleted.isError, deleted.text).toBeFalsy();
		expect(await search("marimba")).toEqual([]);
		expect((await ftsRows()).map((r) => r.path)).not.toContain(path);
	});

	it("a write that finds someone else's push under it brings the index up to date", async () => {
		await directPush("people/under.md", "# Under\n\nPushed under a write: glockenspiel.\n");
		expect(await search("glockenspiel")).toEqual([]);
		const written = await callTool("memory_write", {
			path: "people/over.md",
			text: "# Over\n\nWritten after it.\n",
		});
		expect(written.isError, written.text).toBeFalsy();
		expect(await search("glockenspiel")).toEqual(["people/under.md"]);
	});
});

describe("duplicates (R11)", () => {
	it("returns the existing note as a candidate when the title matches, and writes nothing", async () => {
		using repo = await env.ARTIFACTS.get(env.MEMORY_REPO);
		const before = (await repo.log({ ref: "main", limit: 100 })).length;
		const result = await callTool("memory_write", {
			path: "people/alex.md",
			text: "# Alex Smith\n\nA different first line.\n",
		});
		expect(result.isError).toBe(true);
		expect(result.json.error).toBe("duplicates");
		expect(result.json.candidates).toEqual([
			{
				path: "people/alex-smith.md",
				title: "Alex Smith",
				summary: "Alex is a coworker on the pottery project who likes espresso.",
			},
		]);
		expect(result.json.message).toContain("force");
		expect((await repo.log({ ref: "main", limit: 100 })).length).toBe(before);
	});

	it("matches on the opening sentence under a different title", async () => {
		const result = await callTool("memory_write", {
			path: "people/coworker.md",
			text: "# A coworker\n\nAlex is a coworker on the pottery project who likes ESPRESSO!\n",
		});
		expect(result.json.error).toBe("duplicates");
		expect(result.json.candidates[0].path).toBe("people/alex-smith.md");
	});

	it("writes the note when force is true", async () => {
		const result = await callTool("memory_write", {
			path: "people/alex.md",
			text: "# Alex Smith\n\nA second Alex Smith, the plumber.\n",
			force: true,
		});
		expect(result.isError, result.text).toBeFalsy();
		expect(result.json.commit).toMatch(/^[0-9a-f]{40}$/);
	});

	it("does not check an update, or a create on a path that already exists", async () => {
		const read = await callTool("memory_read", { path: "people/alex.md" });
		const update = await callTool("memory_write", {
			path: "people/alex.md",
			text: "# Alex Smith\n\nThe plumber; fixed the kiln room sink.\n",
			base_version: read.json.version,
		});
		expect(update.isError, update.text).toBeFalsy();
		const create = await callTool("memory_write", {
			path: "people/alex.md",
			text: "# Alex Smith\n\nSomething else.\n",
		});
		expect(create.json.error).toBe("conflict");
	});

	it("does not call two untitled notes with the same file name duplicates", async () => {
		const first = await callTool("memory_write", { path: "people/todo.md", text: "Call Bo.\n" });
		expect(first.isError, first.text).toBeFalsy();
		const second = await callTool("memory_write", { path: "projects/todo.md", text: "Fix sink.\n" });
		expect(second.isError, second.text).toBeFalsy();
	});
});

describe("reindex (R6)", () => {
	it("dropping the index and rebuilding gives identical rows and search results", async () => {
		const queries = ["alex", "kiln firmware", "coffee", "plumber", "glockenspiel", "todo"];
		const snapshot = async () => {
			// The tool calls come first: a dropped index is rebuilt on first use.
			const searches = [];
			for (const query of queries) searches.push((await callTool("memory_search", { query })).json);
			return {
				searches,
				list: (await callTool("memory_list", {})).json,
				context: (await callTool("memory_context", {})).json,
				rows: await rows(),
				fts: await ftsRows(),
			};
		};
		const before = await snapshot();
		expect(before.rows.length).toBeGreaterThan(8);
		// Rows written by the store itself must come back the same from the commits.
		expect(before.rows.find((r) => r.path === "people/alex.md")!.author).toBe(CLIENT_NAME);

		const response = await adminReindex(
			new Request(`http://localhost:8787${ADMIN_REINDEX_PATH}?full=1`, { method: "POST" }),
			env,
		);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { ran: boolean; changed: number; skipped: number };
		expect(result.ran).toBe(true);
		expect(result.changed).toBe(before.rows.length);
		expect(result.skipped).toBe(0);
		expect(await snapshot()).toEqual(before);

		// The harder drop: the tables emptied behind the store's back.
		await runInDurableObject(store(), (instance: MemoryStore) => {
			const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
			sql.exec("DELETE FROM notes_fts");
			sql.exec("DELETE FROM notes");
			sql.exec("DELETE FROM meta WHERE key = 'indexed_commit'");
		});
		expect(await snapshot()).toEqual(before);
	});

	it("reads nothing when the index already matches main", async () => {
		const result = await store().reindex();
		expect(result.ran).toBe(false);
		expect(result.changed).toBe(0);
	});

	it("re-reads only the notes whose blob changed", async () => {
		const read = await callTool("memory_read", { path: "food/coffee.md" });
		await directPush("food/coffee.md", COFFEE.replace("no sugar", "one sugar"), read.json.version);
		await directPush("food/tea.md", "# Tea\n\nOolong, no milk.\n");
		const result = await store().reindex();
		expect(result).toMatchObject({ ran: true, changed: 2, removed: 0, skipped: 0 });
		expect(await search("oolong")).toEqual(["food/tea.md"]);
		expect((await rows()).find((r) => r.path === "food/tea.md")!.author).toBe("git-user");
	});
});

describe("push event", () => {
	const event = (after: string, over: Record<string, unknown> = {}) => ({
		type: PUSH,
		repo: env.MEMORY_REPO,
		ref: MAIN,
		after,
		...over,
	});

	it("a direct push becomes searchable when its event arrives", async () => {
		const pushed = await directPush("people/direct.md", "# Direct\n\nPushed with git: xylophone.\n");
		expect(await search("xylophone")).toEqual([]);
		const result = await store().pushed(event(pushed.commit));
		expect(result).toMatchObject({ action: "reindexed", ran: true, changed: 1, head: pushed.commit });
		expect(await search("xylophone")).toEqual(["people/direct.md"]);
		const row = (await rows()).find((r) => r.path === "people/direct.md")!;
		expect(row.author).toBe("git-user");
		expect(row.updated_at).toBe(pushed.at);
	});

	it("a direct delete leaves search when its event arrives", async () => {
		const read = await callTool("memory_read", { path: "people/direct.md" });
		const pushed = await directPush("people/direct.md", null, read.json.version);
		const result = await store().pushed(event(pushed.commit));
		expect(result).toMatchObject({ action: "reindexed", removed: 1, changed: 0 });
		expect(await search("xylophone")).toEqual([]);
	});

	it("skips the event for the store's own push, which the index already covers", async () => {
		const written = await callTool("memory_write", {
			path: "people/own.md",
			text: "# Own\n\nWritten through the tool.\n",
		});
		expect(written.isError, written.text).toBeFalsy();
		expect(await meta("indexed_commit")).toBe(written.json.commit);
		expect(await store().pushed(event(written.json.commit))).toEqual({
			action: "ignored",
			why: "indexed",
		});
	});

	it("skips a repeated event for a direct push: the indexed commit, not the store's last push", async () => {
		const pushed = await directPush("people/twice.md", "# Twice\n\nIts event comes twice.\n");
		expect(await store().pushed(event(pushed.commit))).toMatchObject({ action: "reindexed", changed: 1 });
		expect(await meta("indexed_commit")).toBe(pushed.commit);
		expect(await meta("last_pushed")).not.toBe(pushed.commit);
		expect(await store().pushed(event(pushed.commit))).toEqual({ action: "ignored", why: "indexed" });
	});

	it("an event naming a commit main does not show asks to be sent again and changes nothing", async () => {
		const before = { rows: await rows(), mark: await meta("indexed_commit") };
		const result = await store().pushed(event("0".repeat(40)));
		expect(result).toMatchObject({ action: "retry", why: "behind", ran: false, changed: 0, removed: 0 });
		expect(await rows()).toEqual(before.rows);
		expect(await meta("indexed_commit")).toBe(before.mark);
	});

	it("ignores other events, repos and branches", async () => {
		const any = "1".repeat(40);
		expect(await store().pushed(event(any, { type: "cf.artifacts.repo.cloned" }))).toEqual({
			action: "ignored",
			why: "not_a_push",
		});
		expect(await store().pushed(event(any, { repo: "some-other-repo" }))).toEqual({
			action: "ignored",
			why: "other_repo",
		});
		expect(await store().pushed(event(any, { ref: "refs/heads/draft" }))).toEqual({
			action: "ignored",
			why: "other_ref",
		});
		expect(await store().pushed({})).toEqual({ action: "ignored", why: "not_a_push" });
	});

	it("the Workflow hands the event's fields to the store", async () => {
		const pushed = await directPush("people/flow.md", "# Flow\n\nThrough the workflow: vibraphone.\n");
		// The platform constructs a Workflow; here its run method gets a stand-in.
		const workflow = { run: OnRepoPushed.prototype.run.bind({ env } as never) };
		const configs: unknown[] = [];
		const step = {
			do: (_name: string, config: unknown, run: () => Promise<unknown>) => {
				configs.push(config);
				return run();
			},
		};
		const message = {
			type: PUSH,
			source: { type: "artifacts.repo", namespace: "default", repoName: env.MEMORY_REPO },
			payload: { ref: MAIN, before: "0".repeat(40), after: pushed.commit, commits: [] },
			metadata: { eventSchemaVersion: 1 },
		};
		const outcome = await workflow.run(
			{ payload: message, timestamp: new Date(), instanceId: "test" } as never,
			step as never,
		);
		expect(outcome).toBe("reindexed");
		expect(await search("vibraphone")).toEqual(["people/flow.md"]);
		const again = await workflow.run(
			{ payload: message, timestamp: new Date(), instanceId: "test" } as never,
			step as never,
		);
		expect(again).toBe("ignored:indexed");
		// Every run of the step carries the bounded retry setting.
		expect(configs).toEqual([REINDEX_STEP, REINDEX_STEP]);
		expect(REINDEX_STEP.retries).toEqual({ limit: 3, delay: "5 seconds", backoff: "exponential" });
	});
});

describe("reindex failures", () => {
	afterEach(async () => {
		await restoreRepo();
	});

	it("F1: a note whose read fails keeps its row and the old mark; the next reindex picks it up", async () => {
		const read = await callTool("memory_read", { path: "food/tea.md" });
		const mark = await meta("indexed_commit");
		await directPush("food/tea.md", "# Tea\n\nDarjeeling now, still no milk.\n", read.json.version);
		await directPush("food/toast.md", "# Toast\n\nSourdough, well done.\n");
		let reads = 0;
		await faultRepo({
			readBlob: async () => {
				reads += 1;
				throw new Error("transient");
			},
		});
		const failed = await store().reindex();
		expect(failed).toMatchObject({ state: "incomplete", ran: true, changed: 0, skipped: 0, failed: 2 });
		// Each read is tried twice before it counts as failed.
		expect(reads).toBe(4);
		expect(await meta("indexed_commit")).toBe(mark);
		const tea = (await rows()).find((r) => r.path === "food/tea.md")!;
		expect(tea.blob_sha).toBe(read.json.version);
		expect(await search("oolong")).toEqual(["food/tea.md"]);

		await restoreRepo();
		const retried = await store().reindex();
		expect(retried).toMatchObject({ ran: true, changed: 2, failed: 0 });
		expect(await meta("indexed_commit")).toBe(retried.head);
		expect(await search("darjeeling")).toEqual(["food/tea.md"]);
		expect(await search("sourdough")).toEqual(["food/toast.md"]);
	});

	it("F5: a tree that reads as missing fails the reindex, deleting nothing and leaving the mark", async () => {
		await directPush("food/jam.md", "# Jam\n\nDamson.\n");
		const before = { rows: await rows(), mark: await meta("indexed_commit") };
		await faultRepo({ readTree: async () => null });
		// Called inside the Durable Object so the thrown error stays in the test.
		const outcome = await runInDurableObject(store(), (instance: MemoryStore) =>
			instance.reindex().then(
				() => "resolved",
				(error: Error) => error.name,
			),
		);
		expect(outcome).toBe("MissingTreeError");
		expect(await rows()).toEqual(before.rows);
		expect(await meta("indexed_commit")).toBe(before.mark);
		await restoreRepo();
		expect(await store().reindex()).toMatchObject({ changed: 1, failed: 0 });
	});

	it("F6: a full reindex that cannot read the repo leaves the old index answering", async () => {
		const before = { rows: await rows(), mark: await meta("indexed_commit") };
		await faultRepo({
			readTree: async () => {
				throw new Error("down");
			},
		});
		const response = await adminReindex(
			new Request(`http://localhost:8787${ADMIN_REINDEX_PATH}?full=1`, { method: "POST" }),
			env,
		);
		expect(response.status).toBe(502);
		expect(await rows()).toEqual(before.rows);
		expect(await meta("indexed_commit")).toBe(before.mark);
		expect(await search("espresso")).toEqual(["people/alex-smith.md"]);
	});

	it("F6: a full reindex whose note reads fail keeps every row", async () => {
		const before = { rows: await rows(), mark: await meta("indexed_commit") };
		expect(before.rows.length).toBeGreaterThan(16);
		await faultRepo({
			readBlob: async () => {
				throw new Error("down");
			},
		});
		// With this many notes the reads go through one clone first; fail that too.
		await runInDurableObject(store(), (instance: MemoryStore) => {
			instance.http = {
				request: async () => {
					throw new Error("down");
				},
			};
		});
		const result = await store().reindex({ full: true });
		expect(result.state).toBe("incomplete");
		expect(result.failed).toBe(before.rows.length);
		expect(result.changed).toBe(0);
		expect(await rows()).toEqual(before.rows);
		expect(await meta("indexed_commit")).toBe(before.mark);

		// R2: the mark still names main's head, yet the full reindex is owed. The
		// next reindex, though not asked to be full, reads every note again.
		expect(before.mark).toBe(result.head);
		await restoreRepo();
		const next = await store().reindex();
		expect(next).toMatchObject({ state: "ok", ran: true, changed: before.rows.length, failed: 0 });
		expect(await rows()).toEqual(before.rows);
		// With the debt paid, a reindex of a current index reads nothing again.
		expect(await store().reindex()).toMatchObject({ state: "current", ran: false });
	});

	it("R1, R3: an event whose commit main does not show yet changes nothing and asks to be sent again", async () => {
		const pushed = await directPush("people/early.md", "# Early\n\nIts event outruns the log: crumhorn.\n");
		const before = { rows: await rows(), mark: await meta("indexed_commit") };
		const pushEvent = { type: PUSH, repo: env.MEMORY_REPO, ref: MAIN, after: pushed.commit };
		await faultRepo({
			log: async (real, opts) => (await real.log({ ...opts, limit: (opts.limit ?? 50) + 1 })).slice(1),
		});
		const early = await store().pushed(pushEvent);
		expect(early).toMatchObject({ action: "retry", why: "behind", ran: false, changed: 0 });
		expect(await rows()).toEqual(before.rows);
		expect(await meta("indexed_commit")).toBe(before.mark);

		// The Workflow turns that answer into a thrown step, which the platform retries.
		const workflow = { run: OnRepoPushed.prototype.run.bind({ env } as never) };
		const step = { do: (_name: string, _config: unknown, run: () => Promise<unknown>) => run() };
		const message = {
			type: PUSH,
			source: { repoName: env.MEMORY_REPO },
			payload: { ref: MAIN, after: pushed.commit },
		};
		const instance = { payload: message, timestamp: new Date(), instanceId: "test" } as never;
		await expect(workflow.run(instance, step as never)).rejects.toThrow("reindex behind");

		await restoreRepo();
		expect(await workflow.run(instance, step as never)).toBe("reindexed");
		expect(await search("crumhorn")).toEqual(["people/early.md"]);
	});

	it("R3: an event whose reindex could not read a note asks to be sent again, and the retry completes it", async () => {
		const pushed = await directPush("people/unread.md", "# Unread\n\nNot readable at first: shawm.\n");
		const pushEvent = { type: PUSH, repo: env.MEMORY_REPO, ref: MAIN, after: pushed.commit };
		await faultRepo({
			readBlob: async () => {
				throw new Error("transient");
			},
		});
		expect(await store().pushed(pushEvent)).toMatchObject({
			action: "retry",
			why: "incomplete",
			failed: 1,
		});
		expect(await search("shawm")).toEqual([]);
		await restoreRepo();
		expect(await store().pushed(pushEvent)).toMatchObject({ action: "reindexed", state: "ok", changed: 1 });
		expect(await search("shawm")).toEqual(["people/unread.md"]);
	});

	it("F2: the reindex after the store's own push does not undo it when main reads as behind; the event repairs it", async () => {
		await directPush("people/beneath.md", "# Beneath\n\nPushed first: sousaphone.\n");
		const mark = await meta("indexed_commit");
		// The binding answers as if the newest commit had not landed yet.
		await faultRepo({
			log: async (real, opts) => (await real.log({ ...opts, limit: (opts.limit ?? 50) + 1 })).slice(1),
		});
		const written = await callTool("memory_write", {
			path: "people/above.md",
			text: "# Above\n\nWritten on top: flugelhorn.\n",
		});
		expect(written.isError, written.text).toBeFalsy();
		// The row just written is kept, and the mark has not moved to the stale head.
		expect(await search("flugelhorn")).toEqual(["people/above.md"]);
		expect(await meta("indexed_commit")).toBe(mark);
		expect(await search("sousaphone")).toEqual([]);

		await restoreRepo();
		const repaired = await store().pushed({
			type: PUSH,
			repo: env.MEMORY_REPO,
			ref: MAIN,
			after: written.json.commit,
		});
		expect(repaired).toMatchObject({ action: "reindexed", ran: true, changed: 1, failed: 0 });
		expect(await meta("indexed_commit")).toBe(written.json.commit);
		expect(await search("sousaphone")).toEqual(["people/beneath.md"]);
		expect(await search("flugelhorn")).toEqual(["people/above.md"]);
	});

	it("F9: an own push whose following reindex failed is repaired by its own event", async () => {
		await directPush("people/missed.md", "# Missed\n\nPushed first: euphonium.\n");
		const mark = await meta("indexed_commit");
		await faultRepo({
			log: async () => {
				throw new Error("down");
			},
		});
		const written = await callTool("memory_write", {
			path: "people/landed.md",
			text: "# Landed\n\nWritten while the reindex failed.\n",
		});
		expect(written.isError, written.text).toBeFalsy();
		expect(await meta("last_pushed")).toBe(written.json.commit);
		expect(await meta("indexed_commit")).toBe(mark);
		expect(await search("euphonium")).toEqual([]);

		await restoreRepo();
		const repaired = await store().pushed({
			type: PUSH,
			repo: env.MEMORY_REPO,
			ref: MAIN,
			after: written.json.commit,
		});
		expect(repaired).toMatchObject({ action: "reindexed", ran: true, changed: 1 });
		expect(await search("euphonium")).toEqual(["people/missed.md"]);
	});

	it("F14: a file over the note limit is indexed by its first 64 KiB, and one far over is left out", async () => {
		const big = `# Big\n\nStarts with contrabassoon.\n${"x ".repeat(40 * 1024)}\nends with heckelphone\n`;
		const huge = `# Huge\n\nStarts with sarrusophone.\n${"y ".repeat(600 * 1024)}`;
		expect(new TextEncoder().encode(big).byteLength).toBeGreaterThan(MAX_NOTE_BYTES);
		expect(new TextEncoder().encode(huge).byteLength).toBeGreaterThan(MAX_INDEXED_BLOB_BYTES);
		const first = await directPush("people/big.md", big);
		const second = await directPush("people/huge.md", huge);
		const result = await store().reindex();
		expect(result).toMatchObject({ changed: 1, skipped: 1, failed: 0, head: second.commit });
		expect(await meta("indexed_commit")).toBe(second.commit);
		expect(await search("contrabassoon")).toEqual(["people/big.md"]);
		expect(await search("heckelphone")).toEqual([]);
		expect(await search("sarrusophone")).toEqual([]);
		const row = (await rows()).find((r) => r.path === "people/big.md")!;
		expect((row.text as string).length).toBe(MAX_NOTE_BYTES);
		expect((await rows()).map((r) => r.path)).not.toContain("people/huge.md");

		// The same two blobs through the bulk path, which cuts them as it reads.
		const { blobs, oversize } = await readBlobs(await target(), [first.version!, second.version!]);
		expect(blobs.get(first.version!)!.byteLength).toBe(MAX_NOTE_BYTES);
		expect([...oversize]).toEqual([second.version]);
		expect(blobs.has(second.version!)).toBe(false);
	});
});

describe("admin reindex route", () => {
	it("is refused without a grant", async () => {
		const response = await exports.default.fetch(`http://localhost:8787${ADMIN_REINDEX_PATH}`, {
			method: "POST",
		});
		expect(response.status).toBe(401);
	});

	it("accepts only POST", async () => {
		const response = await adminReindex(
			new Request(`http://localhost:8787${ADMIN_REINDEX_PATH}`),
			env,
		);
		expect(response.status).toBe(405);
	});

	it("reindexes what differs when called", async () => {
		await directPush("people/admin.md", "# Admin\n\nFound by the admin route: ocarina.\n");
		const response = await adminReindex(
			new Request(`http://localhost:8787${ADMIN_REINDEX_PATH}`, { method: "POST" }),
			env,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ran: true, changed: 1 });
		expect(await search("ocarina")).toEqual(["people/admin.md"]);
	});
});
