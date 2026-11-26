// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Pure rules for notes: which paths and texts are acceptable, secret
// detection, and light parsing of a note's frontmatter. No I/O. The checks never
// return or log note text, and findSecret returns only a pattern name (parseNote
// does return the body).

export const MAX_NOTE_BYTES = 64 * 1024;
export const MAX_PATH_LENGTH = 200;
export const MAX_MESSAGE_LENGTH = 200;

const MAX_AUTHOR_LENGTH = 64;
const MAX_SUMMARY_LENGTH = 120;
const MAX_FOLDERS = 3;
const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** Returns the rule a note path breaks (a short sentence naming the rule), or null. */
export function checkNotePath(path: string): string | null {
	if (path.length === 0) return "Path must not be empty.";
	if (path.length > MAX_PATH_LENGTH) {
		return `Path must be at most ${MAX_PATH_LENGTH} characters.`;
	}
	if (path.split("/").some((s) => s === "." || s === "..")) {
		return "Path must not contain . or .. segments (no path traversal).";
	}
	if (path.startsWith("/")) return "Path must be relative: no leading slash.";
	if (/[A-Z]/.test(path)) return "Path must be lowercase: no uppercase letters.";
	if (!path.endsWith(".md")) return "Path must end in .md.";
	const segments = path.slice(0, -".md".length).split("/");
	if (segments.some((s) => s === "")) {
		return "Path must not have empty segments (no // and no empty file name).";
	}
	if (segments.some((s) => !SEGMENT.test(s))) {
		return "Path segments may use only a-z, 0-9 and hyphen, and must start with a letter or digit; the only dot allowed is the final .md.";
	}
	const folders = segments.length - 1;
	if (folders < 1) return "Path must be inside a folder (for example projects/name.md).";
	if (folders > MAX_FOLDERS) {
		return `Path must be at most ${MAX_FOLDERS} folders deep.`;
	}
	return null;
}

/** Returns the rule the text breaks, or null. */
export function checkNoteText(text: string): string | null {
	if (text.trim().length === 0) return "Note text must not be empty.";
	const bytes = new TextEncoder().encode(text).byteLength;
	if (bytes > MAX_NOTE_BYTES) {
		return `Note text must be at most 64 KiB (${MAX_NOTE_BYTES} bytes); this note is ${bytes} bytes.`;
	}
	if (!text.isWellFormed()) {
		return "Note text must be well-formed Unicode (it contains an unpaired surrogate).";
	}
	return null;
}

// Each pattern is linear: bounded or single-class quantifiers, no nested ones.
const SECRET_PATTERNS: readonly [string, RegExp][] = [
	["anthropic-api-key", /sk-ant-[A-Za-z0-9_-]{20,}/],
	["openai-api-key", /sk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
	["github-token", /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/],
	["aws-access-key-id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
	["slack-token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
	["google-api-key", /AIza[0-9A-Za-z_-]{35}/],
	["stripe-live-key", /[sr]k_live_[0-9a-zA-Z]{24,}/],
	["artifacts-repo-token", /art_v1_[A-Za-z0-9_-]{20,}/],
	["onepassword-service-account-token", /ops_[A-Za-z0-9_-]{40,}/],
	["private-key-block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const CARD_RUN = /(?<![0-9])[0-9](?:[ -]?[0-9]){12,18}(?![0-9])/g;
const PASSWORD_LINE =
	/(?<![A-Za-z0-9])["']?(?:password|passwd|pwd)["']?[ \t]*[:=][ \t]*(\S[^\r\n]*)/gi;

// One whole 1Password reference: op://vault/item[/section]/field. Vault and item
// names may hold spaces ("Team Vault"); the section and field may not, so
// prose after a reference ("op://v/i/f old one was ...") is not part of it.
const OP_REFERENCE_VALUE =
	/^["']?op:\/\/[^\/"'\r\n]+\/[^\/"'\r\n]+\/(?:[^\/"'\s]+\/)?[^\/"'\s,;})\]]+["']?[\s,;})\]]*$/;

function luhnValid(digits: string): boolean {
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		let d = digits.charCodeAt(digits.length - 1 - i) - 48;
		if (i % 2 === 1) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
	}
	return sum % 10 === 0;
}

/** Returns the NAME of the first secret pattern the text matches, or null. Never returns matched text. */
export function findSecret(text: string): string | null {
	for (const [name, pattern] of SECRET_PATTERNS) {
		if (pattern.test(text)) return name;
	}
	for (const match of text.matchAll(CARD_RUN)) {
		const digits = match[0].replace(/[ -]/g, "");
		if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
			return "card-number";
		}
	}
	for (const match of text.matchAll(PASSWORD_LINE)) {
		// A 1Password reference points at a secret; it is not one. Only a value that
		// is one whole reference is exempt, not one that merely starts with it.
		if (!OP_REFERENCE_VALUE.test(match[1])) return "password-line";
	}
	return null;
}

function truncate(text: string, max: number): string {
	const points = Array.from(text);
	return points.length <= max ? text : points.slice(0, max).join("");
}

/** Cleans a client-supplied commit message: one line, trimmed, cut to MAX_MESSAGE_LENGTH; empty is null. */
export function cleanMessage(message: string | undefined): string | null {
	if (message === undefined) return null;
	const oneLine = message
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const cut = truncate(oneLine, MAX_MESSAGE_LENGTH).trim();
	return cut === "" ? null : cut;
}

/** Cleans the client name used as git author: no control characters, angle brackets or runs of whitespace; cut to 64; empty is null. */
export function cleanAuthorName(name: string | undefined): string | null {
	if (name === undefined) return null;
	const cleaned = name
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
		.replace(/[<>]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const cut = truncate(cleaned, MAX_AUTHOR_LENGTH).trim();
	return cut === "" ? null : cut;
}

// Clients name themselves at registration, and the names are not stable labels:
// claude.ai registers as "Claude". Known clients get a fixed label so git log
// says which client wrote a commit; any other client keeps its own name.
const AUTHOR_LABELS: Readonly<Record<string, string>> = {
	claude: "claude.ai",
	"claude code": "claude-code",
	chatgpt: "chatgpt",
};

/** The git author for a client's self-reported name: a fixed label for a known client, else the cleaned name; empty is null. */
export function authorLabel(name: string | undefined): string | null {
	const cleaned = cleanAuthorName(name);
	if (cleaned === null) return null;
	return AUTHOR_LABELS[cleaned.toLowerCase()] ?? cleaned;
}

export interface ParsedNote {
	title: string;
	summary: string;
	tags: string[];
	body: string;
}

function unquote(value: string): string {
	const v = value.trim();
	if (v.length >= 2) {
		const q = v[0];
		if ((q === '"' || q === "'") && v[v.length - 1] === q) {
			const inner = v.slice(1, -1);
			return q === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\(["\\])/g, "$1");
		}
	}
	return v;
}

interface Frontmatter {
	fields: Map<string, string>;
	tags: string[];
}

/** Parses the supported YAML subset; null means "treat as no frontmatter". */
function parseFrontmatter(lines: string[]): Frontmatter | null {
	const fields = new Map<string, string>();
	const tags: string[] = [];
	let key: string | null = null;
	for (const line of lines) {
		if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
		const item = /^\s*-\s+(.*)$/.exec(line);
		if (item && key !== null) {
			if (key === "tags") {
				const tag = unquote(item[1]);
				if (tag) tags.push(tag);
			}
			continue;
		}
		if (/^\s/.test(line)) continue;
		const pair = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
		if (!pair) return null;
		key = pair[1];
		const value = (pair[2] ?? "").trim();
		if (key === "tags") {
			if (value.startsWith("[")) {
				if (!value.endsWith("]")) return null;
				for (const part of value.slice(1, -1).split(",")) {
					const tag = unquote(part);
					if (tag) tags.push(tag);
				}
			}
		} else {
			fields.set(key, unquote(value));
		}
	}
	return { fields, tags };
}

function firstSentence(body: string): string {
	const paragraph: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		const t = line.trim();
		if (t === "" || t.startsWith("#")) {
			if (paragraph.length > 0) break;
			continue;
		}
		paragraph.push(t);
	}
	const flat = paragraph.join(" ");
	const end = /[.!?](?=\s|$)/.exec(flat);
	return truncate(end ? flat.slice(0, end.index + 1) : flat, MAX_SUMMARY_LENGTH);
}

export function parseNote(path: string, text: string): ParsedNote {
	const lines = text.split(/\r?\n/);
	let fm: Frontmatter | null = null;
	let body = text;
	if (lines[0]?.trim() === "---") {
		const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
		if (close > 0) {
			fm = parseFrontmatter(lines.slice(1, close));
			if (fm) body = lines.slice(close + 1).join("\n");
		}
	}
	const heading = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
	const stem = (path.split("/").pop() ?? path).replace(/\.md$/, "");
	const title = fm?.fields.get("title") || heading?.[1] || stem;
	const summary = fm?.fields.get("summary") || firstSentence(body);
	return { title, summary, tags: fm?.tags ?? [], body };
}

function matchKey(text: string): string {
	return text
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

// An opening shorter than this ("To do.", "Notes:") says too little to call two
// notes the same.
const MIN_OPENING_KEY = 20;

export interface DuplicateKeys {
	/** The title reduced to lowercase words; null when the note has no title of its own. */
	title: string | null;
	/** The first sentence of the body, reduced the same way; null when too short to compare. */
	opening: string | null;
}

/**
 * The two keys a new note is compared on for the duplicate check (R11). Two notes
 * match when either key is equal. A title that is only the file name is not a key.
 */
export function duplicateKeys(path: string, text: string): DuplicateKeys {
	const parsed = parseNote(path, text);
	const stem = (path.split("/").pop() ?? path).replace(/\.md$/, "");
	const title = parsed.title === stem ? "" : matchKey(parsed.title);
	const opening = matchKey(firstSentence(parsed.body));
	return {
		title: title === "" ? null : title,
		opening: opening.length < MIN_OPENING_KEY ? null : opening,
	};
}

/**
 * A file pushed with git can be any size, and one this large is not a note (the
 * write tools refuse anything over 64 KiB): the index leaves it out. Between
 * the note limit and this, the index holds the first 64 KiB.
 */
export const MAX_INDEXED_BLOB_BYTES = 16 * MAX_NOTE_BYTES;

/**
 * The text the index keeps for a file read from the repo: its first
 * MAX_NOTE_BYTES bytes, decoded. The cut is by bytes on every read path, so one
 * blob always indexes the same way; a character split by the cut, or bytes that
 * are not UTF-8, decode to U+FFFD, so the result is always well-formed.
 */
export function indexText(bytes: Uint8Array): string {
	const cut = bytes.byteLength > MAX_NOTE_BYTES ? bytes.subarray(0, MAX_NOTE_BYTES) : bytes;
	return new TextDecoder().decode(cut);
}

const MAX_QUERY_TERMS = 16;

/**
 * Turns free text into an FTS5 query: each word quoted, so nothing the caller
 * typed is read as FTS5 syntax, joined with OR so a note matching more of the
 * words ranks higher. Null when the text holds no word.
 */
export function ftsQuery(query: string): string | null {
	const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu);
	if (!words) return null;
	const terms = [...new Set(words)].slice(0, MAX_QUERY_TERMS);
	return terms.map((t) => `"${t}"`).join(" OR ");
}

/** Cleans a folder argument to a path prefix ending in a slash; null for "no folder"; false when unusable. */
export function folderPrefix(folder: string | undefined): string | null | false {
	if (folder === undefined) return null;
	const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
	if (trimmed === "") return null;
	if (trimmed.length > MAX_PATH_LENGTH || /[\x00-\x1f\x7f\\]/.test(trimmed)) return false;
	if (trimmed.split("/").some((s) => s === "" || s === "." || s === "..")) return false;
	return `${trimmed}/`;
}
