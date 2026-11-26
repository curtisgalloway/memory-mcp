// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// The consent page. Every string in ConsentDescription can come from the MCP
// client (registration or a metadata document), so it is attacker-chosen and
// is escaped before it reaches the page.
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The page asking whether a client may act for the owner. No scopes: this
 * server defines none, so the form posts only the handle and the decision.
 */
export function consentPage(details: ConsentDescription, handle: string): string {
	const name = escapeHtml(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
		: "This app registered itself; its name is self-reported and unverified.";
	const loopback = details.redirectIsLoopback
		? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>"
		: "";
	return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<h1>Allow ${name} to use your memory?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<form method="post">
	<input type="hidden" name="handle" value="${escapeHtml(handle)}">
	<p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>
`;
}
