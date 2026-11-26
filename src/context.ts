// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0
//
// Shapes the answer of memory_context: the profile and preferences notes in
// full, then as much of a catalog of the other notes as the size cap allows.
// Pure; the store supplies the rows.

/**
 * The design caps the answer at "about 2,000 tokens". A token is roughly four
 * characters of English text, so the cap is 8,000 characters of the JSON answer.
 */
export const CONTEXT_CAP_CHARS = 8000;

/** Folders whose notes are returned in full. */
export const PINNED_FOLDERS = ["profile/", "preferences/"];

export interface PinnedNote {
	path: string;
	title: string;
	text: string;
}

export interface CatalogEntry {
	path: string;
	title: string;
	summary: string;
}

export interface ContextAnswer {
	/** Profile and preferences notes, in full. */
	notes: PinnedNote[];
	/** Profile and preferences notes left out to stay under the cap; read them with memory_read. */
	not_included?: { path: string; title: string }[];
	/** Every other note, when the list fits. */
	catalog?: CatalogEntry[];
	/** Note counts by folder, when the list of notes does not fit. */
	folders?: { folder: string; notes: number }[];
	total_notes: number;
	hint?: string;
}

export function isPinned(path: string): boolean {
	return PINNED_FOLDERS.some((folder) => path.startsWith(folder));
}

function countBy(others: CatalogEntry[], key: (path: string) => string) {
	const counts = new Map<string, number>();
	for (const note of others) {
		const folder = key(note.path);
		counts.set(folder, (counts.get(folder) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([folder, notes]) => ({ folder, notes }));
}

const FOLDER_HINT =
	"Too many notes to list here. Use memory_search, or memory_list with a folder.";

export function buildContext(
	pinned: PinnedNote[],
	others: CatalogEntry[],
	cap: number = CONTEXT_CAP_CHARS,
): ContextAnswer {
	const total = pinned.length + others.length;
	const size = (answer: ContextAnswer) => JSON.stringify(answer).length;
	const slash = (path: string) => path.lastIndexOf("/");
	// Three forms of the catalog, richest first; the last is the smallest.
	const forms: Partial<ContextAnswer>[] = [
		{ catalog: others },
		{
			folders: countBy(others, (p) => (slash(p) < 0 ? "" : p.slice(0, slash(p)))),
			hint: FOLDER_HINT,
		},
		{
			folders: countBy(others, (p) => (slash(p) < 0 ? "" : p.slice(0, p.indexOf("/")))),
			hint: FOLDER_HINT,
		},
	];
	const smallest = forms[forms.length - 1];
	const assemble = (
		notes: PinnedNote[],
		left: { path: string; title: string }[],
		form: Partial<ContextAnswer>,
	): ContextAnswer => ({
		notes,
		...(left.length > 0 ? { not_included: left } : {}),
		...form,
		total_notes: total,
	});

	// Pinned notes go in whole, in path order, while the answer still fits with the
	// smallest catalog; one that does not fit is named so the model can read it.
	const notes: PinnedNote[] = [];
	const left: { path: string; title: string }[] = [];
	for (const [i, note] of pinned.entries()) {
		const rest = pinned.slice(i + 1).map((n) => ({ path: n.path, title: n.title }));
		if (size(assemble([...notes, note], [...left, ...rest], smallest)) <= cap) {
			notes.push(note);
		} else {
			left.push({ path: note.path, title: note.title });
		}
	}
	for (const form of forms) {
		const answer = assemble(notes, left, form);
		if (size(answer) <= cap) return answer;
	}
	return assemble(notes, left, smallest);
}
