// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Bindings that `wrangler types` cannot see: the secret set with
// `wrangler secret put`, and the helper object the OAuth provider injects.
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
	namespace Cloudflare {
		interface Env {
			GITHUB_CLIENT_SECRET: string;
			OAUTH_PROVIDER: OAuthHelpers;
		}
	}
}
