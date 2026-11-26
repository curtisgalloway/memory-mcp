// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
	authorLabel,
	checkNotePath,
	checkNoteText,
	cleanAuthorName,
	cleanMessage,
	findSecret,
	MAX_MESSAGE_LENGTH,
	MAX_NOTE_BYTES,
	parseNote,
} from "../src/notes";

describe("checkNotePath", () => {
	it("accepts one, two and three folders", () => {
		expect(checkNotePath("a/x.md")).toBeNull();
		expect(checkNotePath("projects/alpha-2/notes.md")).toBeNull();
		expect(checkNotePath("a/b/c/x.md")).toBeNull();
	});

	it("refuses traversal", () => {
		expect(checkNotePath("../etc/passwd.md")).toMatch(/traversal/);
		expect(checkNotePath("a/../b/x.md")).toMatch(/traversal/);
	});

	it("refuses uppercase", () => {
		expect(checkNotePath("Projects/a.md")).toMatch(/lowercase/);
	});

	it("refuses paths that are too deep", () => {
		expect(checkNotePath("a/b/c/d/x.md")).toMatch(/at most 3 folders/);
		expect(checkNotePath("a/b/c/d/e.md")).toMatch(/at most 3 folders/);
	});

	it("refuses anything but .md", () => {
		expect(checkNotePath("a/b.txt")).toMatch(/\.md/);
		expect(checkNotePath(".git/config")).toMatch(/\.md/);
	});

	it("refuses a file at the top level", () => {
		expect(checkNotePath("x.md")).toMatch(/inside a folder/);
	});

	it("refuses empty segments and a leading slash", () => {
		expect(checkNotePath("a//b.md")).toMatch(/empty segments/);
		expect(checkNotePath("/a/b.md")).toMatch(/leading slash/);
		expect(checkNotePath("a/.md")).toMatch(/empty/);
	});

	it("refuses other characters and dots", () => {
		expect(checkNotePath("a/b c.md")).toMatch(/a-z, 0-9/);
		expect(checkNotePath("a/b.c.md")).toMatch(/a-z, 0-9/);
		expect(checkNotePath("a/-b.md")).toMatch(/a-z, 0-9/);
		expect(checkNotePath("a/b_c.md")).toMatch(/a-z, 0-9/);
	});

	it("refuses an empty path and a path over 200 characters", () => {
		expect(checkNotePath("")).toMatch(/empty/);
		const long = `a/${"b".repeat(196)}.md`;
		expect(long.length).toBe(201);
		expect(checkNotePath(long)).toMatch(/200 characters/);
		expect(checkNotePath(`a/${"b".repeat(195)}.md`)).toBeNull();
	});
});

describe("checkNoteText", () => {
	it("accepts exactly 64 KiB and refuses one byte more", () => {
		expect(checkNoteText("a".repeat(MAX_NOTE_BYTES))).toBeNull();
		const message = checkNoteText("a".repeat(MAX_NOTE_BYTES + 1));
		expect(message).toMatch(/64 KiB/);
		expect(message).toMatch(/65537 bytes/);
	});

	it("counts UTF-8 bytes, not characters", () => {
		const text = "é".repeat(40_000);
		expect(text.length).toBeLessThan(MAX_NOTE_BYTES);
		expect(checkNoteText(text)).toMatch(/80000 bytes/);
	});

	it("refuses empty and whitespace-only text", () => {
		expect(checkNoteText("")).toMatch(/empty/);
		expect(checkNoteText(" \n\t ")).toMatch(/empty/);
	});

	it("refuses an unpaired surrogate", () => {
		expect(checkNoteText("a\ud800b")).toMatch(/well-formed Unicode/);
		expect(checkNoteText("a\ud83d\ude00b")).toBeNull();
	});
});

describe("findSecret", () => {
	const positives: [string, string][] = [
		["anthropic-api-key", "sk-ant-" + "a".repeat(40)],
		["openai-api-key", "sk-" + "A1".repeat(20)],
		["openai-api-key", "sk-proj-" + "b".repeat(40)],
		["github-token", "ghp_" + "x".repeat(36)],
		["github-token", "github_pat_" + "Y".repeat(30)],
		["aws-access-key-id", "key AKIA" + "ABCDEFGH12345678"],
		["aws-access-key-id", "ASIA" + "Z".repeat(16)],
		["slack-token", "xoxb-" + "1234567890-abc"],
		["google-api-key", "AIza" + "a".repeat(35)],
		["stripe-live-key", "sk_live_" + "a".repeat(24)],
		["stripe-live-key", "rk_live_" + "A".repeat(24)],
		["artifacts-repo-token", "art_v1_" + "c".repeat(30)],
		["onepassword-service-account-token", "ops_" + "d".repeat(50)],
		["private-key-block", "-----BEGIN RSA " + "PRIVATE KEY-----"],
		["private-key-block", "-----BEGIN " + "PRIVATE KEY-----"],
		["card-number", "card 4111 1111 1111 1111 on file"],
		["card-number", "4111-1111-1111-1111"],
		["card-number", "4111111111111111"],
		["password-line", "password: hunter2"],
		["password-line", "  - Passwd = 'abc'"],
		["password-line", 'line one\n"pwd": "x"\nline three'],
		["password-line", "reset my password: go to settings"],
	];

	for (const [name, text] of positives) {
		it(`finds ${name} in ${JSON.stringify(text.slice(0, 20))}`, () => {
			expect(findSecret(text)).toBe(name);
		});
	}

	it("returns only the pattern name, never the key", () => {
		const key = "sk-ant-" + "a".repeat(40);
		const found = findSecret(`my key is ${key}`);
		expect(found).toBe("anthropic-api-key");
		expect(found).not.toContain(key);
	});

	it("passes ordinary text", () => {
		expect(findSecret("Meeting notes: we agreed to ship on Friday.")).toBeNull();
		expect(findSecret("I keep my password in a manager.")).toBeNull();
		expect(findSecret("")).toBeNull();
	});

	it("does not flag a git SHA, a phone number or a non-Luhn number", () => {
		expect(findSecret("commit 3ae2572a1b9c4d5e6f708192a3b4c5d6e7f80912")).toBeNull();
		expect(findSecret("call +1 415-555-0134 tomorrow")).toBeNull();
		expect(findSecret("order 4111 1111 1111 1112 shipped")).toBeNull();
		expect(findSecret("id 12345678901234567890123")).toBeNull();
	});

	it("does not flag a 1Password reference as a password", () => {
		expect(findSecret("password: op://Vault/item/field")).toBeNull();
		expect(findSecret('password = "op://Vault/item/field"')).toBeNull();
		expect(findSecret('password: "op://Vault/item/field",')).toBeNull();
		expect(findSecret("PASSWORD=op://v/i/f")).toBeNull();
		// Vault and item names often hold spaces.
		expect(findSecret("password: op://Team Vault/my item/credential")).toBeNull();
		expect(findSecret('password: "op://Team Vault/my item/section/field"')).toBeNull();
	});

	it("flags a password line that only starts with a 1Password reference", () => {
		expect(findSecret("password: op://v/i/f (old one was hunter2)")).toBe("password-line");
		expect(findSecret('{"password": "op://v/i/f", "pwd": "hunter2"}')).toBe("password-line");
		expect(findSecret("password: op://v/i/f old one was hunter2")).toBe("password-line");
		expect(findSecret("password: op://not-a-reference")).toBe("password-line");
	});

	it("handles long adversarial input quickly", () => {
		const start = Date.now();
		findSecret("1 ".repeat(50_000));
		findSecret("password".repeat(20_000));
		findSecret("-".repeat(100_000));
		expect(Date.now() - start).toBeLessThan(2000);
	});
});

describe("cleanMessage", () => {
	it("collapses to one line and trims", () => {
		expect(cleanMessage("  fix\n\nthe  thing\t\r\n ")).toBe("fix the thing");
	});

	it("cuts to the maximum length", () => {
		expect(cleanMessage("x".repeat(500))).toBe("x".repeat(MAX_MESSAGE_LENGTH));
	});

	it("turns empty input into null", () => {
		expect(cleanMessage(undefined)).toBeNull();
		expect(cleanMessage("")).toBeNull();
		expect(cleanMessage(" \n\x00 ")).toBeNull();
	});
});

describe("authorLabel", () => {
	it("gives known clients a fixed label, whatever the case", () => {
		expect(authorLabel("Claude")).toBe("claude.ai");
		expect(authorLabel("Claude Code")).toBe("claude-code");
		expect(authorLabel("  claude   code ")).toBe("claude-code");
		expect(authorLabel("ChatGPT")).toBe("chatgpt");
	});

	it("keeps an unknown client's cleaned name", () => {
		expect(authorLabel("Some <Other> Client")).toBe("Some Other Client");
		expect(authorLabel("Claude Desktop")).toBe("Claude Desktop");
	});

	it("is null for a missing or empty name", () => {
		expect(authorLabel(undefined)).toBeNull();
		expect(authorLabel(" \t ")).toBeNull();
	});
});

describe("cleanAuthorName", () => {
	it("strips control characters and angle brackets", () => {
		expect(cleanAuthorName("Claude\x00 <evil@x>\x1f")).toBe("Claude evil@x");
	});

	it("collapses whitespace and trims", () => {
		expect(cleanAuthorName("  claude   ai \n code ")).toBe("claude ai code");
	});

	it("cuts to 64 characters", () => {
		expect(cleanAuthorName("n".repeat(100))).toBe("n".repeat(64));
	});

	it("turns empty input into null", () => {
		expect(cleanAuthorName(undefined)).toBeNull();
		expect(cleanAuthorName("")).toBeNull();
		expect(cleanAuthorName(" <> \x01")).toBeNull();
	});
});

describe("parseNote", () => {
	it("falls back to heading, first sentence and no tags", () => {
		const note = parseNote(
			"projects/alpha.md",
			"# Alpha plan\n\nWe ship in March. Then we rest.\n\nMore.",
		);
		expect(note.title).toBe("Alpha plan");
		expect(note.summary).toBe("We ship in March.");
		expect(note.tags).toEqual([]);
		expect(note.body).toContain("More.");
	});

	it("falls back to the file name when there is no heading", () => {
		const note = parseNote("projects/alpha-beta.md", "just text without end");
		expect(note.title).toBe("alpha-beta");
		expect(note.summary).toBe("just text without end");
	});

	it("cuts the summary to 120 characters", () => {
		const note = parseNote("a/b.md", "w".repeat(300));
		expect(note.summary).toBe("w".repeat(120));
	});

	it("skips headings and blank lines when finding the summary", () => {
		const note = parseNote("a/b.md", "\n# T\n## U\n\nFirst line\ncontinues here. Next.");
		expect(note.summary).toBe("First line continues here.");
	});

	it("reads frontmatter scalars and flow tags", () => {
		const note = parseNote(
			"a/b.md",
			'---\ntitle: "Quoted: title"\nsummary: A short one\ntags: [x, "y z", \'w\']\nother: ignored\n---\n# Heading\nBody.',
		);
		expect(note.title).toBe("Quoted: title");
		expect(note.summary).toBe("A short one");
		expect(note.tags).toEqual(["x", "y z", "w"]);
		expect(note.body).toBe("# Heading\nBody.");
	});

	it("reads block tags", () => {
		const note = parseNote("a/b.md", "---\ntags:\n  - one\n  - two\ntitle: T\n---\nBody.");
		expect(note.tags).toEqual(["one", "two"]);
		expect(note.title).toBe("T");
	});

	it("treats an unterminated block as no frontmatter", () => {
		const text = "---\ntitle: T\n\n# Real heading\nBody.";
		const note = parseNote("a/b.md", text);
		expect(note.body).toBe(text);
		expect(note.title).toBe("Real heading");
	});

	it("treats an unparsable block as no frontmatter", () => {
		const text = "---\nthis is not yaml\n---\nBody.";
		const note = parseNote("a/b.md", text);
		expect(note.body).toBe(text);
		expect(note.tags).toEqual([]);
		expect(parseNote("a/b.md", "---\ntags: [a, b\n---\nBody.").body).toContain("tags: [a, b");
	});

	it("handles empty text without throwing", () => {
		const note = parseNote("a/b.md", "");
		expect(note).toEqual({ title: "b", summary: "", tags: [], body: "" });
	});
});
