// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Run with `node --test "scripts/**/*.test.mjs"` (part of `npm test`).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	FIELDS,
	baseUrl,
	buildConfig,
	checkDeploy,
	generateConfig,
	isEnvName,
	loadDeploy,
	parseJsonc,
	renderConfig,
} from "./lib/configure.mjs";

const trackedText = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const tracked = parseJsonc(trackedText);
const example = JSON.parse(readFileSync(new URL("../deploy/example.json", import.meta.url), "utf8"));

const good = () => ({
	workerName: "notes-mcp",
	mcpResource: "https://notes-mcp.example-user.workers.dev/mcp",
	artifactsNamespace: "notes",
	memoryRepo: "notes-repo",
	kvNamespaceId: "0123456789abcdef0123456789abcdef",
	allowedGithubId: "1000001",
	githubClientId: "FakeClientId0123456789",
});

test("parseJsonc keeps // inside strings and drops comments", () => {
	const parsed = parseJsonc('{ // note\n "a": "https://x/y", /* b */ "c": "q\\"//z" }');
	assert.deepEqual(parsed, { a: "https://x/y", c: 'q"//z' });
});

test("a trailing comma is reported in words, not as a bare SyntaxError", () => {
	assert.throws(
		() => parseJsonc('{ "a": 1, }'),
		(error) => !(error instanceof SyntaxError) && /could not be read.*trailing commas/s.test(error.message),
	);
});

test("deploy/example.json lists exactly the known fields and is refused until filled in", () => {
	assert.deepEqual(Object.keys(example), FIELDS);
	const problems = checkDeploy(example);
	assert.ok(problems.some((p) => p.startsWith("kvNamespaceId: not set")));
	assert.ok(problems.some((p) => p.startsWith("allowedGithubId: not set")));
	assert.ok(problems.some((p) => p.startsWith("githubClientId: not set")));
	assert.ok(problems.some((p) => p.startsWith("mcpResource: not set")));
});

test("valid values pass", () => {
	assert.deepEqual(checkDeploy(good()), []);
});

test("every field is required", () => {
	for (const field of FIELDS) {
		const values = good();
		delete values[field];
		const problems = checkDeploy(values);
		assert.equal(problems.length, 1, `${field}: ${JSON.stringify(problems)}`);
		assert.match(problems[0], new RegExp(`^${field}: missing`));
	}
	assert.equal(checkDeploy(null).length, 1);
	assert.equal(checkDeploy([]).length, 1);
});

test("an unknown field is reported, so a misspelling is not silently ignored", () => {
	assert.deepEqual(checkDeploy({ ...good(), githubClientID: "x" }), ["githubClientID: unknown field."]);
});

test("each field's shape is checked", () => {
	const cases = [
		["workerName", "Notes MCP"],
		["mcpResource", "http://notes-mcp.example.workers.dev/mcp"],
		["mcpResource", "https://notes-mcp.example.workers.dev/"],
		["mcpResource", "https://notes-mcp.example.workers.dev/mcp?x=1"],
		["mcpResource", "not a url"],
		["artifactsNamespace", "has space"],
		["memoryRepo", "../escape"],
		["kvNamespaceId", "0123456789ABCDEF0123456789abcdef"],
		["kvNamespaceId", "0123"],
		["allowedGithubId", "12ab"],
		["allowedGithubId", "0"],
		["githubClientId", "short"],
	];
	for (const [field, value] of cases) {
		const problems = checkDeploy({ ...good(), [field]: value });
		assert.equal(problems.length, 1, `${field}=${value}: ${JSON.stringify(problems)}`);
		assert.match(problems[0], new RegExp(`^${field}:`));
	}
});

test("a custom domain is accepted for mcpResource", () => {
	const values = { ...good(), mcpResource: "https://memory.example.org/mcp" };
	assert.deepEqual(checkDeploy(values), []);
	assert.equal(baseUrl(values), "https://memory.example.org");
});

test("environment names become file names, so only plain ones pass", () => {
	for (const name of ["production", "staging", "demo-2"]) assert.equal(isEnvName(name), true);
	for (const name of ["", "../x", "A", "a/b", "-a", undefined]) assert.equal(isEnvName(name), false);
});

test("the generated config has the deployed shape and shares the tracked wrangler.jsonc's runtime settings", () => {
	const config = buildConfig(good(), tracked);
	assert.equal(config.name, "notes-mcp");
	assert.equal(config.main, tracked.main);
	assert.equal(config.compatibility_date, tracked.compatibility_date);
	assert.deepEqual(config.compatibility_flags, tracked.compatibility_flags);
	assert.equal(config.workers_dev, true);
	assert.deepEqual(config.observability, { enabled: true });
	assert.equal("env" in config, false);
	assert.deepEqual(config.artifacts, [{ binding: "ARTIFACTS", namespace: "notes" }]);
	assert.deepEqual(config.durable_objects, tracked.durable_objects);
	assert.deepEqual(config.migrations, tracked.migrations);
	assert.deepEqual(config.workflows, [
		{ binding: "ON_REPO_PUSHED", name: "notes-mcp-on-push", class_name: "OnRepoPushed" },
	]);
	assert.deepEqual(config.triggers.events, [
		{
			type: "cf.artifacts.repo.pushed",
			filter: { namespace: "notes", repo_name: "notes-repo" },
			targets: [{ type: "workflow", workflow_name: "notes-mcp-on-push" }],
		},
	]);
	assert.deepEqual(config.kv_namespaces, [{ binding: "OAUTH_KV", id: "0123456789abcdef0123456789abcdef" }]);
	assert.deepEqual(config.vars, {
		MEMORY_REPO: "notes-repo",
		MCP_RESOURCE: "https://notes-mcp.example-user.workers.dev/mcp",
		ALLOWED_GITHUB_ID: "1000001",
		GITHUB_CLIENT_ID: "FakeClientId0123456789",
	});
	// The tracked file's bindings are the same set the deployed one needs.
	assert.deepEqual(Object.keys(config.vars).sort(), Object.keys(tracked.vars).sort());
});

test("the rendered config reads back as the same object, behind a do-not-edit header", () => {
	const config = buildConfig(good(), tracked);
	const text = renderConfig("demo", config);
	assert.match(text, /^\/\/ Generated by scripts\/configure\.mjs from deploy\/demo\.json/);
	assert.deepEqual(parseJsonc(text), config);
});

test("generateConfig reads deploy/<env>.json and writes wrangler.<env>.jsonc; bad files are refused", () => {
	const root = `${mkdtempSync(join(tmpdir(), "configure-"))}/`;
	mkdirSync(`${root}deploy`);
	writeFileSync(`${root}wrangler.jsonc`, trackedText);
	writeFileSync(`${root}deploy/demo.json`, JSON.stringify(good()));
	assert.equal(generateConfig("demo", root), "wrangler.demo.jsonc");
	const written = parseJsonc(readFileSync(`${root}wrangler.demo.jsonc`, "utf8"));
	assert.equal(written.name, "notes-mcp");

	writeFileSync(`${root}deploy/bad.json`, JSON.stringify({ ...good(), kvNamespaceId: "REPLACE-ME" }));
	assert.throws(() => loadDeploy("bad", root), /kvNamespaceId: not set/);
	assert.throws(() => loadDeploy("missing", root), /could not be read.*example\.json/);
	assert.throws(() => loadDeploy("../demo", root), /environment name/);
	writeFileSync(`${root}deploy/broken.json`, '{ "workerName": }');
	assert.throws(() => loadDeploy("broken", root), /could not be read/);
});
