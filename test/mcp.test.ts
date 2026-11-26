// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
import { createExecutionContext, env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mcpHandler, WORKER_MS_META } from "../src/mcp";
import { seedRepo } from "./helpers/seed";

const ALPHA_V1 = "# Alpha\n\nFirst draft.\n";
const ALPHA_V2 = "# Alpha\n\nSecond draft.\n";

let alphaVersion = "";

async function rpc(method: string, params?: unknown): Promise<any> {
	const request = new Request("http://localhost:8787/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			// A constructed Request carries no Host header; the handler requires one.
			host: "localhost:8787",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const response = await mcpHandler(request, env, createExecutionContext());
	if (response.status !== 200) {
		throw new Error(`${response.status} ${await response.text()}`);
	}
	const text = await response.text();
	// The handler answers with a one-event SSE stream or plain JSON.
	const data = text.split("\n").find((line) => line.startsWith("data:"));
	return JSON.parse(data ? data.slice(5) : text);
}

async function callTool(name: string, args: Record<string, unknown>) {
	const body = await rpc("tools/call", { name, arguments: args });
	return body.result;
}

beforeAll(async () => {
	const seeded = await seedRepo(env.ARTIFACTS, env.MEMORY_REPO, [
		{ message: "Add alpha", files: { "projects/alpha.md": ALPHA_V1 } },
		{ message: "Add beta", files: { "projects/beta.md": "# Beta\n" } },
		{ message: "Revise alpha", files: { "projects/alpha.md": ALPHA_V2 } },
	]);
	alphaVersion = seeded.blobs[2]["projects/alpha.md"];
});

describe("MCP tools: list and read", () => {
	it("lists the seven tools", async () => {
		const body = await rpc("tools/list");
		const names = body.result.tools.map((t: { name: string }) => t.name).sort();
		expect(names).toEqual([
			"memory_context",
			"memory_delete",
			"memory_history",
			"memory_list",
			"memory_read",
			"memory_search",
			"memory_write",
		]);
	});

	it("sends the server instructions on initialize", async () => {
		const body = await rpc("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "1" },
		});
		expect(body.result.instructions).toContain("shared memory store");
		expect(body.result.instructions).toContain("Call memory_context first");
	});

	it("reads a note with its blob SHA as the version", async () => {
		const result = await callTool("memory_read", { path: "projects/alpha.md" });
		expect(result.isError).toBeFalsy();
		const note = JSON.parse(result.content[0].text);
		expect(note.text).toBe(ALPHA_V2);
		expect(note.version).toBe(alphaVersion);
		expect(note.author).toBe("seed-client");
	});

	it("returns a tool error for a missing note", async () => {
		const result = await callTool("memory_read", { path: "projects/nope.md" });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("projects/nope.md");
	});

	it("returns a tool error for an unknown ref", async () => {
		const result = await callTool("memory_read", { path: "projects/alpha.md", ref: "nope" });
		expect(result.isError).toBe(true);
	});

	it("returns a tool error for an invalid path", async () => {
		const result = await callTool("memory_read", { path: "../etc/passwd.md" });
		expect(result.isError).toBe(true);
	});

	it("reports the Worker's own time in the result, equal to the logged one, on success and on a tool error", async () => {
		const log = vi.spyOn(console, "log");
		try {
			const ok = await callTool("memory_read", { path: "projects/alpha.md" });
			const missing = await callTool("memory_read", { path: "projects/nope.md" });
			const logged = log.mock.calls
				.map((c) => JSON.parse(String(c[0])))
				.filter((line) => line.event === "tool" && line.tool === "memory_read");
			expect(logged).toHaveLength(2);
			expect(missing.isError).toBe(true);
			for (const [index, result] of [ok, missing].entries()) {
				const ms = result._meta[WORKER_MS_META];
				expect(Number.isInteger(ms) && ms >= 0).toBe(true);
				expect(ms).toBe(logged[index].ms);
				// Nothing else rides along: no path, no text.
				expect(Object.keys(result._meta)).toEqual([WORKER_MS_META]);
			}
		} finally {
			log.mockRestore();
		}
	});

	it("lists the two commits that changed a note", async () => {
		const result = await callTool("memory_history", { path: "projects/alpha.md" });
		expect(result.isError).toBeFalsy();
		const history = JSON.parse(result.content[0].text);
		expect(history.commits.map((c: { message: string }) => c.message)).toEqual([
			"Revise alpha",
			"Add alpha",
		]);
		expect(history.truncated).toBe(false);
	});
});
