#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Asks the server to bring its search index in line with the notes repo: the
// recovery step when a change pushed with plain git does not show up in
// memory_search (the push event was lost). Signs in once in the
// browser; the access token stays in this process.
//
// Usage: node scripts/reindex.mjs (--env NAME | --url ADDRESS) [--full]
//   --env reads the address from deploy/NAME.json.
//   --full reads every note again; without it only notes that differ are read.
import { adminReindex, flag, signIn, target } from "./lib/client.mjs";

const { base } = target();
const token = await signIn(base, "memory-mcp reindex script");
const result = await adminReindex(base, token, flag("full"));
// The answer holds counts and a state, never a path or note text.
console.log(`HTTP ${result.status} in ${result.ms} ms\n${result.text}`);
process.exit(result.status === 200 ? 0 : 1);
