import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { BookFind, FindAction } from "./book-find";
import { element, icon } from "./dom";
import { PageContent } from "./page-content";
import {
	bookLink,
	type Destination,
	type PagePoint,
	resolveDestination,
} from "./pdf-destinations";
import "./book-navigation.css";

type Outline = NonNullable<Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>>;
interface VisiblePage {
	number: number;
	surface: HTMLElement;
	page: PDFPageProxy | null;
}

function action(label: string, glyph: HTMLElement | string, showLabel = false) {
	const button = element("button", "book-action");
	button.type = "button";
	button.setAttribute("aria-label", label);
	button.title = label;
	const symbol =
		typeof glyph === "string" ? element("span", undefined, glyph) : glyph;
	symbol.setAttribute("aria-hidden", "true");
	button.append(symbol);
	if (showLabel) button.append(element("span", undefined, label));
	return button;
}

export class BookNavigation {
	readonly tools = element("div", "book-tools");
	readonly panels = element("div", "book-panels");
	readonly #findButton = action("Find in book", icon("search"), true);
	readonly #contentsButton = action("Contents", icon("book"), true);
	readonly #findPanel = element("search", "book-find");
	readonly #input = element("input");
	readonly #previous = action("Previous match", "↑");
	readonly #next = action("Next match", "↓");
	readonly #status = element("span");
	readonly #pageNotice = element("span");
	readonly #contents = element("nav", "book-contents");
	readonly #outline = element("div", "book-outline");
	readonly #linkNotice = element("div", "book-link-notice");
	readonly #pages = new Map<number, PageContent>();
	#find: BookFind | null = null;
	#query = "";
	#composing = false;
	#searchRequest = 0;
	#destinationRequest = 0;
	#revealPage = 0;
	#outlineLoaded = false;
	#closed = false;

	constructor(
		readonly pdf: PDFDocumentProxy,
		readonly bookId: string,
		readonly currentPage: () => number,
		readonly goTo: (
			number: number,
			point?: PagePoint,
			page?: PDFPageProxy,
		) => void,
		readonly hideHeader: () => void,
		readonly focusPage: () => void,
	) {
		this.#input.type = "search";
		this.#input.setAttribute("aria-label", "Find in book");
		this.#input.placeholder = "Find in book";
		this.#input.autocomplete = "off";
		const field = element("label", "book-query");
		field.append(icon("search"), this.#input);
		this.#input.addEventListener("compositionstart", () => {
			this.#composing = true;
		});
		this.#input.addEventListener("compositionend", () => {
			this.#composing = false;
			void this.#search();
		});
		this.#input.addEventListener("input", (event) => {
			if (!this.#composing && !(event as InputEvent).isComposing)
				void this.#search();
		});
		this.#input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.isComposing && !this.#composing) {
				event.preventDefault();
				void this.#search(event.shiftKey ? "previous" : "next");
			}
		});
		this.#previous.disabled = this.#next.disabled = true;
		this.#previous.addEventListener(
			"click",
			() => void this.#search("previous"),
		);
		this.#next.addEventListener("click", () => void this.#search("next"));
		this.#findPanel.id = "book-find";
		this.#findPanel.setAttribute("aria-label", "Find in book");
		this.#status.setAttribute("role", "status");
		this.#pageNotice.setAttribute("role", "status");
		this.#findPanel.append(
			field,
			this.#previous,
			this.#next,
			this.#closeButton(),
			this.#status,
			this.#pageNotice,
		);
		this.#contents.id = "book-contents";
		this.#contents.setAttribute("aria-label", "Contents");
		const heading = element("h2", undefined, "Contents");
		this.#contents.tabIndex = -1;
		this.#contents.append(heading, this.#closeButton(), this.#outline);
		this.#linkNotice.setAttribute("role", "status");
		for (const [button, panel] of [
			[this.#findButton, this.#findPanel],
			[this.#contentsButton, this.#contents],
		] as const) {
			button.setAttribute("aria-controls", panel.id);
			button.setAttribute("aria-expanded", "false");
			panel.hidden = true;
			button.addEventListener("click", () => {
				if (panel.hidden) this.#open(panel);
				else this.#dismiss();
			});
		}
		this.tools.append(this.#findButton, this.#contentsButton);
		this.panels.append(this.#findPanel, this.#contents, this.#linkNotice);
	}

	#closeButton(): HTMLButtonElement {
		const button = action("Close", "×");
		button.addEventListener("click", () => this.#dismiss());
		return button;
	}

	#open(panel: HTMLElement): void {
		const opening = panel.hidden;
		if (opening) this.#hide();
		this.hideHeader();
		panel.hidden = false;
		if (panel === this.#findPanel) {
			this.#findButton.setAttribute("aria-expanded", "true");
			this.#input.focus({ preventScroll: true });
			this.#input.select();
			if (opening && this.#query) void this.#search("resume");
			this.#refresh();
		} else {
			this.#contentsButton.setAttribute("aria-expanded", "true");
			this.#contents.focus({ preventScroll: true });
			void this.#loadOutline();
		}
	}

	#hide(): void {
		if (!this.#findPanel.hidden) this.#find?.hide();
		this.#searchRequest++;
		this.#destinationRequest++;
		this.#revealPage = 0;
		this.#composing = false;
		this.#linkNotice.textContent = "";
		this.#contents.hidden = this.#findPanel.hidden = true;
		this.#contentsButton.setAttribute("aria-expanded", "false");
		this.#findButton.setAttribute("aria-expanded", "false");
		this.#refresh();
	}

	#dismiss(): void {
		this.#hide();
		this.hideHeader();
		this.focusPage();
	}

	handleKey(event: KeyboardEvent): boolean {
		if (event.isComposing || this.#composing) return false;
		if (
			(event.ctrlKey || event.metaKey) &&
			!event.altKey &&
			!event.shiftKey &&
			event.key.toLowerCase() === "f"
		) {
			event.preventDefault();
			this.#open(this.#findPanel);
			return true;
		}
		if (
			event.key === "Escape" &&
			(!this.#findPanel.hidden ||
				!this.#contents.hidden ||
				this.#linkNotice.textContent)
		) {
			event.preventDefault();
			this.#dismiss();
			return true;
		}
		return false;
	}

	async #search(action: FindAction = "query"): Promise<void> {
		const query = this.#input.value;
		if (action === "query" && this.#query === query) return;
		const request = ++this.#searchRequest;
		this.#query = query;
		this.#revealPage = 0;
		this.#previous.disabled = this.#next.disabled = !query;
		if (!query) {
			this.#find?.hide();
			this.#status.textContent = "";
			this.#refresh();
			return;
		}
		if (action !== "resume") this.#status.textContent = "Searching…";
		try {
			if (!this.#find) {
				const { BookFind } = await import("./book-find");
				if (this.#searchRequest !== request) return;
				this.#find = new BookFind(
					this.pdf,
					this.bookId,
					this.currentPage,
					(number) => {
						if (this.#findPanel.hidden || !this.#query) return;
						this.#revealPage = number;
						if (!this.#pages.has(number)) this.goTo(number);
					},
					() => this.#refresh(),
					(message) => {
						if (
							!this.#findPanel.hidden &&
							this.#query &&
							this.#status.textContent !== message
						)
							this.#status.textContent = message;
					},
				);
			}
			await this.#find.search(query, action);
		} catch {
			if (request === this.#searchRequest)
				this.#status.textContent = "Search unavailable";
		}
	}

	showPages(visible: VisiblePage[]): void {
		for (const [number, content] of this.#pages) {
			if (visible.some((slot) => slot.number === number)) continue;
			content.remove();
			this.#pages.delete(number);
		}
		for (const { page, number, surface } of visible) {
			const content = this.#pages.get(number);
			if (content) content.resize();
			else if (page)
				this.#pages.set(
					number,
					new PageContent(surface, page, this.#follow, () => this.#refresh()),
				);
		}
		this.#refresh();
	}

	#refresh(): void {
		const searching = !this.#findPanel.hidden && !!this.#query;
		for (const [number, content] of this.#pages) {
			const marker = content.highlight(
				searching ? (this.#find?.match(number) ?? null) : null,
			);
			if (!marker || this.#revealPage !== number) continue;
			this.#revealPage = 0;
			const paper = content.surface.getBoundingClientRect();
			const match = marker.getBoundingClientRect();
			this.goTo(number, {
				x: (match.left - paper.left) / paper.width,
				y: (match.top - paper.top) / paper.height,
			});
		}
		const notice = this.#pages.get(this.currentPage())?.textNotice ?? "";
		if (this.#pageNotice.textContent !== notice)
			this.#pageNotice.textContent = notice;
	}

	async #loadOutline(): Promise<void> {
		if (this.#outlineLoaded) return;
		this.#outlineLoaded = true;
		this.#outline.textContent = "Loading contents…";
		try {
			const items = await this.pdf.getOutline();
			if (this.#closed) return;
			if (items?.length)
				this.#outline.replaceChildren(this.#outlineList(items));
			else this.#outline.textContent = "No contents in this book";
		} catch {
			if (this.#closed) return;
			this.#outlineLoaded = false;
			this.#outline.textContent = "Contents could not be loaded";
		}
	}

	#outlineList(items: Outline): HTMLUListElement {
		const list = element("ul");
		for (const item of items) {
			const row = element("li");
			const title = item.title || "Untitled section";
			row.append(bookLink(item, title, this.#follow) ?? title);
			if (item.items.length) row.append(this.#outlineList(item.items));
			list.append(row);
		}
		return list;
	}

	#follow = async (dest: Destination): Promise<void> => {
		const request = ++this.#destinationRequest;
		try {
			const { page, point } = await resolveDestination(this.pdf, dest);
			if (request !== this.#destinationRequest) return;
			this.#dismiss();
			this.goTo(page.pageNumber, point, page);
		} catch {
			if (request === this.#destinationRequest)
				this.#linkNotice.textContent = "Link destination unavailable";
		}
	};

	close(): void {
		this.#closed = true;
		this.#hide();
		this.#find?.close();
		this.#find = null;
		for (const content of this.#pages.values()) content.remove();
		this.#pages.clear();
		this.tools.remove();
		this.panels.remove();
	}
}
