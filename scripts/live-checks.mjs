#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Runs, against a deployed server, the acceptance checks that the test suite
// shows only in the local simulator: the duplicate refusal
// (R11), the secret refusal (R12), the path refusal (R7), the version
// conflict (R4), delete, list, the author in history (R3) and the admin
// reindex route (R6). It writes two notes under checks/<run id>/ and deletes
// them again, so it is meant for a test deployment: an environment named "staging", or any
// other with --writes.
//
// Three checks send a write that the server must refuse. If one of those ever
// succeeds, a note exists that should not: the script remembers every note any
// call created, deletes them all at the end, and says so loudly, because git
// history (and the archive) keeps a deleted note.
//
// Usage: node scripts/live-checks.mjs (--env NAME | --url ADDRESS) [--writes]
//   --env reads the address from deploy/NAME.json.
import { adminReindex, callTool, flag, signIn, target } from "./lib/client.mjs";

const { base, env } = target();
if (env !== "staging" && !flag("writes")) {
	console.error('These checks write and delete notes. Against anything but the environment "staging", pass --writes.');
	process.exit(2);
}

const CLIENT_NAME = "memory-mcp live checks";
const token = await signIn(base, CLIENT_NAME);
const runId = `c${Date.now().toString(36)}`;
const first = `checks/${runId}/first.md`;
const second = `checks/${runId}/second.md`;
const text = `# Live check ${runId}\n\nThrowaway note of live check ${runId}, made and deleted by scripts/live-checks.mjs.\n`;
// Shaped like an API key so the server's pattern matches, and plainly not one.
// Put together at run time so no key-shaped text sits in this file.
const sampleKey = ["sk", "ant", "FAKE", "not", "a", "real", "key", "0".repeat(20)].join("-");

let seq = 0;
let failed = false;
async function tool(name, args) {
	const call = await callTool(base, token, ++seq, name, args);
	return call.parsed ?? { isError: true, text: `HTTP ${call.status}`, json: undefined };
}
/** Every note a call of this run created and has not deleted: path to version. */
const created = new Map();
async function write(args) {
	const result = await tool("memory_write", args);
	if (!result.isError && typeof result.json?.version === "string") {
		created.set(args.path, result.json.version);
	}
	return result;
}
/** A write the server must refuse. Says loudly when it was not. */
async function mustRefuse(args) {
	const result = await write(args);
	if (created.has(args.path)) {
		console.log(
			`\n!!! A write that must be refused was ACCEPTED: ${args.path} now exists in the notes repo.\n!!! It is deleted below, but git history and the archive keep it.\n`,
		);
	}
	return result;
}
function check(name, ok, detail) {
	if (!ok) failed = true;
	console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const made = await write({ path: first, text });
const version = made.json?.version;
check("create a note", !made.isError && typeof version === "string", made.isError ? made.text : "");

const again = await write({ path: first, text: `${text}More.\n` });
check("R4: creating over an existing note is a conflict", again.json?.error === "conflict");

const stale = await write({ path: first, text: `${text}More.\n`, base_version: "0".repeat(40) });
check(
	"R4: a write naming an outdated version is a conflict that gives the current one",
	stale.json?.error === "conflict" && stale.json?.current_version === version,
);

const duplicate = await mustRefuse({ path: second, text });
check(
	"R11: a new note with the same title answers duplicates, naming the first",
	duplicate.json?.error === "duplicates" && duplicate.json?.candidates?.some((c) => c.path === first),
);

// If the duplicate was wrongly accepted above, this is an update of that note.
const forced = await write({ path: second, text, force: true, base_version: created.get(second) });
check("R11: force writes it anyway", !forced.isError && typeof forced.json?.version === "string");

const secret = await mustRefuse({ path: `checks/${runId}/secret.md`, text: `# Key\n\n${sampleKey}\n` });
check(
	"R12: a note holding a sample API key is refused by pattern name, without the key",
	secret.json?.error === "refused" &&
		String(secret.json?.rule).startsWith("secret:") &&
		!secret.text.includes(sampleKey),
	secret.json?.rule,
);

const badPath = await mustRefuse({ path: `Checks/${runId}/Upper.md`, text: `${text}Path check.\n`, force: true });
check("R7: an invalid path is refused with the rule", badPath.json?.error === "refused" && Boolean(badPath.json?.message));

const found = await tool("memory_search", { query: runId });
check("R5: both notes are found by search at once", found.json?.results?.length === 2);

const listed = await tool("memory_list", { folder: `checks/${runId}` });
check("memory_list of the folder shows both", listed.json?.notes?.length === 2);

const history = await tool("memory_history", { path: first });
check(
	"R3: history shows one commit, authored by this client",
	history.json?.commits?.length === 1 && String(history.json.commits[0].author).includes("live checks"),
	history.json?.commits?.[0]?.author,
);

const reindexed = await adminReindex(base, token, false);
let state;
try {
	state = JSON.parse(reindexed.text).state;
} catch {
	state = undefined;
}
// "current" is the expected answer; "ok" means a reindex was still owed and ran.
check(
	"R6: the admin reindex route answers, and the index is in line with the repo",
	reindexed.status === 200 && (state === "current" || state === "ok"),
	`${reindexed.status} ${state}`,
);

const unsigned = await fetch(`${base}/mcp/admin/reindex`, { method: "POST" });
check("R2: the admin route without a grant is 401", unsigned.status === 401, String(unsigned.status));

const staleDelete = await tool("memory_delete", { path: first, base_version: "0".repeat(40) });
check("R4: a delete naming an outdated version is a conflict", staleDelete.json?.error === "conflict");

// Delete everything this run created: the two notes it meant to, and any note
// a failed refusal check left.
const expected = created.size;
for (const [path, base_version] of [...created]) {
	const removed = await tool("memory_delete", { path, base_version });
	if (!removed.isError) created.delete(path);
}
check("delete every note this run created", expected === 2 && created.size === 0, `${expected} created, ${created.size} left`);
if (created.size) {
	console.log(`\n!!! Notes left behind, delete them by hand: ${[...created.keys()].join(", ")}\n`);
}

const gone = await tool("memory_search", { query: runId });
check("the deleted notes leave search at once", gone.json?.results?.length === 0);

const read = await tool("memory_read", { path: first });
check("memory_read of a deleted note is a not-found tool error", read.isError === true);

console.log(failed ? "\nSome checks FAILED." : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
