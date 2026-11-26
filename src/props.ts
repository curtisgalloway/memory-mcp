// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * What a grant records about who signed in and through which client. Stored
 * (encrypted) by the OAuth provider at sign-in and handed to every MCP request.
 */
export interface GrantProps {
	/** Numeric GitHub account ID; always equal to ALLOWED_GITHUB_ID. */
	githubId: number;
	githubLogin: string;
	/**
	 * The MCP client's self-reported name (for example "Claude"), which becomes
	 * the git commit author label. Unverified: never use it for access control.
	 */
	clientName: string;
}
