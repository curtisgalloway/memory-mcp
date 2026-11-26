// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// A repo whose last note has been deleted: its head commit names the empty tree.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EMPTY_TREE } from "../src/tree";
import { callTool } from "./helpers/mcp";
import { seedRepo } from "./helpers/seed";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PATH = "people/only.md";

beforeAll(async () => {
	await seedRepo(env.ARTIFACTS, env.MEMORY_REPO, [
		{ message: "Add the only note", files: { [PATH]: "# Only\n\nThe only note: zampogna.\n" } },
	]);
});

describe("a repo emptied of notes", () => {
	it("indexes the note, then nothing once it is deleted, through a full reindex of the empty tree", async () => {
		const found = await callTool("memory_search", { query: "zampogna" });
		expect(found.json.results.map((r: { path: string }) => r.path)).toEqual([PATH]);
		const read = await callTool("memory_read", { path: PATH });
		const deleted = await callTool("memory_delete", { path: PATH, base_version: read.json.version });
		expect(deleted.isError, deleted.text).toBeFalsy();

		using repo = await env.ARTIFACTS.get(env.MEMORY_REPO);
		const head = (await repo.log({ ref: "main", limit: 1 }))[0];
		expect(head.hash).toBe(deleted.json.commit);
		expect(head.treeHash).toBe(EMPTY_TREE);
		// The simulator answers the empty tree with no entries, not with "missing".
		// The store does not depend on that: it knows the empty tree by its id.
		expect(await repo.readTree(EMPTY_TREE)).toEqual([]);

		const result = await env.MEMORY_STORE.getByName("main").reindex({ full: true });
		expect(result).toMatchObject({ state: "ok", head: head.hash, changed: 0, removed: 0, failed: 0 });
		expect((await callTool("memory_list", {})).json.notes).toEqual([]);
		expect((await callTool("memory_search", { query: "zampogna" })).json.results).toEqual([]);
		expect((await callTool("memory_context", {})).json.total_notes).toBe(0);
	});
});
