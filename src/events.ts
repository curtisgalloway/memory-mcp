// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Receives the notes repo's push event. Cloudflare delivers an Artifacts event
// to a Worker by starting a Workflow, so this class exists only to hand the
// event to MemoryStore, which decides what to do with it.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

/**
 * How the platform retries the step when the store could not finish: three more
 * tries, 5, 10 and 20 seconds apart, so at most four tries over about 35
 * seconds. After that the instance ends as failed and the index waits for the
 * next push or write.
 */
export const REINDEX_STEP = {
	retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
	timeout: "2 minutes",
} as const;

/** The parts of a `cf.artifacts.repo.pushed` message that are used. */
export interface PushMessage {
	type?: string;
	source?: { repoName?: string };
	payload?: { ref?: string; after?: string };
}

export class OnRepoPushed extends WorkflowEntrypoint<Env, PushMessage> {
	async run(event: Readonly<WorkflowEvent<PushMessage>>, step: WorkflowStep): Promise<unknown> {
		const message = event.payload;
		return await step.do("reindex", REINDEX_STEP, async () => {
			const result = await this.env.MEMORY_STORE.getByName("main").pushed({
				type: message?.type,
				repo: message?.source?.repoName,
				ref: message?.payload?.ref,
				after: message?.payload?.after,
			});
			// Thrown, so the platform runs the step again: main may not show the push
			// yet, or a note could not be read this time.
			if (result.action === "retry") throw new Error(`reindex ${result.why}`);
			// The step's result is stored by the platform: keep it to one word.
			return result.action === "ignored" ? `ignored:${result.why}` : "reindexed";
		});
	}
}
