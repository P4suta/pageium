import { type Book, type Position, positionLabel } from "./api";
import { Covers } from "./covers";
import { element, icon } from "./dom";

interface Batch {
	host: HTMLDivElement;
	books: Book[];
	near: boolean;
	list?: HTMLUListElement;
}

export class ShelfGrid {
	readonly view = element("div", "shelf-grid");
	#batches = new Map<HTMLElement, Batch>();
	#entries = new Map<string, { book: Book; batch: Batch }>();
	#covers = new Covers();
	#recent: string | null = null;
	#width = 0;
	#enabled = false;
	#observer = new IntersectionObserver(
		(entries) => {
			if (!this.#enabled) return;
			for (const { isIntersecting, target } of entries) {
				if (!(target instanceof HTMLElement)) continue;
				const batch = this.#batches.get(target);
				if (!batch) continue;
				batch.near = isIntersecting;
				if (isIntersecting) this.#mount(batch);
				else if (!batch.host.contains(document.activeElement))
					this.#unmount(batch);
			}
		},
		{ rootMargin: "650px 0px" },
	);
	#resize = new ResizeObserver(() => this.#resizePlaceholders());

	constructor() {
		this.view.addEventListener("focusout", (event) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			const host = target.closest<HTMLElement>(".shelf-batch");
			const batch = host && this.#batches.get(host);
			if (!batch) return;
			queueMicrotask(() => {
				if (!batch.near && !batch.host.contains(document.activeElement)) {
					this.#unmount(batch);
				}
			});
		});
	}

	connect(): void {
		if (this.#enabled) return;
		this.#enabled = true;
		for (const host of this.#batches.keys()) this.#observer.observe(host);
		this.#resize.observe(this.view);
	}

	disconnect(): void {
		this.#enabled = false;
		this.#observer.disconnect();
		this.#resize.disconnect();
		for (const batch of this.#batches.values()) this.#unmount(batch);
	}

	reset(): void {
		for (const batch of this.#batches.values()) this.#unmount(batch);
		this.#observer.disconnect();
		this.#batches.clear();
		this.#entries.clear();
		this.#recent = null;
		this.view.replaceChildren();
	}

	append(books: Book[]): Book | undefined {
		const fresh = books.filter((book) => !this.#entries.has(book.id));
		if (!fresh.length) return undefined;
		const host = element("div", "shelf-batch shelf-batch--arriving");
		const batch = { host, books: fresh, near: true };
		this.#batches.set(host, batch);
		for (const book of fresh) this.#entries.set(book.id, { book, batch });
		this.view.append(host);
		this.#mount(batch);
		this.#observer.observe(host);
		return fresh[0];
	}

	setRecent(id: string | null, position?: Position | null): void {
		const previous = this.#recent;
		this.#recent = id;
		if (id) {
			const match = this.#entries.get(id);
			if (match && position !== undefined) match.book.progress = position;
		}
		for (const key of new Set([previous, id])) {
			if (!key) continue;
			const match = this.#entries.get(key);
			const card = document.getElementById(key);
			if (match && card instanceof HTMLAnchorElement)
				this.#progress(card, match.book);
		}
	}

	focusBook(id: string): boolean {
		const match = this.#entries.get(id);
		if (!match) return false;
		this.#mount(match.batch);
		const link = document.getElementById(id);
		if (!link) return false;
		link.scrollIntoView({ block: "nearest" });
		link.focus({ preventScroll: true });
		return true;
	}

	#mount(batch: Batch): void {
		if (batch.list) return;
		const list = element("ul", "books");
		for (const book of batch.books) {
			const item = element("li");
			const card = element("a", "book");
			card.id = book.id;
			card.href = `#book=${book.id}`;
			const cover = element("span", "cover");
			cover.setAttribute("aria-hidden", "true");
			cover.append(icon("book"));
			card.append(cover, element("span", "book-title", book.title));
			if (book.duplicate_title) {
				card.append(
					element("span", "book-meta", book.folder || "Books folder"),
				);
			}
			this.#progress(card, book);
			item.append(card);
			list.append(item);
			this.#covers.watch(cover, book.id);
		}
		batch.list = list;
		batch.host.style.blockSize = "";
		batch.host.replaceChildren(list);
	}

	#unmount(batch: Batch): void {
		if (!batch.list) return;
		const height = batch.host.getBoundingClientRect().height;
		if (height > 0) batch.host.style.blockSize = `${height}px`;
		for (const cover of batch.list.querySelectorAll<HTMLElement>(".cover")) {
			this.#covers.unwatch(cover);
		}
		delete batch.list;
		batch.host.replaceChildren();
		batch.host.classList.remove("shelf-batch--arriving");
	}

	#progress(card: HTMLAnchorElement, book: Book): void {
		const saved = card.querySelector(".book-resume");
		if (book.id !== this.#recent || !book.progress) {
			saved?.remove();
			return;
		}
		const label = saved ?? element("span", "book-meta book-resume");
		label.replaceChildren(
			element("span", undefined, "Continue reading"),
			element("span", undefined, positionLabel(book.progress)),
		);
		if (!saved) card.append(label);
	}

	#resizePlaceholders(): void {
		const width = this.view.clientWidth;
		if (width === this.#width || width === 0) return;
		const sample = [...this.#batches.values()].find((batch) => batch.list);
		if (!sample) return;
		this.#width = width;
		const height = sample.host.getBoundingClientRect().height;
		if (!height) return;
		for (const batch of this.#batches.values()) {
			if (!batch.list)
				batch.host.style.blockSize = `${(height * batch.books.length) / sample.books.length}px`;
		}
	}
}
