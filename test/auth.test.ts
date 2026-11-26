// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// The sign-in flow end to end, through the real OAuth provider, with only
// GitHub's two endpoints faked.
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "http://localhost:8787";
const REDIRECT_URI = "https://client.example/cb";
const ALLOWED_ID = 1000001;

type GithubBehavior = {
	tokenOk: boolean;
	userId: unknown;
};

let github: GithubBehavior;
let githubCalls: string[];
const realFetch = globalThis.fetch;

beforeEach(() => {
	github = { tokenOk: true, userId: ALLOWED_ID };
	githubCalls = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.href === "https://github.com/login/oauth/access_token") {
			githubCalls.push(url.href);
			if (!github.tokenOk) {
				return Response.json({ error: "bad_verification_code" });
			}
			return Response.json({ access_token: "gho_test_token" });
		}
		if (url.href === "https://api.github.com/user") {
			githubCalls.push(url.href);
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer gho_test_token");
			expect(headers.get("user-agent")).toBeTruthy();
			return Response.json({ id: github.userId, login: "octo" });
		}
		return realFetch(input, init);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

const worker = (path: string, init?: RequestInit) =>
	exports.default.fetch(`${ORIGIN}${path}`, { redirect: "manual", ...init });

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

async function pkce() {
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function cookieHeader(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

async function register(clientName = "Test Client") {
	const response = await worker("/oauth/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: clientName,
			redirect_uris: [REDIRECT_URI],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { client_id: string }).client_id;
}

async function openConsent(clientId: string, challenge: string) {
	const query = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		state: "client-state",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: `${ORIGIN}/mcp`,
	});
	const response = await worker(`/authorize?${query}`);
	const html = await response.text();
	return { response, html, handle: /name="handle" value="([^"]+)"/.exec(html)?.[1] };
}

async function decide(
	consent: Awaited<ReturnType<typeof openConsent>>,
	decision: "approve" | "deny",
) {
	return worker("/authorize", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			cookie: cookieHeader(consent.response),
		},
		body: new URLSearchParams({ handle: consent.handle ?? "", decision }),
	});
}

/** Runs the flow up to GitHub's redirect and returns what the callback needs. */
async function reachGithub(clientName?: string) {
	const clientId = await register(clientName);
	const { verifier, challenge } = await pkce();
	const consent = await openConsent(clientId, challenge);
	expect(consent.handle).toBeTruthy();
	const approved = await decide(consent, "approve");
	expect(approved.status).toBe(302);
	const location = new URL(approved.headers.get("location") ?? "");
	return { clientId, verifier, consent, approved, location, cookies: cookieHeader(approved) };
}

function callback(
	flow: Awaited<ReturnType<typeof reachGithub>>,
	extra: Record<string, string>,
	cookies = flow.cookies,
) {
	const query = new URLSearchParams({ state: flow.location.searchParams.get("state") ?? "", ...extra });
	return worker(`/callback?${query}`, { headers: { cookie: cookies } });
}

describe("consent page", () => {
	it("is not frameable and escapes the client name", async () => {
		const clientId = await register("<script>alert(1)</script>");
		const { challenge } = await pkce();
		const { response, html } = await openConsent(clientId, challenge);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&#60;script&#62;");
		expect(html).toContain("client.example");
		expect(html).toContain("unverified");
	});

	it("sends the user to GitHub with PKCE and no scope after Allow", async () => {
		const flow = await reachGithub();
		expect(flow.location.origin + flow.location.pathname).toBe(
			"https://github.com/login/oauth/authorize",
		);
		expect(flow.location.searchParams.get("client_id")).toBe("local-dev");
		expect(flow.location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
		expect(flow.location.searchParams.get("code_challenge_method")).toBe("S256");
		expect(flow.location.searchParams.get("code_challenge")).toBeTruthy();
		expect(flow.location.searchParams.has("scope")).toBe(false);
	});

	it("answers access_denied when the user clicks Deny", async () => {
		const clientId = await register();
		const { challenge } = await pkce();
		const consent = await openConsent(clientId, challenge);
		const denied = await decide(consent, "deny");
		expect(denied.status).toBe(302);
		const target = new URL(denied.headers.get("location") ?? "");
		expect(target.origin + target.pathname).toBe(REDIRECT_URI);
		expect(target.searchParams.get("error")).toBe("access_denied");
		expect(target.searchParams.has("code")).toBe(false);
		expect(githubCalls).toEqual([]);
	});
});

describe("callback", () => {
	it("grants the allowed account, and the token works on /mcp", async () => {
		const flow = await reachGithub();
		const response = await callback(flow, { code: "github-code" });
		expect(response.status).toBe(302);
		const target = new URL(response.headers.get("location") ?? "");
		expect(target.origin + target.pathname).toBe(REDIRECT_URI);
		expect(target.searchParams.get("state")).toBe("client-state");
		const code = target.searchParams.get("code");
		expect(code).toBeTruthy();

		const tokenResponse = await worker("/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: code ?? "",
				redirect_uri: REDIRECT_URI,
				client_id: flow.clientId,
				code_verifier: flow.verifier,
				resource: `${ORIGIN}/mcp`,
			}),
		});
		expect(tokenResponse.status).toBe(200);
		const { access_token } = (await tokenResponse.json()) as { access_token: string };
		const mcp = await worker("/mcp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${access_token}`,
			},
			body: "{}",
		});
		expect(mcp.status).not.toBe(401);
	});

	it("refuses a different GitHub account", async () => {
		github.userId = ALLOWED_ID + 1;
		const flow = await reachGithub();
		const response = await callback(flow, { code: "github-code" });
		expect(response.status).toBe(302);
		const target = new URL(response.headers.get("location") ?? "");
		expect(target.origin + target.pathname).toBe(REDIRECT_URI);
		expect(target.searchParams.get("error")).toBe("access_denied");
		expect(target.searchParams.has("code")).toBe(false);
	});

	it("refuses an ID that is not a number, even one that looks equal", async () => {
		github.userId = String(ALLOWED_ID);
		const flow = await reachGithub();
		const response = await callback(flow, { code: "github-code" });
		const target = new URL(response.headers.get("location") ?? "");
		expect(target.searchParams.get("error")).toBe("access_denied");
		expect(target.searchParams.has("code")).toBe(false);
	});

	it("reports a failed GitHub token exchange without a code", async () => {
		github.tokenOk = false;
		const flow = await reachGithub();
		const response = await callback(flow, { code: "github-code" });
		expect(response.status).toBe(302);
		const target = new URL(response.headers.get("location") ?? "");
		expect(target.origin + target.pathname).toBe(REDIRECT_URI);
		expect(target.searchParams.get("error")).toBe("temporarily_unavailable");
		expect(target.searchParams.has("code")).toBe(false);
	});

	it("passes GitHub's own error back to the client as access_denied", async () => {
		const flow = await reachGithub();
		const response = await callback(flow, { error: "access_denied" });
		const target = new URL(response.headers.get("location") ?? "");
		expect(target.searchParams.get("error")).toBe("access_denied");
		expect(target.searchParams.has("code")).toBe(false);
		expect(githubCalls).toEqual([]);
	});

	it("renders locally when the binding cookie is missing", async () => {
		const flow = await reachGithub();
		const response = await callback(flow, { code: "github-code" }, "");
		expect(response.status).toBe(400);
		expect(response.headers.get("location")).toBeNull();
		expect(githubCalls).toEqual([]);
	});
});

describe("other paths", () => {
	it("answers 404 in plain text", async () => {
		const response = await worker("/nope");
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toContain("text/plain");
	});
});
