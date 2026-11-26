// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// The index against a repo of 500 notes: the context call stays under its cap,
// and search and list still answer.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CONTEXT_CAP_CHARS } from "../src/context";
import { callTool } from "./helpers/mcp";
import { seedRepo } from "./helpers/seed";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const FOLDERS = ["people", "projects/alpha", "projects/beta", "food", "places/europe"];
const PROFILE = "# About me\n\nA potter who writes firmware.\n";

beforeAll(async () => {
	const files: Record<string, string> = {
		"profile/me.md": PROFILE,
		"preferences/style.md": "# Answer style\n\nShort answers, no filler.\n",
	};
	for (let i = 0; i < 500; i++) {
		files[`${FOLDERS[i % FOLDERS.length]}/note-${i}.md`] =
			`# Note number ${i}\n\nThis is the opening sentence of seeded note ${i}. Marker word${i}.\n`;
	}
	await seedRepo(env.ARTIFACTS, env.MEMORY_REPO, [{ message: "Add 502 notes", files }]);
});

describe("500 seeded notes", () => {
	it("memory_context stays under the cap, keeps the pinned notes whole, and counts by folder", async () => {
		const result = await callTool("memory_context", {});
		expect(result.isError, result.text).toBeFalsy();
		expect(result.text.length).toBeLessThanOrEqual(CONTEXT_CAP_CHARS);
		expect(result.json.total_notes).toBe(502);
		expect(result.json.notes.map((n: { path: string }) => n.path)).toEqual([
			"preferences/style.md",
			"profile/me.md",
		]);
		expect(result.json.notes[1].text).toBe(PROFILE);
		expect(result.json.catalog).toBeUndefined();
		expect(result.json.folders).toEqual(
			[...FOLDERS].sort().map((folder) => ({ folder, notes: 100 })),
		);
	});

	it("search finds one note among them, and list is capped at 500 with truncated set", async () => {
		const found = await callTool("memory_search", { query: "word317" });
		expect(found.json.results.map((r: { path: string }) => r.path)).toEqual([
			`${FOLDERS[317 % FOLDERS.length]}/note-317.md`,
		]);
		const list = await callTool("memory_list", {});
		expect(list.json.notes).toHaveLength(500);
		expect(list.json.truncated).toBe(true);
		const folder = await callTool("memory_list", { folder: "food" });
		expect(folder.json.notes).toHaveLength(100);
		expect(folder.json.truncated).toBe(false);
	});
});
