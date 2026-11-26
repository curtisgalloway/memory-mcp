// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// The OAuth provider's defaultHandler: consent page, the GitHub round trip,
// and the one check that matters. Only the GitHub account whose numeric ID is
// ALLOWED_GITHUB_ID may obtain a grant (requirement R2), so
// completeAuthorization is called in exactly one place, handleCallback, and
// only after verifyGithubAccount has returned "verified".
import {
	AuthorizationError,
	CimdFetchError,
	authorizationErrorRedirect,
} from "@cloudflare/workers-oauth-provider";
import { consentPage } from "./html";
import type { GrantProps } from "./props";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const MAX_CLIENT_NAME = 100;

// The generated global Env does not pick up the bindings src/env.d.ts adds to
// Cloudflare.Env (the secret and OAUTH_PROVIDER), so the handler narrows to it.
type AuthEnv = Cloudflare.Env;

interface UpstreamData {
	verifier: string;
}

type Verification =
	| { kind: "verified"; githubId: number; githubLogin: string }
	| { kind: "refused"; githubId?: number }
	| { kind: "upstream_error" };

function plain(message: string, status: number): Response {
	return new Response(`${message}\n`, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}

function redirect(location: string, headers: Headers = new Headers()): Response {
	headers.set("Location", location);
	return new Response(null, { status: 302, headers });
}

function logSignin(outcome: string, githubId?: number): void {
	// Never add tokens, codes or the verifier here.
	console.log(JSON.stringify({ event: "signin", outcome, githubId }));
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function s256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64Url(new Uint8Array(digest));
}

function newVerifier(): string {
	return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Exchanges GitHub's code for a token, asks GitHub who that is, and compares
 * the numeric account ID with the allowed one. The token lives only in this
 * function. Anything but an exact numeric match is a refusal.
 */
async function verifyGithubAccount(
	env: AuthEnv,
	origin: string,
	code: string,
	verifier: string,
): Promise<Verification> {
	const allowed = Number(env.ALLOWED_GITHUB_ID);
	if (!Number.isSafeInteger(allowed) || allowed <= 0) {
		return { kind: "refused" };
	}
	let accessToken: string;
	let user: { id?: unknown; login?: unknown };
	try {
		const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": "memory-mcp",
			},
			body: JSON.stringify({
				client_id: env.GITHUB_CLIENT_ID,
				client_secret: env.GITHUB_CLIENT_SECRET,
				code,
				redirect_uri: `${origin}/callback`,
				code_verifier: verifier,
			}),
		});
		if (!tokenResponse.ok) return { kind: "upstream_error" };
		const body = (await tokenResponse.json()) as { access_token?: unknown };
		if (typeof body.access_token !== "string" || body.access_token === "") {
			return { kind: "upstream_error" };
		}
		accessToken = body.access_token;
		const userResponse = await fetch(GITHUB_USER_URL, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${accessToken}`,
				"User-Agent": "memory-mcp",
			},
		});
		if (!userResponse.ok) return { kind: "upstream_error" };
		user = (await userResponse.json()) as { id?: unknown; login?: unknown };
	} catch {
		return { kind: "upstream_error" };
	}
	if (typeof user.id !== "number" || !Number.isSafeInteger(user.id)) {
		return { kind: "refused" };
	}
	if (user.id !== allowed) return { kind: "refused", githubId: user.id };
	return {
		kind: "verified",
		githubId: user.id,
		githubLogin: typeof user.login === "string" ? user.login : "",
	};
}

async function showConsent(request: Request, env: AuthEnv): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const authRequest = await oauth.parseAuthRequest(request);
	// Describe first: a failed client lookup then leaves nothing in KV.
	const details = await oauth.describeConsent(authRequest);
	const consent = await oauth.beginConsent(authRequest);
	consent.headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(consentPage(details, consent.handle), {
		headers: consent.headers,
	});
}

async function handleDecision(request: Request, env: AuthEnv, origin: string): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const form = await request.formData();
	const handle = String(form.get("handle") ?? "");
	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(request, handle);
		return redirect(denied.redirectTo, denied.headers);
	}
	// No remembered consent: every sign-in asks again.
	const approved = await oauth.approveConsent(request, handle);
	const verifier = newVerifier();
	const { state, headers } = await oauth.beginUpstream(approved.request, {
		data: { verifier } satisfies UpstreamData,
		headers: approved.headers,
	});
	// No scope: the public account ID is all that is needed.
	const url = new URL(GITHUB_AUTHORIZE_URL);
	url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
	url.searchParams.set("redirect_uri", `${origin}/callback`);
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", await s256(verifier));
	url.searchParams.set("code_challenge_method", "S256");
	return redirect(url.toString(), headers);
}

async function handleCallback(request: Request, env: AuthEnv, origin: string): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const params = new URL(request.url).searchParams;
	const {
		request: original,
		data,
		headers,
	} = await oauth.finishUpstream<UpstreamData>(request);

	const code = params.get("code");
	if (params.get("error") || !code) {
		logSignin("upstream_error");
		return redirect(authorizationErrorRedirect(original, "access_denied"), headers);
	}

	const result = await verifyGithubAccount(env, origin, code, data.verifier);
	if (result.kind === "refused") {
		logSignin("refused", result.githubId);
		return redirect(authorizationErrorRedirect(original, "access_denied"), headers);
	}
	if (result.kind === "upstream_error") {
		logSignin("upstream_error");
		return redirect(authorizationErrorRedirect(original, "temporarily_unavailable"), headers);
	}

	// The only completeAuthorization call in the Worker: reached only for the
	// allowed account.
	const details = await oauth.describeConsent(original);
	const props: GrantProps = {
		githubId: result.githubId,
		githubLogin: result.githubLogin,
		clientName: details.clientName.slice(0, MAX_CLIENT_NAME),
	};
	const { redirectTo } = await oauth.completeAuthorization({
		request: original,
		userId: String(result.githubId),
		metadata: {},
		scope: original.scope,
		props,
	});
	logSignin("granted", result.githubId);
	return redirect(redirectTo, headers);
}

async function route(request: Request, env: AuthEnv): Promise<Response> {
	const url = new URL(request.url);
	const { origin, pathname } = url;
	if (pathname === "/" && request.method === "GET") {
		return plain("memory-mcp: a private MCP server for one person's notes.", 200);
	}
	if (pathname === "/authorize" && request.method === "GET") {
		return showConsent(request, env);
	}
	if (pathname === "/authorize" && request.method === "POST") {
		return handleDecision(request, env, origin);
	}
	if (pathname === "/callback" && request.method === "GET") {
		return handleCallback(request, env, origin);
	}
	return plain("Not found", 404);
}

export const authHandler: ExportedHandler<Env> = {
	async fetch(request, rawEnv) {
		const env = rawEnv as AuthEnv;
		const isParse = request.method === "GET" && new URL(request.url).pathname === "/authorize";
		try {
			return await route(request, env);
		} catch (error) {
			// Only a failure of parseAuthRequest carries a validated redirect URI
			// worth using; the later steps render locally.
			if (error instanceof AuthorizationError && error.redirectTo && isParse) {
				return redirect(error.redirectTo);
			}
			if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
				const message =
					error instanceof AuthorizationError
						? error.description
						: "This app could not be verified.";
				// text/plain is not parsed as HTML, so the message needs no escaping.
				return plain(message, 400);
			}
			throw error;
		}
	},
};
