// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// A symbolic link pushed directly to the notes repo must not block writes,
// and must not be indexed as a note.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { readBlobs } from "../src/git";
import { callTool } from "./helpers/mcp";
import { seedRepo } from "./helpers/seed";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

beforeAll(async () => {
	await seedRepo(env.ARTIFACTS, env.MEMORY_REPO, [
		{
			message: "Add a note, a link to it, and a link where a folder could be",
			files: { "projects/seed.md": "# Seed\n\nA seeded note about bassoons.\n" },
			links: { "projects/link.md": "seed.md", shortcut: "projects" },
		},
	]);
});

describe("a symlink in the notes repo", () => {
	it("is in the repo as a symlink", async () => {
		using repo = await env.ARTIFACTS.get(env.MEMORY_REPO);
		const head = (await repo.log({ ref: "main", limit: 1 }))[0];
		const root = await repo.readTree(head.treeHash);
		expect(root!.find((e) => e.name === "shortcut")!.type).toBe("symlink");
	});

	it("does not block a write, an update or a delete, and survives them", async () => {
		const path = "people/new.md";
		const created = await callTool("memory_write", { path, text: "# New\n\nWritten past the link.\n" });
		expect(created.isError, created.text).toBeFalsy();
		const updated = await callTool("memory_write", {
			path,
			text: "# New\n\nUpdated past the link.\n",
			base_version: created.json.version,
		});
		expect(updated.isError, updated.text).toBeFalsy();
		const deleted = await callTool("memory_delete", { path, base_version: updated.json.version });
		expect(deleted.isError, deleted.text).toBeFalsy();

		using repo = await env.ARTIFACTS.get(env.MEMORY_REPO);
		const head = (await repo.log({ ref: "main", limit: 1 }))[0];
		const root = await repo.readTree(head.treeHash);
		expect(root!.find((e) => e.name === "shortcut")).toMatchObject({ type: "symlink", mode: "120000" });
		const projects = await repo.readTree(root!.find((e) => e.name === "projects")!.hash);
		expect(projects!.find((e) => e.name === "link.md")!.type).toBe("symlink");
	});

	it("readBlobs fetches blobs with one clone, past the links, and omits an unknown one", async () => {
		using repo = await env.ARTIFACTS.get(env.MEMORY_REPO);
		const info = await repo.info();
		const token = await repo.createToken("read", 300);
		const seed = (await callTool("memory_read", { path: "projects/seed.md" })).json.version;
		const missing = "0".repeat(40);
		const { blobs, oversize } = await readBlobs(
			{ url: info.remote, token: token.plaintext.split("?expires=")[0] },
			[seed, missing],
		);
		expect([...blobs.keys()]).toEqual([seed]);
		expect(oversize.size).toBe(0);
		expect(new TextDecoder().decode(blobs.get(seed))).toContain("bassoons");
	});

	it("is not indexed as a note; the note it points at is", async () => {
		const found = await callTool("memory_search", { query: "bassoons" });
		expect(found.json.results.map((r: { path: string }) => r.path)).toEqual(["projects/seed.md"]);
		const list = await callTool("memory_list", {});
		expect(list.json.notes.map((n: { path: string }) => n.path)).toEqual(["projects/seed.md"]);
	});

	it("refuses a write below a link, naming it", async () => {
		const below = await callTool("memory_write", { path: "shortcut/x.md", text: "# X\n" });
		expect(below.isError).toBe(true);
		expect(below.json.rule).toBe("path-blocked");
		expect(below.json.message).toContain("shortcut");
	});

	it("will not replace or delete a link, even given the link's own blob id as the version", async () => {
		using repo = await env.ARTIFACTS.get(env.MEMORY_REPO);
		const linkEntry = async () => {
			const head = (await repo.log({ ref: "main", limit: 1 }))[0];
			const root = await repo.readTree(head.treeHash);
			const projects = await repo.readTree(root!.find((e) => e.name === "projects")!.hash);
			return { head: head.hash, entry: projects!.find((e) => e.name === "link.md")! };
		};
		const before = await linkEntry();
		const path = "projects/link.md";

		const create = await callTool("memory_write", { path, text: "# Replaced\n" });
		expect(create.isError).toBe(true);
		expect(create.json.rule).toBe("path-blocked");
		expect(create.json.message).toContain("symbolic link");
		expect(create.json.current_version).toBeUndefined();

		const update = await callTool("memory_write", {
			path,
			text: "# Replaced\n",
			base_version: before.entry.hash,
		});
		expect(update.json.rule).toBe("path-blocked");
		const remove = await callTool("memory_delete", { path, base_version: before.entry.hash });
		expect(remove.json.rule).toBe("path-blocked");

		const after = await linkEntry();
		expect(after.head).toBe(before.head);
		expect(after.entry).toEqual(before.entry);
		expect(after.entry.type).toBe("symlink");
	});
});
