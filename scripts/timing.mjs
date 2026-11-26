#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Timing run for requirement R8, over all seven tools. Signs in once in the
// browser, calls each tool N times, and reports each tool's median as the
// Worker measured it. The Worker's time comes back in every tool result
// (`_meta`, key "memory-mcp/worker_ms": the same number as its log line's
// "ms"), so all N calls are covered; the log stream (`wrangler tail`), which
// delivered 15 lines of 50 in one early run, is kept only as a
// cross-check. Every raw response is written to disk before anything parses it.
//
// The write and delete calls make real commits: N notes are created under
// timing/<run id>/ and then deleted, 2N commits in all. They run by default
// against an environment named "staging" only; anything else needs --writes.
//
// Usage: node scripts/timing.mjs (--env NAME | --url ADDRESS) [--calls 50]
//          [--tools all|name,name] [--writes] [--no-tail] [--full-reindex]
//          [--path NOTE] [--query WORD] [--out DIR]
//   --env reads the address and Worker name from deploy/NAME.json.
//
// The Worker log is followed only with --env (by Worker name). With fewer than
// 20 calls the run only tries the script out: R8's limits are reported and not
// applied, because the median of a few calls is mostly the first, cold one.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adminReindex, callTool, flag, median, option, signIn, target } from "./lib/client.mjs";

/** R8's limits on the Worker-measured median, in milliseconds. The other tools have none. */
const LIMITS = { memory_read: 300, memory_write: 2000, memory_search: 200, memory_context: 200 };
const READ_TOOLS = ["memory_context", "memory_search", "memory_list", "memory_read", "memory_history"];
// Writes come first so the read tools have this run's notes to work on; deletes
// come last and clean them up.
const ORDER = ["memory_write", ...READ_TOOLS, "memory_delete"];

const { base, env, values } = target();
const calls = Number(option("calls", "50"));
const writes = env === "staging" || flag("writes");
// The log can be followed only for a deployed Worker named by --env. For a bare
// address (a local server, a preview) there is no log of that server to follow.
const tailOff = flag("no-tail")
	? "off: --no-tail"
	: env === null
		? "off: --url names no deployed Worker, so there is no Worker log to follow"
		: null;
const outDir = option("out", join("timing-runs", new Date().toISOString().replace(/[:.]/g, "-")));
const requested = option("tools", "all");
const tools = ORDER.filter(
	(tool) =>
		(requested === "all" || requested.split(",").includes(tool)) &&
		(writes || READ_TOOLS.includes(tool)),
);
if (!Number.isInteger(calls) || calls < 1 || !tools.length) {
	console.error("Nothing to run: check --calls and --tools.");
	process.exit(2);
}
if (tools.includes("memory_delete") && !tools.includes("memory_write")) {
	console.error("memory_delete deletes the notes memory_write made in the same run; include both.");
	process.exit(2);
}

// Responses hold note text: keep the run directory private to this account.
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const privateFile = { mode: 0o600 };

/** Follows the Worker's log; the raw output is saved as it arrives. */
function tailWorkerLogs() {
	if (tailOff) return { stop: () => null };
	const child = spawn("npx", ["wrangler", "tail", values.workerName, "--format", "json"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	const tailFile = join(outDir, "worker-tail.json");
	writeFileSync(tailFile, "", privateFile);
	let buffer = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		// Each chunk is added to the file as it arrives, not the whole log again.
		appendFileSync(tailFile, chunk);
	});
	return {
		stop() {
			child.kill();
			const lines = [];
			// Inside wrangler's JSON the Worker's log line is an escaped string.
			for (const match of buffer.matchAll(/\{\\"event\\":\\"tool\\".*?\}/g)) {
				try {
					lines.push(JSON.parse(match[0].replaceAll('\\"', '"')));
				} catch {
					// The raw output is on disk; skip what does not parse.
				}
			}
			return lines;
		},
	};
}

const token = await signIn(base, "memory-mcp timing script");
const tail = tailWorkerLogs();
if (!tailOff) await new Promise((resolve) => setTimeout(resolve, 6000));

// Letters first and base 36, so the id is one search word and never looks like
// a card number to the server's secret check.
const runId = `r${Date.now().toString(36)}`;
const notePath = (n) => `timing/${runId}/n-${String(n).padStart(3, "0")}.md`;
const noteText = (n) =>
	`# Timing ${runId} note ${n}\n\nThrowaway note ${n} of timing run ${runId}, made by scripts/timing.mjs and deleted by the same run.\n`;

let seq = 0;
const versions = new Map();
const results = {};

async function run(tool, argsFor, after) {
	const rows = [];
	for (let n = 1; n <= calls; n++) {
		const args = argsFor(n);
		if (args === null) continue;
		const file = join(outDir, `${tool}-${String(n).padStart(3, "0")}.txt`);
		const call = await callTool(base, token, ++seq, tool, args, (status, raw) =>
			// Save first, parse second.
			writeFileSync(file, `HTTP ${status}\n${raw}`, privateFile),
		);
		const ok = call.parsed !== null && !call.parsed.isError;
		rows.push({ ok, clientMs: call.clientMs, workerMs: call.parsed?.workerMs ?? null });
		if (ok) after?.(n, call.parsed.json);
	}
	results[tool] = rows;
}

// Without this run's own notes (no writes), read an existing note: --path, or
// the first one memory_list names.
let existingPath = option("path", null);
if (!tools.includes("memory_write") && !existingPath) {
	const listed = await callTool(base, token, ++seq, "memory_list", {});
	existingPath = listed.parsed?.json?.notes?.[0]?.path ?? null;
}
const readPath = () => (tools.includes("memory_write") ? notePath(1) : existingPath);
const query = tools.includes("memory_write") ? runId : option("query", "memory");

const argsByTool = {
	memory_write: (n) => ({ path: notePath(n), text: noteText(n), message: `Timing run ${runId}: add note ${n}` }),
	memory_context: () => ({}),
	memory_search: () => ({ query }),
	memory_list: () => ({}),
	memory_read: () => (readPath() ? { path: readPath() } : null),
	memory_history: () => (readPath() ? { path: readPath() } : null),
	memory_delete: (n) =>
		versions.has(n)
			? { path: notePath(n), base_version: versions.get(n), message: `Timing run ${runId}: delete note ${n}` }
			: null,
};
const afterByTool = {
	memory_write: (n, json) => json?.version && versions.set(n, json.version),
	memory_delete: (n) => versions.delete(n),
};

for (const tool of tools) {
	console.log(`${tool}: ${calls} calls`);
	await run(tool, argsByTool[tool], afterByTool[tool]);
}

// Time one full rebuild of the index while the repo's history is
// at its longest (after this run's commits).
let reindex = null;
if (flag("full-reindex")) {
	reindex = await adminReindex(base, token, true);
	writeFileSync(join(outDir, "full-reindex.txt"), `HTTP ${reindex.status}\n${reindex.text}`, privateFile);
}

if (!tailOff) await new Promise((resolve) => setTimeout(resolve, 6000));
const tailLines = tail.stop();

const round = (value) => (value === null ? null : Math.round(value));
// A short run tries the script out; its medians are not R8's.
const limitsApplied = calls >= 20;
const summary = {
	base,
	run_id: runId,
	calls,
	limits_applied: limitsApplied,
	log_tail: tailOff ?? `on: ${env}`,
	tools: {},
};
let failed = false;
for (const tool of tools) {
	const rows = results[tool];
	const workerMs = rows.filter((row) => row.ok && row.workerMs !== null).map((row) => row.workerMs);
	const sorted = [...workerMs].sort((a, b) => a - b);
	const failures = rows.filter((row) => !row.ok).length;
	const limit = LIMITS[tool] ?? null;
	const workerMedian = median(workerMs);
	// A tool passes only when every call was made, succeeded and reported its
	// time; a median over part of the calls is not R8's check.
	const complete = rows.length === calls && failures === 0 && workerMs.length === calls;
	const pass = complete && (!limitsApplied || limit === null || workerMedian < limit);
	if (!pass) failed = true;
	const fromTail = tailLines === null ? null : tailLines.filter((line) => line.tool === tool);
	summary.tools[tool] = {
		calls_made: rows.length,
		failures,
		worker_ms_reported: workerMs.length,
		worker_median_ms: workerMedian,
		worker_p90_ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.9) - 1] : null,
		worker_max_ms: sorted.length ? sorted[sorted.length - 1] : null,
		limit_median_ms: limit,
		pass,
		client_median_ms: round(median(rows.map((row) => row.clientMs))),
		client_max_ms: round(rows.length ? Math.max(...rows.map((row) => row.clientMs)) : null),
		tail_lines_seen: fromTail === null ? null : fromTail.length,
		tail_median_ms: fromTail === null ? null : median(fromTail.map((line) => line.ms)),
	};
}
// Notes written and not deleted again; delete them by hand if this is not empty.
summary.notes_left_behind = [...versions.keys()].map(notePath);
if (summary.notes_left_behind.length) failed = true;
if (reindex) {
	summary.full_reindex = { status: reindex.status, client_ms: reindex.ms, answer: reindex.text.slice(0, 500) };
	if (reindex.status !== 200) failed = true;
}
summary.pass = !failed;

writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, "\t")}\n`, privateFile);
console.log(JSON.stringify(summary, null, "\t"));
console.log(`Raw responses and the Worker log are in ${outDir}`);
process.exit(failed ? 1 : 0);
