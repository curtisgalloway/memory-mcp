// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Worker entry. The OAuth provider owns the token, registration and discovery
// endpoints, and lets a request reach /mcp only with a valid access token.
// Everything else (the consent page and the GitHub round trip) is authHandler.
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { env } from "cloudflare:workers";
import { ADMIN_REINDEX_PATH, adminReindex } from "./admin";
import { authHandler } from "./auth";
import { mcpHandler } from "./mcp";

// Wrangler finds the Durable Object and Workflow classes by their export from
// the entry module.
export { OnRepoPushed } from "./events";
export { MemoryStore } from "./store";

const NINETY_DAYS = 90 * 24 * 60 * 60;

export default new OAuthProvider({
	apiRoute: "/mcp",
	apiHandler: {
		// Everything here has passed the provider's token check. The admin route
		// sits under /mcp because a token is bound to that path and no other.
		fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
			new URL(request.url).pathname === ADMIN_REINDEX_PATH
				? adminReindex(request, env)
				: mcpHandler(request, env, ctx),
	},
	defaultHandler: authHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/oauth/token",
	clientRegistrationEndpoint: "/oauth/register",
	clientIdMetadataDocumentEnabled: true,
	// A grant lasts while its client keeps using it, and lapses after 90 idle days.
	refreshTokenTTL: NINETY_DAYS,
	refreshTokenIdleTTL: NINETY_DAYS,
	// Every token is bound to this URL, the one clients connect to.
	resourceMetadata: { resource: env.MCP_RESOURCE },
});
