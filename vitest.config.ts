// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			// Set both GitHub values here: a local .env must not override them.
			miniflare: {
				bindings: {
					GITHUB_CLIENT_ID: "local-dev",
					GITHUB_CLIENT_SECRET: "test-client-secret",
				},
			},
		}),
	],
	test: { include: ["test/**/*.test.ts"] },
});
