import { type PDFDocumentProxy, version } from "pdfjs-dist";
import {
	EventBus,
	FindState,
	PDFFindController,
	PDFLinkService,
} from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import { bookUrl } from "./api";
import type { TextMatch } from "./page-content";
import { PositionSearch } from "./position-search";

export type FindAction = "query" | "next" | "previous" | "resume";

// The PDF.js find controller reads page strings and uses the link service for page numbers.
export interface FindSource {
	getPage(number: number): Promise<{
		getTextContent(options: {
			disableNormalization: boolean;
		}): Promise<{ items: unknown[] }>;
	}>;
}

interface DocumentFind
	extends Pick<
		PDFFindController,
		"selected" | "highlightMatches" | "pageMatches" | "pageMatchesLength"
	> {
	setDocument(document: FindSource | null): void;
}

async function preparedPages(
	id: string,
	count: number,
	signal: AbortSignal,
): Promise<string[] | "positions" | null> {
	try {
		const response = await fetch(`${bookUrl(id)}/text`, {
			signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
		});
		if (response.status === 204) return "positions";
		if (
			!response.ok ||
			!response.body ||
			response.headers.get("content-type") !== "application/gzip"
		)
			return null;
		const json = new Response(
			response.body.pipeThrough(new DecompressionStream("gzip")),
		);
		const value: unknown = await json.json();
		if (
			typeof value === "object" &&
			value !== null &&
			"version" in value &&
			value.version === version &&
			"pages" in value &&
			Array.isArray(value.pages) &&
			value.pages.length === count &&
			value.pages.every((page: unknown) => typeof page === "string")
		)
			return value.pages;
	} catch {
		// Search the original PDF while its prepared text is unavailable.
	}
	return null;
}

interface MatchCount {
	matchesCount: { current: number; total: number };
}

export class BookFind {
	readonly #events = new EventBus();
	readonly #links = new PDFLinkService({ eventBus: this.#events });
	readonly #controller: DocumentFind;
	readonly #abort = new AbortController();
	readonly #source: ReturnType<typeof preparedPages>;
	readonly #positions: PositionSearch;
	#request = 0;
	#useOriginal = false;

	constructor(
		pdf: PDFDocumentProxy,
		id: string,
		currentPage: () => number,
		reveal: (page: number) => void,
		refresh: () => void,
		report: (message: string) => void,
	) {
		this.#links.setDocument(pdf);
		this.#links.setViewer({
			get currentPageNumber() {
				return currentPage();
			},
			set currentPageNumber(page: number) {
				reveal(page);
			},
		});
		this.#controller = new PDFFindController({
			eventBus: this.#events,
			linkService: this.#links,
			delay: 0,
		});
		this.#positions = new PositionSearch(
			id,
			pdf.numPages,
			currentPage,
			reveal,
			refresh,
			report,
		);
		this.#source = preparedPages(id, pdf.numPages, this.#abort.signal);
		this.#controller.setDocument({
			getPage: async (number) => {
				const source = await this.#source;
				const text = Array.isArray(source) ? source[number - 1] : undefined;
				this.#abort.signal.throwIfAborted();
				if (text === undefined) return pdf.getPage(number);
				return { getTextContent: async () => ({ items: [{ str: text }] }) };
			},
		});
		let matches = "";
		const lastPage = pdf.numPages - 1;
		const publish = () => {
			const complete = this.#controller.pageMatches?.[lastPage] !== undefined;
			report(
				complete
					? matches || "No matches"
					: matches
						? `Searching… ${matches}`
						: "Searching…",
			);
		};
		const count = ({ matchesCount: { current, total } }: MatchCount) => {
			if (total)
				matches = `${current} of ${total} ${total === 1 ? "match" : "matches"}`;
			publish();
		};
		this.#events.on("updatefindmatchescount", count);
		this.#events.on(
			"updatefindcontrolstate",
			(event: MatchCount & { state: number }) => {
				if (event.state !== FindState.PENDING) count(event);
			},
		);
		this.#events.on(
			"updatetextlayermatches",
			({ pageIndex }: { pageIndex: number }) => {
				if (pageIndex === -1 && !this.#controller.pageMatches?.length) {
					matches = "";
				}
				if (pageIndex === -1 || pageIndex === lastPage) {
					publish();
				}
				refresh();
			},
		);
	}

	async search(query: string, action: FindAction): Promise<void> {
		const request = ++this.#request;
		const source = await this.#source;
		if (request !== this.#request) return;
		const previous = action === "previous";
		const again = previous || action === "next";
		if (source === "positions" && !this.#useOriginal) {
			const found = await this.#positions.search(query, again, previous);
			if (found || request !== this.#request) return;
			this.#positions.hide();
			this.#useOriginal = true;
		}
		this.#events.dispatch("find", {
			source: this,
			type: again ? "again" : action === "resume" ? "highlightallchange" : "",
			query,
			findPrevious: previous,
			highlightAll: true,
			caseSensitive: false,
			entireWord: false,
			matchDiacritics: false,
		});
	}

	match(page: number): TextMatch | null {
		if (this.#positions.active) return this.#positions.match(page);
		const selection = this.#controller.selected;
		if (
			!this.#controller.highlightMatches ||
			!selection ||
			selection.pageIdx !== page - 1
		)
			return null;
		const { pageIdx, matchIdx } = selection;
		const start: unknown = this.#controller.pageMatches?.[pageIdx]?.[matchIdx];
		const length: unknown =
			this.#controller.pageMatchesLength?.[pageIdx]?.[matchIdx];
		return typeof start === "number" && typeof length === "number"
			? { start, length }
			: null;
	}

	hide(): void {
		this.#request++;
		this.#positions.hide();
		this.#events.dispatch("findbarclose", { source: this });
	}

	close(): void {
		this.#request++;
		this.#positions.hide();
		this.#abort.abort();
		this.#controller.setDocument(null);
		this.#links.setDocument(null);
	}
}
