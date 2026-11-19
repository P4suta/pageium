import type { PDFDocumentLoadingTask } from "pdfjs-dist";
import { element } from "./dom";
import { clearCanvas, paintPage, pdfLoader } from "./pdf";

interface Thumbnail {
	id: string;
	cover: HTMLElement;
	cancellation: AbortController;
	loading?: PDFDocumentLoadingTask;
	disposal?: Promise<void>;
}

export class Covers {
	#observed = new Map<HTMLElement, Thumbnail>();
	#pending = new Set<Thumbnail>();
	#active = 0;
	#observer = new IntersectionObserver(
		(entries) => {
			for (const { isIntersecting, target } of entries) {
				if (!isIntersecting || !(target instanceof HTMLElement)) continue;
				const thumbnail = this.#observed.get(target);
				if (!thumbnail) continue;
				this.#observer.unobserve(target);
				this.#pending.add(thumbnail);
			}
			this.#pump();
		},
		{ rootMargin: "120px" },
	);

	watch(cover: HTMLElement, id: string): void {
		this.#observed.set(cover, {
			id,
			cover,
			cancellation: new AbortController(),
		});
		this.#observer.observe(cover);
	}

	unwatch(cover: HTMLElement): void {
		const job = this.#observed.get(cover);
		if (!job) return;
		this.#observer.unobserve(cover);
		this.#observed.delete(cover);
		this.#pending.delete(job);
		job.cancellation.abort();
		void this.#dispose(job);
		const canvas = cover.querySelector("canvas");
		if (canvas) clearCanvas(canvas);
	}

	#dispose(job: Thumbnail): Promise<void> | undefined {
		job.disposal ??= job.loading?.destroy().catch(() => {});
		return job.disposal;
	}

	#current(job: Thumbnail): boolean {
		return this.#observed.get(job.cover) === job && job.cover.isConnected;
	}

	#pump(): void {
		while (this.#active < 2) {
			const job = this.#pending.values().next().value;
			if (!job) return;
			this.#pending.delete(job);
			if (!this.#current(job)) continue;
			this.#active += 1;
			void this.#draw(job);
		}
	}

	async #draw(job: Thumbnail): Promise<void> {
		const canvas = element("canvas");
		const cancelled = new Promise<boolean>((resolve) => {
			job.cancellation.signal.addEventListener("abort", () => resolve(false), {
				once: true,
			});
		});
		let rendered = false;
		try {
			rendered = await Promise.race([this.#paint(job, canvas), cancelled]);
		} catch {
			if (this.#current(job)) job.cover.classList.add("cover--unavailable");
		} finally {
			if (!rendered) clearCanvas(canvas);
			await this.#dispose(job);
			delete job.loading;
			delete job.disposal;
			this.#active -= 1;
			this.#pump();
		}
	}

	async #paint(job: Thumbnail, canvas: HTMLCanvasElement): Promise<boolean> {
		const load = await pdfLoader();
		if (!this.#current(job)) return false;
		job.loading = load(job.id);
		const pdf = await job.loading.promise;
		if (!this.#current(job)) return false;
		const page = await pdf.getPage(1);
		const { cover } = job;
		if (!this.#current(job) || !cover.clientWidth) return false;
		await paintPage(page, canvas, cover.clientWidth, 110_000).promise;
		if (!this.#current(job)) return false;
		cover.replaceChildren(canvas);
		return true;
	}
}
