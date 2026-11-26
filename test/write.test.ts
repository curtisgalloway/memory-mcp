// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
import { env, runInDurableObject } from "cloudflare:test";
import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";
import webHttp from "isomorphic-git/http/web";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyChange, type GitTarget } from "../src/git";
import type { MemoryStore } from "../src/store";
import { callTool, CLIENT_NAME } from "./helpers/mcp";
import { seedRepo } from "./helpers/seed";

// Each write is a clone and a push against the local simulator, about a second.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SEED_PATH = "projects/seed.md";
const SEED_TEXT = "# Seed\n\nA seeded note.\n";
const ZERO = "0".repeat(40);

function stub() {
	return env.MEMORY_STORE.getByName("main");
}

async function commits() {
	using repo = await env.ARTIFACTS.get(env.MEMORY_REPO);
	return repo.log({ ref: "main", limit: 50 });
}

async function target(): Promise<GitTarget> {
	using repo = await env.ARTIFACTS.get(env.MEMORY_REPO);
	const info = await repo.info();
	const token = await repo.createToken("write", 300);
	return { url: info.remote, token: token.plaintext.split("?expires=")[0] };
}

async function tables() {
	return runInDurableObject(stub(), (instance: MemoryStore) => {
		const sql = (instance as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
		return {
			notes: sql.exec("SELECT path, blob_sha FROM notes ORDER BY path").toArray(),
			meta: sql.exec("SELECT key, value FROM meta ORDER BY key").toArray(),
		};
	});
}

async function useHttp(http: HttpClient | undefined) {
	await runInDurableObject(stub(), (instance: MemoryStore) => {
		instance.http = http;
	});
}

function isPush(request: GitHttpRequest): boolean {
	return request.method === "POST" && request.url.endsWith("git-receive-pack");
}

/** An HTTP client that lets `onPush` act in place of, or around, the push request. */
function http(onPush: (request: GitHttpRequest, once: boolean) => Promise<GitHttpResponse>): HttpClient {
	let pushes = 0;
	return {
		request: (request) =>
			isPush(request) ? onPush(request, pushes++ === 0) : webHttp.request(request),
	};
}

async function write(path: string, text: string, baseVersion?: string, message?: string) {
	return callTool("memory_write", {
		path,
		text,
		...(baseVersion === undefined ? {} : { base_version: baseVersion }),
		...(message === undefined ? {} : { message }),
	});
}

beforeAll(async () => {
	await seedRepo(env.ARTIFACTS, env.MEMORY_REPO, [
		{ message: "Add seed", files: { [SEED_PATH]: SEED_TEXT, "wall/ward": "a file, not a folder\n" } },
	]);
});

/** Makes the store's first `times` landed-check lookups (repo.log) throw. */
async function failLog(times: number) {
	await runInDurableObject(stub(), (instance: MemoryStore) => {
		const holder = instance as unknown as { env: Env; originalEnv?: Env };
		const original = (holder.originalEnv ??= holder.env);
		let remaining = times;
		const artifacts = {
			get: async (name: string) => {
				const real = await original.ARTIFACTS.get(name);
				return {
					info: () => real.info(),
					createToken: (scope: "read" | "write", ttl: number) => real.createToken(scope, ttl),
					log: async (options: { ref: string; limit: number }) => {
						if (remaining-- > 0) throw new Error("lookup failed");
						return real.log(options);
					},
					[Symbol.dispose]: () => real[Symbol.dispose](),
				};
			},
		};
		Object.defineProperty(holder, "env", {
			value: Object.assign(Object.create(original), { ARTIFACTS: artifacts }),
			configurable: true,
			writable: true,
		});
	});
}

async function restoreEnv() {
	await runInDurableObject(stub(), (instance: MemoryStore) => {
		const holder = instance as unknown as { env: Env; originalEnv?: Env };
		if (holder.originalEnv) holder.env = holder.originalEnv;
	});
}

beforeEach(async () => {
	await runInDurableObject(stub(), (instance: MemoryStore) => {
		instance.sleep = async () => {};
	});
});

afterEach(async () => {
	await useHttp(undefined);
	await restoreEnv();
});

describe("write tools", () => {
	it("create, update and delete each make one commit authored by the client name", async () => {
		const path = "people/ann-lee.md";
		const start = (await commits()).length;

		const created = await write(path, "# Ann\n\nLikes tea.\n");
		expect(created.isError).toBeFalsy();
		expect(created.json.commit).toMatch(/^[0-9a-f]{40}$/);
		let log = await commits();
		expect(log).toHaveLength(start + 1);
		expect(log[0].hash).toBe(created.json.commit);
		expect(log[0].author.name).toBe(CLIENT_NAME);
		expect(log[0].message).toBe(`Add ${path}`);
		let read = await callTool("memory_read", { path });
		expect(read.json.text).toBe("# Ann\n\nLikes tea.\n");
		expect(read.json.version).toBe(created.json.version);

		const updated = await write(path, "# Ann\n\nLikes coffee.\n", created.json.version);
		expect(updated.isError).toBeFalsy();
		log = await commits();
		expect(log).toHaveLength(start + 2);
		expect(log[0].author.name).toBe(CLIENT_NAME);
		expect(log[0].message).toBe(`Update ${path}`);
		read = await callTool("memory_read", { path });
		expect(read.json.text).toBe("# Ann\n\nLikes coffee.\n");
		expect(read.json.version).toBe(updated.json.version);

		const deleted = await callTool("memory_delete", {
			path,
			base_version: updated.json.version,
		});
		expect(deleted.isError).toBeFalsy();
		log = await commits();
		expect(log).toHaveLength(start + 3);
		expect(log[0].author.name).toBe(CLIENT_NAME);
		expect(log[0].message).toBe(`Delete ${path}`);
		expect(deleted.json.commit).toBe(log[0].hash);
		read = await callTool("memory_read", { path });
		expect(read.isError).toBe(true);
		expect(read.text).toContain("No note at");
	});

	it("keeps the notes table and last_pushed in step with pushes", async () => {
		const path = "people/table-check.md";
		const created = await write(path, "# Table\n");
		const rows = await tables();
		expect(rows.notes).toContainEqual({ path, blob_sha: created.json.version });
		expect(rows.meta).toContainEqual({ key: "last_pushed", value: created.json.commit });
		await callTool("memory_delete", { path, base_version: created.json.version });
		expect((await tables()).notes.map((r) => r.path)).not.toContain(path);
	});

	it("two concurrent writes with the same base_version: one succeeds, one conflicts", async () => {
		const path = "people/race.md";
		const created = await write(path, "# Race\n\nv1\n");
		const start = (await commits()).length;
		const [a, b] = await Promise.all([
			write(path, "# Race\n\nfrom a\n", created.json.version),
			write(path, "# Race\n\nfrom b\n", created.json.version),
		]);
		const results = [a, b];
		expect(results.filter((r) => !r.isError)).toHaveLength(1);
		const lost = results.find((r) => r.isError)!;
		expect(lost.json.error).toBe("conflict");
		const winner = results.find((r) => !r.isError)!;
		expect(lost.json.current_version).toBe(winner.json.version);
		expect(await commits()).toHaveLength(start + 1);
	});

	it("refuses bad paths and oversize text, naming the rule, with no commit", async () => {
		const start = (await commits()).length;
		const cases: [string, string, string][] = [
			["../x.md", "# x\n", "traversal"],
			["people/Alex.md", "# x\n", "lowercase"],
			["a/b/c/d/e.md", "# x\n", "3 folders"],
			["people/alex.txt", "# x\n", ".md"],
			["people/big.md", "x".repeat(65 * 1024), "64 KiB"],
		];
		for (const [path, text, word] of cases) {
			const result = await write(path, text);
			expect(result.isError, path).toBe(true);
			expect(result.json.error, path).toBe("refused");
			expect(result.json.rule, path).toContain(word);
		}
		expect(await commits()).toHaveLength(start);
	});

	it("refuses a note holding an API key by pattern name, never quoting it", async () => {
		const key = "sk-ant-" + "a".repeat(40);
		const start = (await commits()).length;
		const refused = await write("people/keys.md", `# Keys\n\nmy key is ${key}\n`);
		expect(refused.isError).toBe(true);
		expect(refused.json.error).toBe("refused");
		expect(refused.json.rule).toBe("secret:anthropic-api-key");
		expect(refused.text).toContain("anthropic-api-key");
		expect(refused.text).not.toContain(key);
		expect(await commits()).toHaveLength(start);

		const accepted = await write("people/keys.md", "# Keys\n\nno key here\n");
		expect(accepted.isError).toBeFalsy();
	});

	it("refuses a secret in the commit message", async () => {
		const key = "sk-ant-" + "b".repeat(40);
		const start = (await commits()).length;
		const refused = await write("people/msg.md", "# Msg\n", undefined, `add ${key}`);
		expect(refused.isError).toBe(true);
		expect(refused.json.rule).toBe("secret:anthropic-api-key");
		expect(refused.text).not.toContain(key);
		expect(await commits()).toHaveLength(start);
	});

	it("refuses a secret that the commit-message length cut would split", async () => {
		// The cleaned message is cut at 200 characters; the scan must see it whole.
		const key = "sk-ant-" + "c".repeat(40);
		const start = (await commits()).length;
		const refused = await write("people/msg-cut.md", "# Msg\n", undefined, "x".repeat(190) + key);
		expect(refused.isError).toBe(true);
		expect(refused.json.rule).toBe("secret:anthropic-api-key");
		expect(await commits()).toHaveLength(start);
	});

	it("refuses a secret that only appears once control characters become spaces", async () => {
		const start = (await commits()).length;
		const refused = await write("people/msg-ctl.md", "# Msg\n", undefined, "password\n: hunter2");
		expect(refused.isError).toBe(true);
		expect(refused.json.rule).toBe("secret:password-line");
		expect(refused.text).not.toContain("hunter2");
		expect(await commits()).toHaveLength(start);
	});

	it("refuses text with an unpaired surrogate", async () => {
		const start = (await commits()).length;
		const refused = await write("people/surrogate.md", "a\ud800b");
		expect(refused.isError).toBe(true);
		expect(refused.json.error).toBe("refused");
		expect(refused.json.message).toContain("well-formed Unicode");
		expect(await commits()).toHaveLength(start);
	});

	it("refuses a path whose folder is an existing file, naming it", async () => {
		const start = (await commits()).length;
		const before = await tables();
		const refused = await write("wall/ward/notes.md", "# Notes\n");
		expect(refused.isError).toBe(true);
		expect(refused.json.error).toBe("refused");
		expect(refused.json.rule).toBe("path-blocked");
		expect(refused.json.message).toContain("wall/ward");
		expect(await tables()).toEqual(before);
		expect(await commits()).toHaveLength(start);
	});

	it("reports a conflict when creating a note that exists", async () => {
		const { json } = await callTool("memory_read", { path: SEED_PATH });
		const result = await write(SEED_PATH, "# Other\n");
		expect(result.isError).toBe(true);
		expect(result.json.error).toBe("conflict");
		expect(result.json.current_version).toBe(json.version);
	});

	it("reports a conflict when updating with a stale version", async () => {
		const path = "people/stale.md";
		const created = await write(path, "# Stale\n\none\n");
		await write(path, "# Stale\n\ntwo\n", created.json.version);
		const result = await write(path, "# Stale\n\nthree\n", created.json.version);
		expect(result.json.error).toBe("conflict");
		expect(result.json.current_version).not.toBe(created.json.version);
	});

	it("reports not_found when deleting a missing note", async () => {
		const result = await callTool("memory_delete", {
			path: "people/missing.md",
			base_version: ZERO,
		});
		expect(result.isError).toBe(true);
		expect(result.json.error).toBe("not_found");
	});

	it("reports a conflict when deleting with a stale version", async () => {
		const result = await callTool("memory_delete", { path: SEED_PATH, base_version: ZERO });
		expect(result.json.error).toBe("conflict");
		expect((await callTool("memory_read", { path: SEED_PATH })).isError).toBeFalsy();
	});

	it("treats identical text as unchanged, with no commit", async () => {
		const path = "people/same.md";
		const created = await write(path, "# Same\n");
		const start = (await commits()).length;
		const again = await write(path, "# Same\n", created.json.version);
		expect(again.isError).toBeFalsy();
		expect(again.json).toEqual({ version: created.json.version, commit: null, unchanged: true });
		expect(await commits()).toHaveLength(start);
	});

	it("errors without a commit when the call carries no grant props", async () => {
		const start = (await commits()).length;
		const result = await callTool(
			"memory_write",
			{ path: "people/anon.md", text: "# Anon\n" },
			null,
		);
		expect(result.isError).toBe(true);
		expect(result.json.error).toBe("no_identity");
		expect(await commits()).toHaveLength(start);
	});
});

describe("push failures", () => {
	it("a push that throws is retryable and changes nothing", async () => {
		const path = "people/push-fails.md";
		const start = (await commits()).length;
		const before = await tables();
		await useHttp(
			http(async () => {
				throw new Error("network down");
			}),
		);
		const result = await write(path, "# Fails\n");
		expect(result.isError).toBe(true);
		expect(result.json.error).toBe("retryable");
		expect(await tables()).toEqual(before);
		expect(await commits()).toHaveLength(start);
	});

	it("a push answered with 503 is retryable and changes nothing", async () => {
		const path = "people/push-503.md";
		const start = (await commits()).length;
		const before = await tables();
		await useHttp(
			http(async (request) => ({
				url: request.url,
				method: request.method,
				statusCode: 503,
				statusMessage: "Service Unavailable",
				headers: {},
				body: (async function* () {})(),
			})),
		);
		const result = await write(path, "# Fails\n");
		expect(result.json.error).toBe("retryable");
		expect(await tables()).toEqual(before);
		expect(await commits()).toHaveLength(start);
	});

	it("a push that lands but loses its response counts as success", async () => {
		const path = "people/lost-response.md";
		await useHttp(
			http(async (request) => {
				await webHttp.request(request);
				throw new Error("response lost");
			}),
		);
		const result = await write(path, "# Landed\n");
		expect(result.isError).toBeFalsy();
		expect((await commits())[0].hash).toBe(result.json.commit);
		const rows = await tables();
		expect(rows.notes).toContainEqual({ path, blob_sha: result.json.version });
		expect(rows.meta).toContainEqual({ key: "last_pushed", value: result.json.commit });
	});

	it("a landed push whose first landed-check throws is found by the second try", async () => {
		const path = "people/check-retry.md";
		await useHttp(
			http(async (request) => {
				await webHttp.request(request);
				throw new Error("response lost");
			}),
		);
		await failLog(1);
		const result = await write(path, "# Check retry\n");
		expect(result.isError).toBeFalsy();
		expect((await commits())[0].hash).toBe(result.json.commit);
		expect((await tables()).notes).toContainEqual({ path, blob_sha: result.json.version });
	});

	it("a landed push whose landed-checks both throw is retryable, and resending it succeeds as unchanged", async () => {
		const path = "people/check-fails.md";
		const text = "# Check fails\n";
		await useHttp(
			http(async (request) => {
				await webHttp.request(request);
				throw new Error("response lost");
			}),
		);
		await failLog(2);
		const first = await write(path, text);
		expect(first.isError).toBe(true);
		expect(first.json.error).toBe("retryable");
		expect(first.json.message).not.toContain("Nothing was changed");
		expect((await tables()).notes.map((r) => r.path)).not.toContain(path);

		await useHttp(undefined);
		await restoreEnv();
		const start = (await commits()).length;
		const again = await write(path, text);
		expect(again.isError).toBeFalsy();
		expect(again.json.unchanged).toBe(true);
		expect(await commits()).toHaveLength(start);
		const read = await callTool("memory_read", { path });
		expect(again.json.version).toBe(read.json.version);
		expect((await tables()).notes).toContainEqual({ path, blob_sha: read.json.version });
	});

	it("resending a create that already landed, with identical text, is unchanged", async () => {
		const path = "people/create-resend.md";
		const created = await write(path, "# Resend\n");
		const start = (await commits()).length;
		const again = await write(path, "# Resend\n");
		expect(again.isError).toBeFalsy();
		expect(again.json).toEqual({ version: created.json.version, commit: null, unchanged: true });
		expect(await commits()).toHaveLength(start);
	});

	it("a rejected push is retried and succeeds when the note itself did not change", async () => {
		const path = "people/retry-ok.md";
		const other = await target();
		await useHttp(
			http(async (request, once) => {
				if (once) {
					await applyChange(other, {
						path: "people/interloper.md",
						text: `# Interloper ${crypto.randomUUID()}\n`,
						baseVersion: null,
						author: "someone-else",
						message: "Interloper",
					});
				}
				return webHttp.request(request);
			}),
		);
		const result = await write(path, "# Retry\n");
		expect(result.isError).toBeFalsy();
		expect((await callTool("memory_read", { path })).json.text).toBe("# Retry\n");
	});

	it("a rejected push is a conflict when the note itself changed meanwhile", async () => {
		const path = "people/retry-conflict.md";
		const created = await write(path, "# Base\n");
		const other = await target();
		await useHttp(
			http(async (request, once) => {
				if (once) {
					await applyChange(other, {
						path,
						text: "# Changed elsewhere\n",
						baseVersion: created.json.version,
						author: "someone-else",
						message: "Change elsewhere",
					});
				}
				return webHttp.request(request);
			}),
		);
		const result = await write(path, "# Mine\n", created.json.version);
		expect(result.isError).toBe(true);
		expect(result.json.error).toBe("conflict");
		expect((await callTool("memory_read", { path })).json.text).toBe("# Changed elsewhere\n");
	});
});

describe("store and git layer", () => {
	it("keeps working after a job throws", async () => {
		// Called inside the Durable Object so the thrown error stays in the test
		// instead of surfacing as an unhandled rejection from the RPC layer.
		const outcome = await runInDurableObject(stub(), async (instance: MemoryStore) => {
			const first = await instance
				.remove({ path: "../x.md", baseVersion: ZERO, author: "a", message: "m" })
				.then(
					() => "resolved",
					() => "rejected",
				);
			const second = await instance.write({
				path: "people/after-throw.md",
				text: "# After\n",
				baseVersion: null,
				author: "a",
				message: "m",
			});
			return { first, second };
		});
		expect(outcome.first).toBe("rejected");
		expect(outcome.second.ok).toBe(true);
	});

	it("applyChange refuses an invalid path even when called directly", async () => {
		const change = { text: "x\n", baseVersion: null, author: "a", message: "m" };
		for (const path of ["../x.md", "/etc/x.md", "a/../../x.md", "People/x.md", "x.md"]) {
			await expect(
				applyChange({ url: "https://invalid.invalid/repo.git", token: "t" }, { ...change, path }),
				path,
			).rejects.toThrow(/invalid note path/);
		}
	});

	it("applyChange refuses to write below a path that is a file", async () => {
		const name = `blocked-${crypto.randomUUID().slice(0, 8)}`;
		await seedRepo(env.ARTIFACTS, name, [
			{ message: "Add a file where a folder is wanted", files: { "people/alex": "plain file\n" } },
		]);
		using repo = await env.ARTIFACTS.get(name);
		const info = await repo.info();
		const token = await repo.createToken("write", 300);
		const blockedTarget: GitTarget = {
			url: info.remote,
			token: token.plaintext.split("?expires=")[0],
		};
		const result = await applyChange(blockedTarget, {
			path: "people/alex/notes.md",
			text: "# Notes\n",
			baseVersion: null,
			author: "a",
			message: "m",
		});
		expect(result).toEqual({ kind: "blocked", at: "people/alex" });
		expect(await repo.log({ ref: "main", limit: 5 })).toHaveLength(1);
	});

	it("applyChange makes the first commit in an empty repository", async () => {
		const created = await env.ARTIFACTS.create(`empty-${crypto.randomUUID().slice(0, 8)}`);
		const empty: GitTarget = { url: created.remote, token: created.token.split("?expires=")[0] };
		const first = await applyChange(empty, {
			path: "people/first.md",
			text: "# First\n",
			baseVersion: null,
			author: "a",
			message: "First",
		});
		expect(first.kind).toBe("pushed");
		const second = await applyChange(empty, {
			path: "people/first.md",
			text: "# First again\n",
			baseVersion: first.kind === "pushed" ? first.version : null,
			author: "a",
			message: "Second",
		});
		expect(second.kind).toBe("pushed");
		using repo = await env.ARTIFACTS.get(created.name);
		expect((await repo.log({ ref: "main", limit: 5 })).map((c) => c.message)).toEqual([
			"Second",
			"First",
		]);
	});
});
