#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Counts Artifacts events per repo and day, for requirement R10.
// Reads Cloudflare's GraphQL Analytics API, dataset
// `artifactsEventsAdaptiveGroups` (Artifacts docs, "Metrics", read 2026-11-25:
// 31 days are kept; event types push, pull, create, fork, delete).
//
// How the bill counts them (Artifacts docs, "Pricing", read 2026-11-25): a
// pull (clone or fetch), push, create, fork or delete is one operation each;
// reads of repo content (files, trees, commits, logs) are billed at 100 to 1;
// 10,000 operations a month are included. The metrics show actual events, not
// billed operations. Seen in the data on 2026-11-25: content reads appear as
// type "read", and minting a repo token as "token_create", which the pricing
// page does not list as billed. The script prints every event type it gets
// and estimates the bill as the five one-each types plus reads / 100.
//
// The API token comes from the environment (CLOUDFLARE_API_TOKEN) or, failing
// that, from Wrangler's own sign-in; it is held in memory and never printed.
// If the token may not read analytics the API says so; then read the same
// numbers in the Cloudflare dashboard's Artifacts page.
//
// --env NAME counts only the Artifacts namespace named in deploy/NAME.json;
// --namespace NAME names one directly; with neither, every namespace of the
// account is counted.
//
// Usage: node scripts/operations.mjs [--days 1] [--env NAME | --namespace NAME]
import { execFileSync } from "node:child_process";
import { option } from "./lib/client.mjs";
import { loadDeploy } from "./lib/configure.mjs";

const days = Number(option("days", "1"));
const env = option("env", null);
let namespace = option("namespace", null);
if (env) {
	try {
		namespace ??= loadDeploy(env).artifactsNamespace;
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
if (!(days > 0 && days <= 31)) {
	console.error("--days must be between 1 and 31 (the API keeps 31 days).");
	process.exit(2);
}

const wrangler = (...args) =>
	execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

let token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) token = JSON.parse(wrangler("auth", "token", "--json")).token;
let account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account) account = JSON.parse(wrangler("whoami", "--json")).accounts?.[0]?.id;
if (!token || !account) {
	console.error("No API token or account ID: sign in with `npx wrangler login`, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
	process.exit(2);
}

const until = new Date();
const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
const query = `query ArtifactsEvents($account: string!, $since: Time!, $until: Time!${namespace ? ", $namespace: string!" : ""}) {
	viewer {
		accounts(filter: { accountTag: $account }) {
			artifactsEventsAdaptiveGroups(
				limit: 10000
				filter: { datetime_geq: $since, datetime_leq: $until${namespace ? ", repositoryNamespace: $namespace" : ""} }
				orderBy: [date_ASC]
			) {
				count
				dimensions { date repositoryNamespace repositoryName eventKind eventType }
			}
		}
	}
}`;

const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
	method: "POST",
	headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
	body: JSON.stringify({
		query,
		variables: { account, since: since.toISOString(), until: until.toISOString(), ...(namespace ? { namespace } : {}) },
	}),
});
const body = await response.json().catch(() => null);
if (!response.ok || !body || body.errors?.length) {
	// Messages only: nothing here echoes the token.
	const messages = (body?.errors ?? []).map((error) => error.message).join("; ");
	console.error(`The analytics API answered ${response.status}. ${messages}`);
	process.exit(1);
}

const BILLED_ONE_EACH = new Set(["push", "pull", "create", "fork", "delete"]);
const groups = body.data?.viewer?.accounts?.[0]?.artifactsEventsAdaptiveGroups ?? [];
const perRepo = {};
console.log(`Artifacts events, ${namespace ? `namespace ${namespace}` : "all namespaces"}, ${since.toISOString()} to ${until.toISOString()}`);
console.log(["date", "namespace/repo", "kind", "type", "count"].join("\t"));
for (const group of groups) {
	const { date, repositoryNamespace, eventKind, eventType } = group.dimensions;
	// Two namespaces may each hold a repo of the same name: count them apart.
	const repositoryName = `${repositoryNamespace}/${group.dimensions.repositoryName}`;
	console.log([date, repositoryName, eventKind, eventType, group.count].join("\t"));
	if (eventKind !== "action") continue;
	const counts = (perRepo[repositoryName] ??= { each: 0, reads: 0 });
	if (BILLED_ONE_EACH.has(eventType)) counts.each += group.count;
	else if (eventType === "read") counts.reads += group.count;
}
console.log("");
let total = 0;
for (const [repo, counts] of Object.entries(perRepo)) {
	const billed = counts.each + Math.ceil(counts.reads / 100);
	total += billed;
	console.log(
		`${repo}: about ${billed} billed operations in ${days} day(s) (${counts.each} pulls, pushes, creates, forks and deletes; ${counts.reads} content reads at 100 to 1)`,
	);
}
console.log(
	`all repos: about ${total} in ${days} day(s), which is ${Math.round((total / days) * 30)} a 30-day month against 10,000 included`,
);
