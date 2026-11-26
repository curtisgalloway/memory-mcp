// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// The MCP surface. The handler is stateless: each request gets a fresh server.
// memory_read and memory_history use the Artifacts binding; the write tools and
// the index tools (context, search, list) go through the MemoryStore Durable
// Object.
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { authorLabel, checkNotePath, checkNoteText, cleanMessage, findSecret } from "./notes";
import {
	checkPath,
	noteHistory,
	readNote,
	type ReadFailure,
	type ReadOptions,
} from "./reads";
import type { StoreResult } from "./store";

const SERVER_VERSION = "0.1.0";
// Longer than any valid note path; keeps an oversized argument out of the tool.
const MAX_PATH = 512;
// Above the 64 KiB note limit, so an oversize note reaches our own check and
// gets a message naming the rule instead of a bare schema error.
const MAX_TEXT_ARG = 262144;
const MAX_MESSAGE_ARG = 1000;
const MAX_QUERY_ARG = 1000;
const VERSION = /^[0-9a-f]{40}$/;

const SERVER_INSTRUCTIONS =
	"This server is the user's shared memory store: Markdown notes in a git repository that " +
	"every one of the user's AI clients (claude.ai, Claude Code and others) reads and writes " +
	"through the memory_* tools. It is separate from any memory built into the client you are " +
	"running in. A note saved to built-in memory is not visible here, and a note here is not " +
	"in built-in memory. When the user asks about or asks you to remember something across " +
	"their clients, use these tools. Call memory_context first, once, at the start of a " +
	"conversation: it returns who the user is, how they like answers, and a list of what else " +
	"is stored. Use memory_search to find a note, and search before you write one, so you " +
	"update the existing note in place of adding a second one.";

type Outcome =
	| "ok"
	| "not_found"
	| "invalid_path"
	| "error"
	| "refused"
	| "conflict"
	| "duplicates"
	| "invalid_query"
	| "retryable";

/** What a tool body settles on; `payload`, when set, replaces the message as the error text. */
type ToolDone =
	| { ok: true; value: unknown }
	| { ok: false; reason: Outcome; message: string; payload?: unknown };

interface ToolResult {
	[key: string]: unknown;
	content: { type: "text"; text: string }[];
	isError?: boolean;
	_meta?: Record<string, unknown>;
}

/**
 * The key, in a tool result's `_meta`, under which the Worker reports how long
 * the call took: the same number as the log line's "ms". The timing run reads
 * it from the response, so it does not depend on the log stream delivering
 * every line.
 */
export const WORKER_MS_META = "memory-mcp/worker_ms";

function success(value: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(message: string, payload?: unknown): ToolResult {
	const text = payload === undefined ? message : JSON.stringify(payload);
	return { content: [{ type: "text", text }], isError: true };
}

/**
 * Runs one tool call: times it, turns a failed result or a thrown error into a
 * tool error, and writes the one log line. The line holds the path but never a
 * note body or a search query.
 */
async function runTool(
	tool: string,
	path: string,
	body: (opts: ReadOptions) => Promise<ToolDone | ReadFailure>,
): Promise<ToolResult> {
	const started = Date.now();
	const stats = { retried: false };
	let outcome: Outcome;
	let result: ToolResult;
	try {
		const done = await body({ stats });
		if (done.ok) {
			outcome = "ok";
			result = success(done.value);
		} else {
			outcome = done.reason;
			result = failure(done.message, "payload" in done ? done.payload : undefined);
		}
	} catch (error) {
		// Name and code only: an error's message can echo request content.
		const code = (error as { code?: unknown } | null)?.code;
		console.log(
			JSON.stringify({
				event: "tool_error",
				tool,
				name: error instanceof Error ? error.name : typeof error,
				code: typeof code === "string" ? code : undefined,
			}),
		);
		outcome = "error";
		result = failure("The note store could not be reached right now. Try again shortly.");
	}
	const ms = Date.now() - started;
	result._meta = { [WORKER_MS_META]: ms };
	console.log(
		JSON.stringify({
			event: "tool",
			tool,
			ms,
			outcome,
			retried: stats.retried,
			// Only a well-formed note path is logged: a client that sends note text
			// or a question as the path must not get that text into the logs.
			path: checkPath(path) === null ? path : undefined,
		}),
	);
	return result;
}

function refused(rule: string, message: string): ToolDone {
	return { ok: false, reason: "refused", message, payload: { error: "refused", rule, message } };
}

/** Checks a write or delete before the store sees it; returns a refusal, or null when acceptable. */
function validate(path: string, message: string | undefined, text?: string): ToolDone | null {
	const pathRule = checkNotePath(path);
	if (pathRule) return refused(pathRule, `${pathRule} Fix the path and send the call again.`);
	if (text !== undefined) {
		const textRule = checkNoteText(text);
		if (textRule) return refused(textRule, `${textRule} Change the text and send the call again.`);
		const secret = findSecret(text);
		if (secret) {
			return refused(
				`secret:${secret}`,
				`The note looks like it contains a secret (${secret}). Remove it and send the call again; do not repeat the secret.`,
			);
		}
	}
	// Scan the message as sent: cleaning cuts it to length, and a cut could leave
	// the front of a secret in git while no longer matching its pattern. Scan the
	// cleaned form too: turning control characters into spaces can create a match
	// the raw text did not have ("password\n: x" becomes "password : x").
	const messageSecret =
		message === undefined ? null : (findSecret(message) ?? findSecret(cleanMessage(message) ?? ""));
	if (messageSecret) {
		return refused(
			`secret:${messageSecret}`,
			`The commit message looks like it contains a secret (${messageSecret}). Remove it and send the call again; do not repeat the secret.`,
		);
	}
	return null;
}

/** The git author name from the grant's props, or null when the call has no usable identity. */
function authorName(): string | null {
	const name = getMcpAuthContext()?.props?.clientName;
	return typeof name === "string" ? authorLabel(name) : null;
}

function noIdentity(): ToolDone {
	const message =
		"This session carries no client identity, so nothing was written. Sign in to the server again and retry.";
	return { ok: false, reason: "error", message, payload: { error: "no_identity", message } };
}

type Stored = Extract<StoreResult, { ok: true }>;

/** Turns the store's reply into a tool result; `success` shapes the ok case. */
function fromStore(path: string, stored: StoreResult, success: (done: Stored) => unknown): ToolDone {
	if (stored.ok) return { ok: true, value: success(stored) };
	switch (stored.reason) {
		case "conflict": {
			const message =
				"The note changed since you read it, or already exists. Read it again with memory_read, merge your change into the current text, and retry with the new version.";
			return {
				ok: false,
				reason: "conflict",
				message,
				payload: { error: "conflict", current_version: stored.current_version, message },
			};
		}
		case "duplicates": {
			const message =
				"Nothing was written: existing notes have the same title or opening. Read the candidates with memory_read and update one of them. If this really is a separate note, send the call again with force set to true.";
			return {
				ok: false,
				reason: "duplicates",
				message,
				payload: { error: "duplicates", candidates: stored.candidates, message },
			};
		}
		case "blocked":
			return refused(
				"path-blocked",
				stored.at === path
					? `${stored.at} is a symbolic link in the repo, which these tools do not change. Choose another path.`
					: `A file already exists at ${stored.at}, where this path needs a folder. Choose another path.`,
			);
		case "not_found": {
			const message = "There is no note at that path, so there is nothing to delete.";
			return { ok: false, reason: "not_found", message, payload: { error: "not_found", message } };
		}
		default: {
			const message = "The store could not complete or confirm the change. Send the same call again; repeating it is safe.";
			return { ok: false, reason: "retryable", message, payload: { error: "retryable", message } };
		}
	}
}

function invalidQuery(message: string): ToolDone {
	return { ok: false, reason: "invalid_query", message, payload: { error: "invalid_query", message } };
}

export function createServer(): McpServer {
	const server = new McpServer(
		{ name: "memory-mcp", version: SERVER_VERSION },
		{ instructions: SERVER_INSTRUCTIONS },
	);

	server.registerTool(
		"memory_context",
		{
			description:
				"Call this first, once, at the start of a conversation. It returns the user's shared " +
				"memory in brief: every note under profile/ (who the user is) and preferences/ (how " +
				"they like answers) in full, and a catalog of all other notes with path, title and " +
				"summary. The answer has a size cap: a profile or preferences note too large to fit " +
				"is named under not_included, so read it with memory_read; and when there are too " +
				"many notes to list, the catalog is note counts by folder, so use memory_search or " +
				"memory_list from there. Takes no input.",
			inputSchema: {},
		},
		() =>
			runTool("memory_context", "", async () => {
				const value = await env.MEMORY_STORE.getByName("main").context();
				return { ok: true, value };
			}),
	);

	server.registerTool(
		"memory_search",
		{
			description:
				"Search the user's shared memory store by words. Matches note paths, titles, tags " +
				"and text, and returns the best matches first, each with its path, title and a " +
				"snippet of the matching text. Use it to find what is already stored, and always " +
				"before writing a new note. Read a result in full with memory_read. Plain words " +
				"work best; a note matching more of the words ranks higher.",
			inputSchema: {
				query: z.string().max(MAX_QUERY_ARG).describe("Words to look for"),
				folder: z
					.string()
					.max(MAX_PATH)
					.optional()
					.describe("Search only under this folder, such as people or projects/alpha"),
				limit: z.number().int().min(1).max(50).optional().describe("Default 10, at most 50"),
			},
		},
		({ query, folder, limit }) =>
			// The query is never logged: it is the user's own words.
			runTool("memory_search", "", async () => {
				const value = await env.MEMORY_STORE.getByName("main").search({ query, folder, limit });
				if (value === null) {
					return invalidQuery(
						"The query needs at least one word, and the folder must be a plain folder path such as people.",
					);
				}
				return { ok: true, value };
			}),
	);

	server.registerTool(
		"memory_list",
		{
			description:
				"List the notes in the user's shared memory store by path, each with its title and " +
				"when it last changed. Pass folder to list one folder and everything below it. At " +
				"most 500 notes are returned; truncated is true when there are more.",
			inputSchema: {
				folder: z
					.string()
					.max(MAX_PATH)
					.optional()
					.describe("List only under this folder, such as people or projects/alpha"),
			},
		},
		({ folder }) =>
			runTool("memory_list", "", async () => {
				const value = await env.MEMORY_STORE.getByName("main").list({ folder });
				if (value === null) {
					return invalidQuery("The folder must be a plain folder path such as people.");
				}
				return { ok: true, value };
			}),
	);

	server.registerTool(
		"memory_read",
		{
			description:
				"Read one note by its path, for example projects/alpha.md. Returns the note's text, " +
				"its version (an identifier that changes whenever the text does), and who last " +
				"committed. Pass ref only to read an older commit.",
			inputSchema: {
				path: z.string().max(MAX_PATH).describe("Note path ending in .md, such as projects/alpha.md"),
				ref: z.string().optional().describe("Branch or commit to read; defaults to main"),
			},
		},
		({ path, ref }) =>
			runTool("memory_read", path, async (opts) => {
				using repo = await env.ARTIFACTS.get(env.MEMORY_REPO);
				const note = await readNote(repo, { path, ref }, opts);
				if (!note.ok) return note;
				const { ok: _ok, ...value } = note;
				return { ok: true, value };
			}),
	);

	server.registerTool(
		"memory_history",
		{
			description:
				"List the commits that changed one note, newest first, each with its SHA, date, " +
				"author and message. Use it to see when and why a note changed. If truncated is " +
				"true, older changes may exist beyond what was searched.",
			inputSchema: {
				path: z.string().max(MAX_PATH).describe("Note path ending in .md, such as projects/alpha.md"),
				limit: z.number().int().min(1).max(50).optional().describe("Default 10, at most 50"),
			},
		},
		({ path, limit }) =>
			runTool("memory_history", path, async (opts) => {
				using repo = await env.ARTIFACTS.get(env.MEMORY_REPO);
				const history = await noteHistory(repo, { path, limit }, opts);
				if (!history.ok) return history;
				return {
					ok: true,
					value: { commits: history.commits, truncated: history.truncated },
				};
			}),
	);

	server.registerTool(
		"memory_write",
		{
			description:
				"Create or replace one note in the user's shared memory store, which all of the " +
				"user's AI clients share. This is not the client's built-in memory: use it when the " +
				"user wants something remembered across clients. Store only lasting facts the user " +
				"stated or confirmed, never guesses, small talk or secrets (text that looks like a " +
				"key, password or card number is refused). Search with memory_search before " +
				"writing, and update the note that already covers the subject in place of adding " +
				"another. To create a note, omit base_version; the call fails with a conflict if the " +
				"note already exists, and with a duplicates error listing the candidates if another " +
				"note has the same title or opening (pass force: true only when the new note really " +
				"is separate). To change a note, first call " +
				"memory_read, then send the complete new text (the note is replaced, not appended " +
				"to) with the version you read as base_version. On a conflict error, read the note " +
				"again, merge your change into the current text, and retry. Paths are lowercase " +
				"letters, digits and hyphens, in one to three folders, ending in .md, for example " +
				"people/alex-smith.md. A note is at most 64 KiB. Returns the new version and the commit.",
			inputSchema: {
				path: z.string().max(MAX_PATH).describe("Note path, such as people/alex-smith.md"),
				text: z.string().max(MAX_TEXT_ARG).describe("The complete new text of the note"),
				base_version: z
					.string()
					.regex(VERSION)
					.optional()
					.describe("The version from memory_read; omit to create a new note"),
				message: z
					.string()
					.max(MAX_MESSAGE_ARG)
					.optional()
					.describe("Short commit message; a default is used when omitted"),
				force: z
					.boolean()
					.optional()
					.describe("Create the note even if an existing note looks like a duplicate"),
			},
		},
		({ path, text, base_version, message, force }) =>
			runTool("memory_write", path, async () => {
				const bad = validate(path, message, text);
				if (bad) return bad;
				const author = authorName();
				if (!author) return noIdentity();
				const stub = env.MEMORY_STORE.getByName("main");
				const stored = await stub.write({
					path,
					text,
					baseVersion: base_version ?? null,
					author,
					message:
						cleanMessage(message) ?? `${base_version === undefined ? "Add" : "Update"} ${path}`,
					force: force === true,
				});
				return fromStore(path, stored, (r) =>
					r.commit === null
						? { version: r.version, commit: null, unchanged: true }
						: { version: r.version, commit: r.commit },
				);
			}),
	);

	server.registerTool(
		"memory_delete",
		{
			description:
				"Delete one note from the user's shared memory store. Call memory_read first and " +
				"pass the version you read as base_version; the call fails with a conflict if the " +
				"note changed since. Git history keeps the deleted text. Delete only when the user " +
				"asks for a note to be removed.",
			inputSchema: {
				path: z.string().max(MAX_PATH).describe("Note path, such as people/alex-smith.md"),
				base_version: z.string().regex(VERSION).describe("The version from memory_read"),
				message: z
					.string()
					.max(MAX_MESSAGE_ARG)
					.optional()
					.describe("Short commit message; a default is used when omitted"),
			},
		},
		({ path, base_version, message }) =>
			runTool("memory_delete", path, async () => {
				const bad = validate(path, message);
				if (bad) return bad;
				const author = authorName();
				if (!author) return noIdentity();
				const stub = env.MEMORY_STORE.getByName("main");
				const stored = await stub.remove({
					path,
					baseVersion: base_version,
					author,
					message: cleanMessage(message) ?? `Delete ${path}`,
				});
				return fromStore(path, stored, (r) => ({ commit: r.commit }));
			}),
	);

	return server;
}

const handler = createMcpHandler(createServer);

export function mcpHandler(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	return handler(request, env, ctx);
}
