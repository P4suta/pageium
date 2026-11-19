import { getLibrary, type Library, type Position } from "./api";
import { element, icon, message } from "./dom";
import { ShelfGrid } from "./shelf-grid";

interface Browse {
	revision: string;
	pin: string;
	page: number;
	pages: number;
}

export class Shelf {
	readonly view = element("main", "library");
	#heading = element("h1", undefined, "Library");
	#tools = element("div", "shelf-tools");
	#input = element("input");
	#query = "";
	#total = element("p", "shelf-total");
	#status = element("div");
	#grid = new ShelfGrid();
	#tail = element("div", "shelf-tail");
	#more = element("button", "shelf-more");
	#moreLabel = element("span");
	#browse: Browse | null = null;
	#request: AbortController | null = null;
	#timer = 0;
	#active = false;
	#failed = false;
	#returnBook: string | undefined;
	#recent: { id: string; position: Position } | undefined;
	#observer = new IntersectionObserver(
		(entries) => {
			if (
				entries.some((entry) => entry.isIntersecting) &&
				document.activeElement !== this.#more
			) {
				void this.#next();
			}
		},
		{ rootMargin: "500px 0px" },
	);

	constructor() {
		this.#heading.tabIndex = -1;
		const header = element("header", "library-heading");
		const brand = element("p", "brand");
		brand.append(icon("book"), element("span", undefined, "Pageium"));
		header.append(brand, this.#heading);

		const field = element("label", "shelf-search");
		this.#input.type = "search";
		this.#input.placeholder = "Search books by title or folder";
		this.#input.setAttribute("aria-label", "Search books");
		this.#input.addEventListener("input", (event) => {
			if (!(event instanceof InputEvent) || !event.isComposing) this.#search();
		});
		this.#input.addEventListener("compositionend", () => this.#search());
		field.append(icon("search"), this.#input);
		this.#total.setAttribute("role", "status");
		this.#tools.hidden = true;
		this.#tools.append(field, this.#total);

		this.#more.type = "button";
		this.#more.append(icon("arrow-left"), this.#moreLabel);
		this.#more.addEventListener("click", () => {
			void this.#next(true);
		});
		this.#tail.hidden = true;
		this.#tail.append(this.#more);
		this.view.append(
			header,
			this.#tools,
			this.#status,
			this.#grid.view,
			this.#tail,
		);
	}

	async resume(book?: string, scroll = 0): Promise<void> {
		this.#active = true;
		this.#grid.connect();
		if (this.#browse) {
			if (book) {
				window.scrollTo(0, scroll);
				this.#focusBook(book);
			}
			this.#observeMore();
			this.#schedule(10_000);
		} else {
			this.#returnBook = book;
			await this.#load(1);
		}
	}

	pause(): void {
		this.#active = false;
		this.#cancel();
		this.#observer.disconnect();
		this.#grid.disconnect();
	}

	remember(id: string, position: Position, saved: Promise<void>): void {
		const recent = { id, position };
		this.#recent = recent;
		this.#grid.setRecent(id, position);
		void saved.then(() => {
			if (this.#recent === recent) this.#recent = undefined;
		});
	}

	#cancel(): void {
		this.#request?.abort();
		this.#request = null;
		this.#grid.view.removeAttribute("aria-busy");
		window.clearTimeout(this.#timer);
	}

	#search(): void {
		if (!this.#active || this.#query === this.#input.value) return;
		this.#query = this.#input.value;
		this.#cancel();
		this.#discard();
		this.#status.replaceChildren();
		window.scrollTo(0, 0);
		this.#schedule(170);
	}

	#discard(): void {
		this.#observer.disconnect();
		this.#browse = null;
		this.#failed = false;
		this.#tail.hidden = true;
		this.#grid.reset();
	}

	#schedule(delay: number): void {
		this.#timer = window.setTimeout(() => void this.#load(1), delay);
	}

	async #next(manual = false): Promise<void> {
		const browse = this.#browse;
		if (!browse || browse.page >= browse.pages || (this.#failed && !manual))
			return;
		await this.#load(browse.page + 1, manual);
	}

	async #load(page: number, manual = false): Promise<void> {
		if (!this.#active || this.#request) return;
		window.clearTimeout(this.#timer);
		const request = new AbortController();
		this.#request = request;
		this.#grid.view.setAttribute("aria-busy", "true");
		const pin = this.#browse?.pin;
		let result: Library;
		try {
			result = await getLibrary(page, this.#query, request.signal, pin);
		} catch {
			result = { status: "unavailable" };
		}
		if (request.signal.aborted) return;
		this.#request = null;
		this.#grid.view.removeAttribute("aria-busy");

		if (result.status !== "ready") {
			if (page > 1) this.#failed = true;
			if (!this.#browse) this.#showWaiting(result.status);
		} else if (page > 1 && result.revision !== this.#browse?.revision) {
			this.#discard();
			window.scrollTo(0, 0);
			await this.#load(1);
			return;
		} else {
			if (page > 1) this.#failed = false;
			this.#accept(result, pin, manual);
		}

		this.#observeMore();
		this.#schedule(result.status === "scanning" ? 550 : 10_000);
	}

	#accept(
		library: Extract<Library, { status: "ready" }>,
		pin: string | undefined,
		manual: boolean,
	): void {
		const fresh = library.revision !== this.#browse?.revision;
		const append = fresh || library.page > (this.#browse?.page ?? 0);
		if (fresh) {
			if (this.#browse) window.scrollTo(0, 0);
			this.#discard();
		}
		this.#browse = {
			revision: library.revision,
			pin: pin ?? library.recent ?? "",
			page: Math.max(library.page, this.#browse?.page ?? 0),
			pages: library.pages,
		};
		const total =
			library.total === 1
				? "1 book"
				: `${library.total.toLocaleString()} books`;
		if (this.#total.textContent !== total) this.#total.textContent = total;
		const query = this.#query.trim();
		this.#tools.hidden = library.total === 0 && !query;
		if (fresh || append) {
			this.#status.replaceChildren();
			if (!library.total) {
				this.#status.append(
					query
						? message(
								"No matching books",
								"Try another title or folder.",
								"search",
							)
						: message("No books yet", "Save a PDF to your books folder."),
				);
			}
		}
		const id = this.#recent?.id ?? library.recent;
		const position =
			this.#recent?.position ??
			library.books.find((book) => book.id === id)?.progress;
		this.#grid.setRecent(id, position);
		const first = append ? this.#grid.append(library.books) : undefined;
		if (this.#recent)
			this.#grid.setRecent(this.#recent.id, this.#recent.position);
		const target = this.#returnBook ?? (manual ? first?.id : undefined);
		this.#returnBook = undefined;
		if (target) this.#focusBook(target);
	}

	#focusBook(id: string): void {
		if (this.#grid.focusBook(id)) return;
		const fallback = this.#tools.hidden ? this.#heading : this.#input;
		fallback.focus();
	}

	#showWaiting(status: "scanning" | "unavailable"): void {
		const waiting = status === "scanning";
		this.#status.replaceChildren(
			waiting
				? message(
						"Scanning for PDFs",
						"Books will appear as they are found.",
						"scan",
					)
				: message(
						"Library unavailable",
						"The books folder could not be reached.",
						"alert",
					),
		);
	}

	#observeMore(): void {
		this.#observer.disconnect();
		const browse = this.#browse;
		this.#tail.hidden = !browse || browse.page >= browse.pages;
		this.#moreLabel.textContent = this.#failed
			? "Retry loading books"
			: "Load more books";
		if (!this.#tail.hidden && !this.#failed) this.#observer.observe(this.#tail);
	}
}
