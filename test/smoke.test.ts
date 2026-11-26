// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("unauthenticated access", () => {
	it("refuses /mcp without a token", async () => {
		const response = await exports.default.fetch("http://localhost:8787/mcp", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("Bearer");
	});
});
