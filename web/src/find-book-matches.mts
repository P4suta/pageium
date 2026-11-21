import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { version } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { FindSource } from "./book-find.ts";

// The packaged viewer probes CSS and schedules an animation frame at import time.
Object.defineProperties(globalThis, {
	window: {
		value: {
			requestAnimationFrame: (callback: () => void) => setImmediate(callback),
		},
	},
	document: {
		value: {
			documentElement: { style: {} },
			createElement: () => ({ style: {} }),
		},
	},
});
const { EventBus, PDFFindController, PDFLinkService } = await import(
	"pdfjs-dist/legacy/web/pdf_viewer.mjs"
);
const [path, revision] = process.argv.slice(2);
if (!path || !revision) throw new Error("Missing search database or revision");
const db = new DatabaseSync(path, { readOnly: true });
const lookup = db.prepare(
	"SELECT body FROM prepared_pages WHERE book=? AND extractor=? AND positions_only=1",
);

function openBook(id: string) {
	const bytes = lookup.get(id, revision ?? "")?.body;
	if (!(bytes instanceof Uint8Array)) return null;
	const payload: unknown = JSON.parse(gunzipSync(bytes).toString());
	if (
		typeof payload !== "object" ||
		!payload ||
		!("version" in payload) ||
		payload.version !== version ||
		!("pages" in payload) ||
		!Array.isArray(payload.pages) ||
		!payload.pages.every((p: unknown) => typeof p === "string")
	)
		return null;
	const pages: string[] = payload.pages;
	const events = new EventBus();
	const links = new (class extends PDFLinkService {
		override get pagesCount() {
			return pages.length;
		}
	})({ eventBus: events });
	const source = {
		getPage: async (number: number) => ({
			getTextContent: async () => ({
				items: [{ str: pages[number - 1] ?? "" }],
			}),
		}),
	};
	const controller = new PDFFindController({
		eventBus: events,
		linkService: links,
		delay: 0,
		updateMatchesCountOnProgress: false,
	});
	const find: { setDocument(document: FindSource): void } = controller;
	find.setDocument(source);
	let lastQuery = "";
	let lastResult: { pages: number; hits: [number, number, number][] } | null =
		null;
	return {
		id,
		async search(query: string) {
			if (query === lastQuery) return lastResult;
			const done = new Promise<void>((resolve) =>
				events.on("updatefindmatchescount", () => resolve(), { once: true }),
			);
			events.dispatch("find", {
				type: "",
				query,
				caseSensitive: false,
				entireWord: false,
				highlightAll: false,
				matchDiacritics: false,
			});
			await done;
			lastQuery = query;
			lastResult = null;
			const hits: [number, number, number][] = [];
			for (const [page, starts] of (controller.pageMatches ?? []).entries()) {
				for (const [i, start] of starts.entries()) {
					if (hits.length === 50_000) return null;
					hits.push([page + 1, start, controller.pageMatchesLength?.[page][i]]);
				}
			}
			lastResult = { pages: pages.length, hits };
			return lastResult;
		},
	};
}

let book: ReturnType<typeof openBook> = null;
for await (const line of createInterface({ input: process.stdin })) {
	try {
		const request: unknown = JSON.parse(line);
		if (
			!Array.isArray(request) ||
			request.length !== 2 ||
			typeof request[0] !== "string" ||
			typeof request[1] !== "string"
		)
			throw new Error("Invalid query");
		const [id, query] = request;
		if (book?.id !== id) book = openBook(id);
		const result = book ? await book.search(query) : null;
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch {
		process.stdout.write("null\n");
	}
}
