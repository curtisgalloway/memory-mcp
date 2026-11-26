// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// The write path: one note change as clone, check, commit, push, over
// isomorphic-git and an in-memory filesystem. It knows nothing about Durable
// Objects or MCP; the caller supplies the remote and a short-lived token.
import git, { type HttpClient } from "isomorphic-git";
import webHttp from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";
import { checkNotePath, MAX_INDEXED_BLOB_BYTES, MAX_NOTE_BYTES } from "./notes";

export type { HttpClient };

/** `token` is the secret part only: the text before `?expires=`. */
export interface GitTarget {
	url: string;
	token: string;
}

export interface Change {
	path: string;
	/** The note's new text; null deletes it. */
	text: string | null;
	/** The blob SHA the caller last read; null means "the note must not exist". */
	baseVersion: string | null;
	author: string;
	message: string;
}

export type ApplyResult =
	| { kind: "pushed"; commit: string; version: string | null; base: string | null; at: number }
	| { kind: "unchanged"; version: string; base: string | null }
	| { kind: "conflict"; currentVersion: string | null }
	| { kind: "blocked"; at: string }
	| { kind: "not_found" }
	| { kind: "rejected" }
	| { kind: "push_uncertain"; commit: string; version: string | null; base: string | null; at: number };

export interface ApplyDeps {
	http?: HttpClient;
	now?: () => number;
}

const BRANCH = "main";
// The working tree is the root of a fresh in-memory filesystem, so "outside the
// working tree" and "above the filesystem root" are the same thing.
const DIR = "/";

function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

/** A clone of a remote that has no `main` can fail with these, depending on the server. */
function isMissingRef(error: unknown): boolean {
	const code = errorCode(error);
	return code === "NotFoundError" || code === "RemoteCapabilityError";
}

async function hasHead(fs: MemoryFS): Promise<boolean> {
	try {
		await git.resolveRef({ fs, dir: DIR, ref: "HEAD" });
		return true;
	} catch (error) {
		if (errorCode(error) === "NotFoundError") return false;
		throw error;
	}
}

async function noteOid(fs: MemoryFS, path: string): Promise<string | null> {
	let head: string;
	try {
		head = await git.resolveRef({ fs, dir: DIR, ref: "HEAD" });
	} catch (error) {
		if (errorCode(error) === "NotFoundError") return null;
		throw error;
	}
	try {
		return (await git.readBlob({ fs, dir: DIR, oid: head, filepath: path })).oid;
	} catch (error) {
		const code = errorCode(error);
		// A missing file, or a path that runs through a file where a folder is needed.
		if (code === "NotFoundError" || code === "ObjectTypeError") return null;
		throw error;
	}
}

/** Whether the entry at `path` in HEAD is a symbolic link. */
async function isLink(fs: MemoryFS, path: string): Promise<boolean> {
	const slash = path.lastIndexOf("/");
	const head = await git.resolveRef({ fs, dir: DIR, ref: "HEAD" });
	const { tree } = await git.readTree({
		fs,
		dir: DIR,
		oid: head,
		filepath: slash < 0 ? undefined : path.slice(0, slash),
	});
	return tree.some((entry) => entry.path === path.slice(slash + 1) && entry.mode === "120000");
}

/**
 * Applies one change to `main` of the repo at `target`. A failure before the push
 * starts (clone, token) is thrown; a failure of the push itself is reported as a
 * result, because the caller must tell "refused" from "may have landed".
 */
export async function applyChange(
	target: GitTarget,
	change: Change,
	deps: ApplyDeps = {},
): Promise<ApplyResult> {
	// Never touch the filesystem with a path that has not passed the rules,
	// even when a caller skipped validation.
	const rule = checkNotePath(change.path);
	if (rule !== null) throw new Error(`invalid note path: ${rule}`);

	const http = deps.http ?? webHttp;
	const now = deps.now ?? Date.now;
	const onAuth = () => ({ username: "x", password: target.token });
	let fs = new MemoryFS();

	let empty = false;
	try {
		await git.clone({
			fs,
			http,
			dir: DIR,
			url: target.url,
			ref: BRANCH,
			singleBranch: true,
			depth: 1,
			onAuth,
		});
	} catch (error) {
		if (!isMissingRef(error)) throw error;
		empty = true;
	}
	// The local simulator answers a clone of an empty repository with success and
	// an unborn HEAD, so an unresolvable HEAD means empty too.
	if (!empty && !(await hasHead(fs))) empty = true;
	if (empty) {
		// Nothing to clone yet; start a repository whose first commit is ours. A
		// fresh filesystem, because the failed clone left a half-built .git behind.
		fs = new MemoryFS();
		await git.init({ fs, dir: DIR, defaultBranch: BRANCH });
	}

	// The commit this change is built on: what the caller's index must already
	// cover for the index to stay complete after this change alone.
	const base = empty ? null : await git.resolveRef({ fs, dir: DIR, ref: "HEAD" });
	const current = empty ? null : await noteOid(fs, change.path);
	// A symbolic link at the path is the user's, pushed with git. It has a blob
	// like a file does, but it is not a note: the tools neither replace nor
	// delete it.
	if (current !== null && (await isLink(fs, change.path))) {
		return { kind: "blocked", at: change.path };
	}

	let version: string | null = null;
	let bytes: Uint8Array | null = null;
	if (change.text !== null) {
		bytes = new TextEncoder().encode(change.text);
		version = (await git.hashBlob({ object: bytes })).oid;
		// Before the base_version check, so a resend of a write that already landed
		// (its base_version is now stale, but the note holds exactly this text)
		// succeeds instead of conflicting with itself.
		if (version === current) return { kind: "unchanged", version, base };
	}

	if (change.text === null) {
		if (current === null) return { kind: "not_found" };
		if (change.baseVersion !== current) return { kind: "conflict", currentVersion: current };
	} else if (change.baseVersion === null) {
		if (current !== null) return { kind: "conflict", currentVersion: current };
	} else if (change.baseVersion !== current) {
		return { kind: "conflict", currentVersion: current };
	}

	if (bytes !== null) {
		// A file where a folder is needed would make the write fail midway.
		if (!empty) {
			const folders = change.path.split("/").slice(0, -1);
			for (let i = 1; i <= folders.length; i++) {
				const ancestor = folders.slice(0, i).join("/");
				if ((await noteOid(fs, ancestor)) !== null) return { kind: "blocked", at: ancestor };
			}
		}
		const file = `${DIR}${change.path}`;
		await fs.promises.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
		await fs.promises.writeFile(file, bytes);
		await git.add({ fs, dir: DIR, filepath: change.path });
	} else {
		await fs.promises.unlink(`${DIR}${change.path}`);
		await git.remove({ fs, dir: DIR, filepath: change.path });
	}

	const timestamp = Math.floor(now() / 1000);
	const commit = await git.commit({
		fs,
		dir: DIR,
		message: change.message,
		author: { name: change.author, email: "client@memory-mcp.invalid", timestamp },
		committer: { name: "memory-mcp", email: "server@memory-mcp.invalid", timestamp },
	});

	try {
		await git.push({ fs, http, dir: DIR, url: target.url, ref: BRANCH, onAuth });
	} catch (error) {
		const code = errorCode(error);
		if (code === "PushRejectedError" || code === "GitPushError") return { kind: "rejected" };
		return { kind: "push_uncertain", commit, version, base, at: timestamp };
	}
	return { kind: "pushed", commit, version, base, at: timestamp };
}

export interface BulkBlobs {
	/** Content by blob id, cut to the first MAX_NOTE_BYTES bytes. */
	blobs: Map<string, Uint8Array>;
	/** Blobs over MAX_INDEXED_BLOB_BYTES, which are not kept at all. */
	oversize: Set<string>;
}

/**
 * Reads many blobs with one shallow clone, for a large reindex: a few git
 * requests in place of one binding call per note. Nothing is checked out. A
 * blob the clone does not hold (main moved on since the caller listed it) is
 * simply absent from the result. Each blob is cut to a note's size as it is
 * read, so the result holds at most 64 KiB per note however large the files
 * are; the cloned pack itself is still held until this returns.
 */
export async function readBlobs(
	target: GitTarget,
	oids: string[],
	deps: ApplyDeps = {},
): Promise<BulkBlobs> {
	const fs = new MemoryFS();
	await git.clone({
		fs,
		http: deps.http ?? webHttp,
		dir: DIR,
		url: target.url,
		ref: BRANCH,
		singleBranch: true,
		depth: 1,
		noCheckout: true,
		onAuth: () => ({ username: "x", password: target.token }),
	});
	const blobs = new Map<string, Uint8Array>();
	const oversize = new Set<string>();
	for (const oid of oids) {
		try {
			const { blob } = await git.readBlob({ fs, dir: DIR, oid });
			if (blob.byteLength > MAX_INDEXED_BLOB_BYTES) oversize.add(oid);
			// slice copies, so the map does not keep the whole blob alive.
			else blobs.set(oid, blob.byteLength > MAX_NOTE_BYTES ? blob.slice(0, MAX_NOTE_BYTES) : blob);
		} catch (error) {
			if (errorCode(error) !== "NotFoundError") throw error;
		}
	}
	return { blobs, oversize };
}
