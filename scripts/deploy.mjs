#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Regenerates wrangler.<env>.jsonc from deploy/<env>.json, then deploys it.
//
// Usage: npm run deploy -- <env> [wrangler deploy options, e.g. --dry-run]
import { spawnSync } from "node:child_process";
import { generateConfig, isEnvName } from "./lib/configure.mjs";

const [env, ...extra] = process.argv.slice(2);
if (!isEnvName(env)) {
	console.error("usage: npm run deploy -- <env> [wrangler deploy options]");
	process.exit(2);
}
let config;
try {
	config = generateConfig(env);
} catch (error) {
	console.error(`deploy: ${error.message}`);
	process.exit(1);
}
const result = spawnSync("npx", ["wrangler", "deploy", "--config", config, ...extra], { stdio: "inherit" });
process.exit(result.status ?? 1);
