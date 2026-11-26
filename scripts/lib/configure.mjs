// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Turns deploy/<env>.json (one operator's account-specific values, gitignored)
// into wrangler.<env>.jsonc, a flat config with no "env" section, for
// `wrangler deploy --config`. The tracked wrangler.jsonc is local development
// and tests only; main, compatibility_date and compatibility_flags are read
// from it so the two cannot drift. None of the values is a secret.
// scripts/configure.mjs and scripts/deploy.mjs are the command lines.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Every field of deploy/<env>.json, in the order deploy/example.json lists them. */
export const FIELDS = [
	"workerName",
	"mcpResource",
	"artifactsNamespace",
	"memoryRepo",
	"kvNamespaceId",
	"allowedGithubId",
	"githubClientId",
];

const PUSH_EVENT = "cf.artifacts.repo.pushed";
const ENV_NAME = /^[a-z0-9][a-z0-9-]*$/;
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KV_ID = /^[0-9a-f]{32}$/;
const GITHUB_ID = /^[1-9][0-9]*$/;
const GITHUB_CLIENT_ID = /^[A-Za-z0-9]{16,40}$/;

/**
 * Removes // and block comments outside strings, then parses as plain JSON.
 * Not a full JSONC parser: a trailing comma, which Wrangler itself accepts, is
 * refused here, with a message that says so.
 */
export function parseJsonc(text, what = "wrangler.jsonc") {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			const start = i;
			i++;
			while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
			i++;
			out += text.slice(start, i);
		} else if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end < 0 ? text.length : end + 2;
		} else {
			out += ch;
			i++;
		}
	}
	try {
		return JSON.parse(out);
	} catch (error) {
		throw new Error(
			`${what} could not be read (${error.message}). This accepts comments but not trailing commas; remove any comma before a closing } or ].`,
		);
	}
}

/** True for a usable environment name: it becomes part of two file names. */
export const isEnvName = (name) => typeof name === "string" && ENV_NAME.test(name);

/**
 * Returns what is wrong with the deploy values, one sentence each; empty when
 * a config may be generated from them. A value still holding example text
 * ("REPLACE...") is reported as "not set".
 */
export function checkDeploy(values) {
	if (values === null || typeof values !== "object" || Array.isArray(values)) {
		return ["the file must hold one JSON object."];
	}
	const problems = [];
	for (const key of Object.keys(values)) {
		if (!FIELDS.includes(key)) problems.push(`${key}: unknown field.`);
	}
	for (const field of FIELDS) {
		const value = values[field];
		if (typeof value !== "string" || value === "") {
			problems.push(`${field}: missing, or not a non-empty string.`);
		} else if (/REPLACE/.test(value)) {
			problems.push(`${field}: not set (still the example text).`);
		}
	}
	// Only judge the shape of values that are present and not placeholders.
	const ok = (field) => !problems.some((p) => p.startsWith(`${field}:`));
	if (ok("workerName") && !WORKER_NAME.test(values.workerName)) {
		problems.push("workerName: use lower-case letters, digits and hyphens, starting with a letter or digit.");
	}
	if (ok("mcpResource")) {
		let resource;
		try {
			resource = new URL(values.mcpResource);
		} catch {
			resource = null;
		}
		if (
			!resource ||
			resource.protocol !== "https:" ||
			resource.pathname !== "/mcp" ||
			resource.search !== "" ||
			resource.hash !== ""
		) {
			problems.push("mcpResource: must be an https address ending in /mcp, such as https://host.example/mcp.");
		}
	}
	if (ok("artifactsNamespace") && !NAME.test(values.artifactsNamespace)) {
		problems.push("artifactsNamespace: must be a namespace name (letters, digits, . _ -).");
	}
	if (ok("memoryRepo") && !NAME.test(values.memoryRepo)) {
		problems.push("memoryRepo: must be a repo name (letters, digits, . _ -).");
	}
	if (ok("kvNamespaceId") && !KV_ID.test(values.kvNamespaceId)) {
		problems.push("kvNamespaceId: must be 32 lower-case hex characters (the KV namespace's id).");
	}
	if (ok("allowedGithubId") && !GITHUB_ID.test(values.allowedGithubId)) {
		problems.push("allowedGithubId: must be digits only (a GitHub account number).");
	}
	if (ok("githubClientId") && !GITHUB_CLIENT_ID.test(values.githubClientId)) {
		problems.push("githubClientId: does not look like a GitHub OAuth app client ID.");
	}
	return problems;
}

/** The base address the scripts talk to: the origin of mcpResource. */
export const baseUrl = (values) => new URL(values.mcpResource).origin;

/**
 * The flat wrangler config for one environment, from checked values and the
 * parsed tracked wrangler.jsonc. Reproduces what a deployed Worker needs:
 * the Artifacts namespace, the MemoryStore Durable Object, the Workflow that
 * a push to the notes repo starts (events reach a Worker only through a
 * Workflow target), the KV namespace and the four vars.
 */
export function buildConfig(values, tracked) {
	for (const key of ["main", "compatibility_date", "compatibility_flags"]) {
		if (tracked?.[key] === undefined) throw new Error(`wrangler.jsonc has no ${key}.`);
	}
	const workflowName = `${values.workerName}-on-push`;
	return {
		$schema: "node_modules/wrangler/config-schema.json",
		name: values.workerName,
		main: tracked.main,
		compatibility_date: tracked.compatibility_date,
		compatibility_flags: tracked.compatibility_flags,
		workers_dev: true,
		observability: { enabled: true },
		artifacts: [{ binding: "ARTIFACTS", namespace: values.artifactsNamespace }],
		durable_objects: { bindings: [{ name: "MEMORY_STORE", class_name: "MemoryStore" }] },
		migrations: [{ tag: "v1", new_sqlite_classes: ["MemoryStore"] }],
		workflows: [{ binding: "ON_REPO_PUSHED", name: workflowName, class_name: "OnRepoPushed" }],
		triggers: {
			events: [
				{
					type: PUSH_EVENT,
					filter: { namespace: values.artifactsNamespace, repo_name: values.memoryRepo },
					targets: [{ type: "workflow", workflow_name: workflowName }],
				},
			],
		},
		kv_namespaces: [{ binding: "OAUTH_KV", id: values.kvNamespaceId }],
		vars: {
			MEMORY_REPO: values.memoryRepo,
			MCP_RESOURCE: values.mcpResource,
			ALLOWED_GITHUB_ID: values.allowedGithubId,
			GITHUB_CLIENT_ID: values.githubClientId,
		},
	};
}

/** The text of wrangler.<env>.jsonc. */
export function renderConfig(env, config) {
	return `// Generated by scripts/configure.mjs from deploy/${env}.json. Do not edit; do not commit.\n${JSON.stringify(config, null, "\t")}\n`;
}

export const deployPath = (env, root = REPO_ROOT) => `${root}deploy/${env}.json`;
export const configName = (env) => `wrangler.${env}.jsonc`;

/** Reads and checks deploy/<env>.json. Throws with every problem when it is not usable. */
export function loadDeploy(env, root = REPO_ROOT) {
	if (!isEnvName(env)) {
		throw new Error("the environment name must be lower-case letters, digits and hyphens, such as production.");
	}
	let text;
	try {
		text = readFileSync(deployPath(env, root), "utf8");
	} catch {
		throw new Error(`deploy/${env}.json could not be read. Copy deploy/example.json to it and fill it in.`);
	}
	const values = parseJsonc(text, `deploy/${env}.json`);
	const problems = checkDeploy(values);
	if (problems.length) throw new Error(`deploy/${env}.json:\n  ${problems.join("\n  ")}`);
	return values;
}

/** Writes wrangler.<env>.jsonc at the repo root; returns its file name. */
export function generateConfig(env, root = REPO_ROOT) {
	const values = loadDeploy(env, root);
	const tracked = parseJsonc(readFileSync(`${root}wrangler.jsonc`, "utf8"));
	const name = configName(env);
	writeFileSync(`${root}${name}`, renderConfig(env, buildConfig(values, tracked)));
	return name;
}
