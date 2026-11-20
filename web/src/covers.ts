import { previewUrl } from "./api";
import { element } from "./dom";

export class Covers {
	#books = new Map<HTMLElement, string>();
	#pending = new Set<HTMLElement>();
	#loading = new Map<HTMLElement, HTMLImageElement>();
	#observer = new IntersectionObserver(
		(entries) => {
			for (const { isIntersecting, target } of entries) {
				if (!(target instanceof HTMLElement) || !this.#books.has(target))
					continue;
				if (!isIntersecting) this.#cancel(target);
				else if (!this.#loading.has(target)) this.#pending.add(target);
			}
			this.#loadVisible();
		},
		{ rootMargin: "120px" },
	);

	constructor() {
		if (document.readyState !== "complete") {
			window.addEventListener(
				"load",
				() => {
					for (const cover of this.#books.keys()) this.#observer.observe(cover);
				},
				{ once: true },
			);
		}
	}

	watch(cover: HTMLElement, id: string): void {
		this.#books.set(cover, id);
		cover.append(element("span", "cover-status", "Loading cover…"));
		if (document.readyState === "complete") this.#observer.observe(cover);
	}

	unwatch(cover: HTMLElement): void {
		this.#observer.unobserve(cover);
		this.#books.delete(cover);
		this.#cancel(cover);
	}

	#cancel(cover: HTMLElement): void {
		this.#pending.delete(cover);
		const image = this.#loading.get(cover);
		if (!image) return;
		this.#loading.delete(cover);
		image.removeAttribute("src");
		image.remove();
		queueMicrotask(() => this.#loadVisible());
	}

	#loadVisible(): void {
		for (const cover of this.#pending) {
			if (this.#loading.size >= 2) return;
			this.#pending.delete(cover);
			const id = this.#books.get(cover);
			if (!id) continue;
			const image = element("img");
			this.#loading.set(cover, image);
			image.alt = "";
			image.decoding = "async";
			image.hidden = true;
			cover.append(image);
			image.src = previewUrl(id, 1);
			void image.decode().then(
				() => this.#finish(cover, image, true),
				() => this.#finish(cover, image, false),
			);
		}
	}

	#finish(cover: HTMLElement, image: HTMLImageElement, ready: boolean): void {
		if (this.#loading.get(cover) !== image) return;
		this.#loading.delete(cover);
		this.#books.delete(cover);
		this.#observer.unobserve(cover);
		const status = cover.querySelector(".cover-status");
		if (ready) {
			cover.querySelector(".icon")?.remove();
			status?.remove();
			image.hidden = false;
		} else {
			status?.replaceChildren("Preview unavailable");
			image.remove();
		}
		this.#loadVisible();
	}
}
