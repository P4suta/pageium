import {
	type Book,
	type FolderLink,
	type Position,
	positionLabel,
} from "./api";
import { Covers } from "./covers";
import { element, icon } from "./dom";
import { type ShelfLocation, shelfHref } from "./location";

type Entry = Book | FolderLink;

interface Batch {
	host: HTMLDivElement;
	entries: Entry[];
	near: boolean;
	mounted: boolean;
}

export class ShelfGrid {
	readonly view = element("div", "shelf-grid");
	#batches = new Map<HTMLElement, Batch>();
	#entries = new Map<string, { entry: Entry; batch: Batch }>();
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

	constructor(private readonly location: () => ShelfLocation) {
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

	append(entries: Entry[]): Entry | undefined {
		const fresh = entries.filter((entry) => !this.#entries.has(entry.id));
		if (!fresh.length) return undefined;
		const host = element("div", "shelf-batch shelf-batch--arriving");
		const batch = { host, entries: fresh, near: true, mounted: false };
		this.#batches.set(host, batch);
		for (const entry of fresh) this.#entries.set(entry.id, { entry, batch });
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
			if (match && "title" in match.entry && position !== undefined)
				match.entry.progress = position;
		}
		for (const key of new Set([previous, id])) {
			if (!key) continue;
			const match = this.#entries.get(key);
			const card = document.getElementById(key);
			if (match && "title" in match.entry && card instanceof HTMLAnchorElement)
				this.#progress(card, match.entry);
		}
	}

	focusEntry(id: string): boolean {
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
		if (batch.mounted) return;
		const location = this.location();
		const folders = element("ul", "folders");
		folders.setAttribute("aria-label", "Folders");
		const list = element("ul", "books");
		for (const book of batch.entries) {
			const item = element("li");
			if ("name" in book) {
				const link = element("a", "folder-link");
				link.id = book.id;
				link.href = shelfHref({ folder: book.id, query: "" });
				link.append(icon("folder"), element("span", undefined, book.name));
				item.append(link);
				folders.append(item);
				continue;
			}
			const card = element("a", "book");
			card.id = book.id;
			card.href = shelfHref(location, book.id);
			const cover = element("span", "cover");
			cover.setAttribute("aria-hidden", "true");
			cover.append(icon("book"));
			card.append(cover, element("span", "book-title", book.title));
			if (
				location.query.trim() &&
				(book.folder_id !== location.folder || book.duplicate_title)
			) {
				card.append(
					element("span", "book-meta", book.folder || "Books folder"),
				);
			}
			this.#progress(card, book);
			item.append(card);
			list.append(item);
			this.#covers.watch(cover, book.id);
		}
		batch.mounted = true;
		batch.host.style.blockSize = "";
		batch.host.replaceChildren();
		if (folders.childElementCount) batch.host.append(folders);
		if (list.childElementCount) batch.host.append(list);
	}

	#unmount(batch: Batch): void {
		if (!batch.mounted) return;
		const height = batch.host.getBoundingClientRect().height;
		if (height > 0) batch.host.style.blockSize = `${height}px`;
		for (const cover of batch.host.querySelectorAll<HTMLElement>(".cover")) {
			this.#covers.unwatch(cover);
		}
		batch.mounted = false;
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
		const onlyBooks = (batch: Batch) =>
			batch.entries.every((entry) => "title" in entry);
		const sample = [...this.#batches.values()].find(
			(batch) => batch.mounted && onlyBooks(batch),
		);
		if (!sample) return;
		this.#width = width;
		const height = sample.host.getBoundingClientRect().height;
		if (!height) return;
		for (const batch of this.#batches.values()) {
			if (!batch.mounted && onlyBooks(batch))
				batch.host.style.blockSize = `${(height * batch.entries.length) / sample.entries.length}px`;
		}
	}
}
