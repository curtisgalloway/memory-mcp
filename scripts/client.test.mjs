// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKER_MS_META, callbackOutcome, median, parseToolResponse } from "./lib/client.mjs";

const envelope = (result) => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`;

test("parseToolResponse reads the result and the Worker's time from one SSE event", () => {
	const parsed = parseToolResponse(
		envelope({ content: [{ type: "text", text: '{"version":"abc"}' }], _meta: { [WORKER_MS_META]: 42 } }),
	);
	assert.deepEqual(parsed, { isError: false, text: '{"version":"abc"}', json: { version: "abc" }, workerMs: 42 });
});

test("parseToolResponse keeps a tool error apart from success, with plain-text content", () => {
	const parsed = parseToolResponse(
		JSON.stringify({ result: { content: [{ type: "text", text: "No note at x" }], isError: true } }),
	);
	assert.equal(parsed.isError, true);
	assert.equal(parsed.json, undefined);
	assert.equal(parsed.workerMs, null);
});

test("parseToolResponse answers null for a protocol error or a body that is not JSON", () => {
	assert.equal(parseToolResponse(JSON.stringify({ error: { code: -32602, message: "bad" } })), null);
	assert.equal(parseToolResponse("<html>502</html>"), null);
});

test("callbackOutcome gives a code only when the state matches and a code came back", () => {
	const params = (text) => new URLSearchParams(text);
	assert.deepEqual(callbackOutcome(params("state=s1&code=abc"), "s1"), { ok: true, code: "abc" });
	assert.equal(callbackOutcome(params("state=other&code=abc"), "s1").ok, false);
	assert.match(callbackOutcome(params("state=other&code=abc"), "s1").reason, /state/);
	// No code: a failure, never the string "null" handed to the exchange.
	assert.deepEqual(callbackOutcome(params("state=s1"), "s1"), { ok: false, reason: "no code came back" });
	assert.equal(callbackOutcome(params("state=s1&code="), "s1").ok, false);
	assert.match(callbackOutcome(params("error=access_denied&state=s1&code=abc"), "s1").reason, /access_denied/);
});

test("median handles odd, even and empty lists", () => {
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([4, 1, 3, 2]), 2.5);
	assert.equal(median([]), null);
});
