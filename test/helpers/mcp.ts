// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Calls the MCP handler directly, the way the OAuth provider does on a deployed
// request: the grant's props ride on the execution context.
import { createExecutionContext, env } from "cloudflare:test";
import { mcpHandler } from "../../src/mcp";
import type { GrantProps } from "../../src/props";

export const CLIENT_NAME = "test-client";

export const PROPS: GrantProps = {
	githubId: 1000001,
	githubLogin: "test-user",
	clientName: CLIENT_NAME,
};

export async function rpc(
	method: string,
	params: unknown,
	props: Partial<GrantProps> | null = PROPS,
): Promise<any> {
	const request = new Request("http://localhost:8787/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			// A constructed Request carries no Host header; the handler requires one.
			host: "localhost:8787",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const ctx = createExecutionContext() as ExecutionContext & { props?: unknown };
	if (props !== null) ctx.props = props;
	const response = await mcpHandler(request, env, ctx);
	if (response.status !== 200) {
		throw new Error(`${response.status} ${await response.text()}`);
	}
	const text = await response.text();
	const data = text.split("\n").find((line) => line.startsWith("data:"));
	return JSON.parse(data ? data.slice(5) : text);
}

export async function callTool(
	name: string,
	args: Record<string, unknown>,
	props: Partial<GrantProps> | null = PROPS,
): Promise<{ isError?: boolean; text: string; json: any }> {
	const body = await rpc("tools/call", { name, arguments: args }, props);
	const text: string = body.result.content[0].text;
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { isError: body.result.isError, text, json };
}
