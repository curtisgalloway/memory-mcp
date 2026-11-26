#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Writes wrangler.<env>.jsonc from deploy/<env>.json, after checking the
// values. The output is gitignored; `npm run deploy -- <env>` runs this first.
//
// Usage: node scripts/configure.mjs <env>      (npm run configure -- <env>)
//   Copy deploy/example.json to deploy/<env>.json and fill it in first.
//   Exits 0 with the generated file's name; 1 when the values are not usable;
//   2 for a bad command line.
import { generateConfig, isEnvName } from "./lib/configure.mjs";

const [env, ...rest] = process.argv.slice(2);
if (!isEnvName(env) || rest.length) {
	console.error("usage: configure.mjs <env>   (reads deploy/<env>.json, writes wrangler.<env>.jsonc)");
	process.exit(2);
}
try {
	console.log(`configure: wrote ${generateConfig(env)}`);
} catch (error) {
	console.error(`configure: ${error.message}`);
	process.exit(1);
}
