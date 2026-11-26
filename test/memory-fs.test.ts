// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { MemoryFS } from "../src/memory-fs";

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return (error as { code?: string }).code;
	}
	return "no error";
}

describe("MemoryFS path safety", () => {
	it("refuses to climb above the root on every method", async () => {
		const fs = new MemoryFS();
		const p = fs.promises;
		expect(await codeOf(p.writeFile("/../x", "a"))).toBe("EACCES");
		expect(await codeOf(p.readFile("../../etc/passwd"))).toBe("EACCES");
		expect(await codeOf(p.mkdir("/a/../../b"))).toBe("EACCES");
		expect(await codeOf(p.unlink("/../x"))).toBe("EACCES");
		expect(await codeOf(p.stat("/.."))).toBe("EACCES");
	});

	it("resolves a .. that stays inside the root", () => {
		const fs = new MemoryFS();
		expect(fs.normalize("/a/../b")).toBe("/b");
		expect(fs.normalize("")).toBe("/");
		expect(fs.normalize("/a/./b//c")).toBe("/a/b/c");
	});
});

describe("MemoryFS operations", () => {
	it("round-trips write, read, readdir, unlink and rmdir", async () => {
		const fs = new MemoryFS();
		const p = fs.promises;
		await p.writeFile("/d/f.txt", "hello");
		expect(await p.readFile("/d/f.txt", "utf8")).toBe("hello");
		expect(await p.readdir("/d")).toEqual(["f.txt"]);
		expect(await codeOf(p.rmdir("/d"))).toBe("ENOTEMPTY");
		await p.unlink("/d/f.txt");
		expect(await p.readdir("/d")).toEqual([]);
		await p.rmdir("/d");
		expect(await p.readdir("/")).toEqual([]);
	});

	it("gives ENOENT errors a code", async () => {
		const fs = new MemoryFS();
		expect(await codeOf(fs.promises.readFile("/missing"))).toBe("ENOENT");
		expect(await codeOf(fs.promises.stat("/missing"))).toBe("ENOENT");
	});
});

describe("MemoryFS with isomorphic-git", () => {
	it("runs init, add and commit with dir /", async () => {
		const fs = new MemoryFS();
		await git.init({ fs, dir: "/", defaultBranch: "main" });
		await fs.promises.writeFile("/projects/a.md", "# A\n");
		await git.add({ fs, dir: "/", filepath: "projects/a.md" });
		const oid = await git.commit({
			fs,
			dir: "/",
			message: "first",
			author: { name: "t", email: "t@invalid", timestamp: 1_700_000_000 },
		});
		expect(oid).toMatch(/^[0-9a-f]{40}$/);
		const log = await git.log({ fs, dir: "/" });
		expect(log.map((c) => c.commit.message.trim())).toEqual(["first"]);
	});
});
