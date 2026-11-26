// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// What the scripts share: command-line options, a browser sign-in that ends
// with an access token held only in this process, and one MCP tool call.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { baseUrl, loadDeploy } from "./configure.mjs";

/** The `_meta` key the Worker reports its own time under (src/mcp.ts). */
export const WORKER_MS_META = "memory-mcp/worker_ms";

export function option(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export const flag = (name) => process.argv.includes(`--${name}`);

/**
 * Which server to talk to: `--env NAME` reads the address from deploy/NAME.json
 * (the file `npm run deploy -- NAME` uses), `--url ADDRESS` names one directly
 * (a local server, a preview). Exits 2 when neither or both are given, and 1
 * when the deploy file is not usable. `env` and `values` are null for --url.
 */
export function target() {
	const env = option("env", null);
	const url = option("url", null);
	if (!env === !url) {
		console.error("Name the server with --env <name> (from deploy/<name>.json) or --url <address>, not both.");
		process.exit(2);
	}
	if (url) return { base: url.replace(/\/+$/, ""), env: null, values: null };
	try {
		const values = loadDeploy(env);
		return { base: baseUrl(values), env, values };
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}

const b64url = (buffer) => buffer.toString("base64url");

/**
 * Judges the browser's return to the callback address: the code to exchange, or
 * why there is none. The state is checked before the code is looked at, and a
 * missing code is a failure here, never a value passed on to the exchange.
 */
export function callbackOutcome(params, expectedState) {
	const error = params.get("error");
	if (error) return { ok: false, reason: `the server answered ${error}` };
	if (params.get("state") !== expectedState) {
		return { ok: false, reason: "the state did not match the one this script sent" };
	}
	const code = params.get("code");
	if (!code) return { ok: false, reason: "no code came back" };
	return { ok: true, code };
}

async function postJson(url, body) {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify(body),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${url} answered ${response.status}: ${text.slice(0, 200)}`);
	return JSON.parse(text);
}

/**
 * Registers a throwaway client, opens the browser, and returns an access
 * token. The token is never printed or written; it lasts as long as the
 * process. The client's name becomes the commit author of anything written.
 */
export async function signIn(base, clientName) {
	const verifier = b64url(randomBytes(32));
	const challenge = b64url(createHash("sha256").update(verifier).digest());
	const state = b64url(randomBytes(16));

	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

	const client = await postJson(`${base}/oauth/register`, {
		client_name: clientName,
		redirect_uris: [redirectUri],
		grant_types: ["authorization_code"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	});

	const authorize = new URL(`${base}/authorize`);
	authorize.search = new URLSearchParams({
		response_type: "code",
		client_id: client.client_id,
		redirect_uri: redirectUri,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		resource: `${base}/mcp`,
	}).toString();

	const code = await new Promise((resolve, reject) => {
		server.on("request", (request, response) => {
			const url = new URL(request.url, redirectUri);
			if (url.pathname !== "/callback") {
				response.writeHead(404).end();
				return;
			}
			// The page and the script say the same thing: both come from one verdict.
			const outcome = callbackOutcome(url.searchParams, state);
			response.writeHead(outcome.ok ? 200 : 400, { "content-type": "text/plain" });
			response.end(
				outcome.ok
					? "Signed in. You can close this tab.\n"
					: `Sign-in failed: ${outcome.reason}. Nothing was signed in; see the terminal.\n`,
			);
			if (outcome.ok) resolve(outcome.code);
			else reject(new Error(`sign-in failed: ${outcome.reason}`));
		});
		console.log(`Opening the browser to sign in. If it does not open, visit:\n${authorize}\n`);
		spawn("open", [authorize.toString()], { stdio: "ignore" }).on("error", () => {});
	});
	server.close();

	const tokenResponse = await fetch(`${base}/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: client.client_id,
			code_verifier: verifier,
			resource: `${base}/mcp`,
		}),
	});
	const token = await tokenResponse.json();
	if (!token.access_token) throw new Error(`token exchange failed: ${tokenResponse.status}`);
	return token.access_token;
}

/**
 * Pulls the tool result out of a raw /mcp response (one SSE event, or plain
 * JSON). Returns null for anything that is not a JSON-RPC result.
 */
export function parseToolResponse(raw) {
	const data = raw.split("\n").find((line) => line.startsWith("data:"));
	let body;
	try {
		body = JSON.parse(data ? data.slice(5) : raw);
	} catch {
		return null;
	}
	const result = body?.result;
	if (!result || !Array.isArray(result.content)) return null;
	const text = result.content[0]?.text;
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	const workerMs = result._meta?.[WORKER_MS_META];
	return {
		isError: result.isError === true,
		text,
		json,
		workerMs: Number.isFinite(workerMs) ? workerMs : null,
	};
}

/**
 * One tools/call. `onRaw(status, raw)` is called before anything parses the
 * response, so a caller can save it first.
 */
export async function callTool(base, token, id, name, args, onRaw) {
	const started = performance.now();
	const response = await fetch(`${base}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
	});
	const raw = await response.text();
	const clientMs = performance.now() - started;
	onRaw?.(response.status, raw);
	return { status: response.status, clientMs, parsed: response.ok ? parseToolResponse(raw) : null };
}

/** POST /mcp/admin/reindex, with ?full=1 when `full`. Returns status, elapsed time and the body's text. */
export async function adminReindex(base, token, full) {
	const started = performance.now();
	const response = await fetch(`${base}/mcp/admin/reindex${full ? "?full=1" : ""}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
	});
	const text = await response.text();
	return { status: response.status, ms: Math.round(performance.now() - started), text };
}

export function median(values) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
