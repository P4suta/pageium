import { getBook, isBookId, type Position } from "./api";
import { element, icon, message } from "./dom";
import { Reader } from "./reader";
import { Shelf } from "./shelf";
import "./style.css";

class App {
	#reader: Reader | null = null;
	#shelf = new Shelf();
	#saving = new Map<
		string,
		{ position: Position | null; saved: Promise<void> }
	>();
	#request: AbortController | null = null;
	#poll = 0;
	#lastBook: string | null = null;
	#returnScroll = 0;

	constructor(readonly root: HTMLElement) {
		window.addEventListener("hashchange", () => {
			void this.navigate();
		});
	}

	async navigate(): Promise<void> {
		this.#request?.abort();
		window.clearTimeout(this.#poll);
		const request = new AbortController();
		this.#request = request;
		const previous = this.#reader;
		this.#reader = null;
		if (previous) {
			const id = previous.book.id;
			const closing = previous.close();
			this.#saving.set(id, closing);
			if (closing.position)
				this.#shelf.remember(id, closing.position, closing.saved);
			void closing.saved.then(() => {
				if (this.#saving.get(id) === closing) this.#saving.delete(id);
			});
		}
		if (request.signal.aborted) return;
		const key = window.location.hash.slice("#book=".length);
		if (window.location.hash.startsWith("#book=") && isBookId(key)) {
			if (this.#shelf.view.isConnected) this.#returnScroll = window.scrollY;
			this.#shelf.pause();
			this.#lastBook = key;
			this.#showReaderMessage("Opening PDF", "Loading the document.", "scan");
			await this.#loadBook(key, request.signal);
		} else {
			const book = this.#lastBook ?? undefined;
			this.#lastBook = null;
			document.title = "Library · Pageium";
			this.root.replaceChildren(this.#shelf.view);
			await this.#shelf.resume(book, this.#returnScroll);
		}
	}

	async #loadBook(id: string, signal: AbortSignal): Promise<void> {
		try {
			const opening = this.#saving.get(id);
			const lookup = await getBook(id, signal);
			if (signal.aborted) return;
			if (lookup.status === "scanning") {
				this.#poll = window.setTimeout(() => {
					void this.#loadBook(id, signal);
				}, 550);
				return;
			}
			if (lookup.status === "unavailable") {
				this.#showMissingBook();
				return;
			}
			const pending = this.#saving.get(id) ?? opening;
			const book = {
				...lookup.book,
				progress: pending?.position ?? lookup.book.progress,
			};
			const reader = new Reader(book, pending?.saved);
			this.#reader = reader;
			document.title = `${book.title} · Pageium`;
			this.root.replaceChildren(reader.view);
			reader.heading.focus({ preventScroll: true });
			await reader.open();
		} catch {
			if (!signal.aborted) this.#showMissingBook();
		}
	}

	#showMissingBook(): void {
		this.#showReaderMessage(
			"PDF unavailable",
			"The PDF could not be opened.",
			"alert",
		);
	}

	#showReaderMessage(
		title: string,
		detail: string,
		symbol: "scan" | "alert",
	): void {
		const frame = element("div", "reader");
		const header = element("header", "reader-header");
		const back = element("a", "library-link");
		back.href = "#";
		back.append(icon("arrow-left"), element("span", undefined, "Library"));
		header.append(back);
		const main = element("main", "reader-scroll");
		main.append(message(title, detail, symbol));
		frame.append(header, main);
		this.root.replaceChildren(frame);
	}
}

const root = document.getElementById("app");
if (root) void new App(root).navigate();
