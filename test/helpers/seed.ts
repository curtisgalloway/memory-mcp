// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Seeds an Artifacts repo through the real write path (isomorphic-git over
// smart HTTP), the way the writer does.
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "../../src/memory-fs";

const DIR = "/workspace";
const AUTHOR = { name: "seed-client", email: "seed@invalid" };

export interface SeedCommit {
	message: string;
	files: Record<string, string>;
	/** Symbolic links to add, as path to link target. */
	links?: Record<string, string>;
	/** Commit author name; defaults to "seed-client". */
	author?: string;
}

/** The author time of the first seeded commit, in Unix seconds; each later commit is one second on. */
export const SEED_EPOCH = 1_700_000_000;

/** Creates `name` and pushes one commit per entry; returns each commit's blob SHAs by path. */
export async function seedRepo(
	artifacts: Artifacts,
	name: string,
	commits: SeedCommit[],
): Promise<{ commits: string[]; blobs: Record<string, string>[] }> {
	const created = await artifacts.create(name);
	// Tokens look like art_v1_<secret>?expires=<unix>; git wants only the secret.
	const password = created.token.split("?expires=")[0];
	const fs = new MemoryFS();
	await git.init({ fs, dir: DIR, defaultBranch: "main" });
	const shas: string[] = [];
	const blobs: Record<string, string>[] = [];
	let tick = SEED_EPOCH;
	for (const commit of commits) {
		const written: Record<string, string> = {};
		for (const [path, text] of Object.entries(commit.files)) {
			const slash = path.lastIndexOf("/");
			if (slash > 0) await fs.promises.mkdir(`${DIR}/${path.slice(0, slash)}`, { recursive: true });
			await fs.promises.writeFile(`${DIR}/${path}`, text);
			await git.add({ fs, dir: DIR, filepath: path });
			written[path] = await git.hashBlob({ object: new TextEncoder().encode(text) }).then((h) => h.oid);
		}
		for (const [path, linkTarget] of Object.entries(commit.links ?? {})) {
			await fs.promises.symlink(linkTarget, `${DIR}/${path}`);
			await git.add({ fs, dir: DIR, filepath: path });
		}
		shas.push(
			await git.commit({
				fs,
				dir: DIR,
				message: commit.message,
				author: { ...AUTHOR, name: commit.author ?? AUTHOR.name, timestamp: tick++ },
			}),
		);
		blobs.push(written);
	}
	await git.push({
		fs,
		http,
		dir: DIR,
		url: created.remote,
		ref: "main",
		onAuth: () => ({ username: "x", password }),
	});
	return { commits: shas, blobs };
}
