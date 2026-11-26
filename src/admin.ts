// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// The recovery route: rebuilds the index from the repo on request. It is reached
// only through the OAuth provider's API handler, so it needs the same grant as
// the MCP tools.

export const ADMIN_REINDEX_PATH = "/mcp/admin/reindex";

/** POST rebuilds what differs; POST with ?full=1 drops the index and rebuilds all of it. */
export async function adminReindex(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json(
			{ error: "method_not_allowed" },
			{ status: 405, headers: { allow: "POST" } },
		);
	}
	const full = new URL(request.url).searchParams.get("full") === "1";
	try {
		const result = await env.MEMORY_STORE.getByName("main").reindex({ full });
		return Response.json(result);
	} catch (error) {
		// Name only: an error's message can echo content.
		console.log(
			JSON.stringify({
				event: "admin_error",
				name: error instanceof Error ? error.name : typeof error,
			}),
		);
		return Response.json({ error: "reindex_failed" }, { status: 502 });
	}
}
