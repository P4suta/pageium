import type {
	PDFDocumentLoadingTask,
	PDFDocumentProxy,
	RenderTask,
} from "pdfjs-dist";
import { type Book, type Position, positionLabel, savePosition } from "./api";
import { element, icon, message } from "./dom";
import { clearCanvas, paintPage, pdfLoader } from "./pdf";

interface PageSlot {
	number: number;
	surface: HTMLDivElement;
	canvas: HTMLCanvasElement | null;
}

interface ReadingArea {
	width: number;
	height: number;
	fitWidth: boolean;
}

type ReaderControls = "hidden" | "hover" | "shown";

const controlsRevealMargin = 24;

export class Reader {
	readonly view = element("div", "reader");
	readonly heading: HTMLHeadingElement;
	#header = element("header", "reader-header");
	#actions = element("div", "reader-actions");
	#toggle = element("button", "reader-controls-toggle");
	#fit = element("button", "reader-fit");
	#controls: ReaderControls = "shown";
	#headerHeight = 0;
	#pointerNearHeader = false;
	#fitWidth = false;
	#scroll = element("main", "reader-scroll");
	#stack = element("div", "pdf-pages");
	#label = element("span", "page-position");
	#notice = element("span", "save-notice");
	#loading: PDFDocumentLoadingTask | null = null;
	#document: PDFDocumentProxy | null = null;
	#slots: PageSlot[] = [];
	#painted = new Set<PageSlot>();
	#wanted: PageSlot[] = [];
	#paint: { slot: PageSlot; task: RenderTask } | null = null;
	#working = false;
	#resize = new ResizeObserver(() => {
		this.#headerHeight = this.#header.offsetHeight;
		this.#requestLayout();
	});
	#frame = 0;
	#closed = false;
	#area: ReadingArea | null = null;
	#defaultRatio = "";
	#active = 0;
	#scrollTop = 0;
	#seekTimer = 0;
	#pending: Position | null = null;
	#writing: Promise<void> | null = null;
	#saveTimer = 0;

	constructor(
		readonly book: Book,
		readonly saveAfter?: Promise<void>,
	) {
		const back = element("a", "library-link");
		back.href = "#";
		back.append(icon("arrow-left"), element("span", undefined, "Library"));
		this.heading = element("h1", "reader-title", book.title);
		this.heading.tabIndex = -1;
		this.#label.setAttribute("aria-live", "polite");
		this.#label.hidden = true;
		this.#notice.setAttribute("role", "status");
		this.#notice.hidden = true;
		this.#scroll.tabIndex = 0;
		this.#scroll.setAttribute("aria-label", "PDF pages");
		this.#scroll.append(
			message("Opening PDF", "Loading the document.", "scan"),
		);

		this.#actions.id = "reader-controls";
		this.#toggle.type = "button";
		this.#toggle.textContent = "Reader controls";
		this.#toggle.setAttribute("aria-controls", this.#actions.id);
		this.#toggle.hidden = true;
		this.#toggle.addEventListener("click", (event) => {
			const opening = this.#controls === "hidden";
			this.#setControls(opening ? "shown" : "hidden");
			if (opening && event.detail === 0) {
				back.focus({ preventScroll: true });
			}
		});

		this.#fit.type = "button";
		this.#fit.setAttribute("aria-pressed", "false");
		const arrows = element("span", undefined, "↔");
		arrows.setAttribute("aria-hidden", "true");
		this.#fit.append(arrows, element("span", undefined, "Fit width"));
		this.#fit.hidden = true;
		this.#fit.addEventListener("click", () => {
			this.#fitWidth = !this.#fitWidth;
			this.#fit.setAttribute("aria-pressed", String(this.#fitWidth));
			this.view.classList.toggle("reader--fit-width", this.#fitWidth);
			this.#requestLayout();
		});

		this.#scroll.addEventListener("click", () => {
			if (this.#document) {
				this.#setControls(this.#controls === "hidden" ? "shown" : "hidden");
			}
		});
		this.view.addEventListener("pointermove", this.#onPointerMove, {
			passive: true,
		});
		this.view.addEventListener("pointerleave", (event) => {
			if (event.pointerType !== "mouse") return;
			this.#pointerNearHeader = false;
			this.#hideHoveredControls();
		});
		this.#actions.append(back, this.#fit);
		this.#header.append(this.#actions, this.heading, this.#label, this.#notice);
		this.view.append(this.#header, this.#toggle, this.#scroll);
		this.#setControls("shown");
	}

	async open(): Promise<void> {
		try {
			const load = await pdfLoader();
			if (this.#closed) return;
			this.#loading = load(this.book.id);
			const pdf = await this.#loading.promise;
			if (this.#closed) return;
			const start = Math.min(pdf.numPages, this.book.progress?.page ?? 1);
			const first = await pdf.getPage(start);
			if (this.#closed) return;
			const shape = first.getViewport({ scale: 1 });
			this.#defaultRatio = String(shape.width / shape.height);
			this.#stack.style.setProperty("--page-ratio", this.#defaultRatio);
			this.#slots = Array.from(
				{ length: pdf.numPages },
				(_, index): PageSlot => {
					const surface = element("div", "pdf-page");
					const number = index + 1;
					surface.setAttribute("role", "img");
					surface.setAttribute("aria-label", `Page ${number}`);
					this.#stack.append(surface);
					return { number, surface, canvas: null };
				},
			);
			this.#scroll.replaceChildren(this.#stack);
			this.#document = pdf;
			this.view.classList.add("reader--reading");
			this.#fit.hidden = false;
			this.#toggle.hidden = false;
			this.#setControls("hidden");
			this.#active = start;
			this.#showPosition({ page: start, total: pdf.numPages });
			const resume = this.#slots[start - 1];
			if (resume) this.#scroll.scrollTop = resume.surface.offsetTop;
			this.#scrollTop = this.#scroll.scrollTop;
			this.#scroll.addEventListener("scroll", this.#onScroll, {
				passive: true,
			});
			window.addEventListener("keydown", this.#onKeyDown);
			window.addEventListener("pagehide", this.#onPageHide);
			this.#resize.observe(this.#scroll);
			this.#resize.observe(this.#header, { box: "border-box" });
			if (start !== this.book.progress?.page) {
				this.#remember({ page: start, total: pdf.numPages });
			}
			this.#requestLayout();
		} catch {
			this.#showUnavailable();
		}
	}

	#setControls(controls: ReaderControls): void {
		const visible = controls !== "hidden";
		if (!visible && this.#actions.contains(document.activeElement)) {
			this.#toggle.focus({ preventScroll: true });
		}
		this.#controls = controls;
		this.#actions.inert = !visible;
		this.#header.classList.toggle("reader-header--collapsed", !visible);
		this.#toggle.setAttribute("aria-expanded", String(visible));
	}

	#onPointerMove = (event: PointerEvent): void => {
		if (!this.#document || event.pointerType !== "mouse" || event.buttons !== 0)
			return;
		const nearHeader =
			event.clientY < this.#headerHeight + controlsRevealMargin;
		const approachedHeader = nearHeader && !this.#pointerNearHeader;
		this.#pointerNearHeader = nearHeader;
		if (approachedHeader && this.#controls === "hidden") {
			this.#setControls("hover");
		} else if (!nearHeader) {
			this.#hideHoveredControls();
		}
	};

	#hideHoveredControls(): void {
		if (
			this.#controls === "hover" &&
			!this.#actions.querySelector(":focus-visible")
		) {
			this.#setControls("hidden");
		}
	}

	#onKeyDown = (event: KeyboardEvent): void => {
		if (event.key === "Escape" && this.#controls !== "hidden") {
			event.preventDefault();
			this.#setControls("hidden");
		}
	};

	close(): { position: Position | null; saved: Promise<void> } {
		const pdf = this.#document;
		const position = pdf
			? {
					page: this.#activeIndex(this.#scroll.scrollTop) + 1,
					total: pdf.numPages,
				}
			: this.book.progress;
		if (pdf && position && position.page !== this.#active)
			this.#pending = position;
		this.#closed = true;
		this.#disconnect();
		const saved = this.#write();
		void this.#loading?.destroy().catch(() => {});
		this.#loading = null;
		this.#document = null;
		this.#slots = [];
		this.#wanted = [];
		return { position, saved };
	}

	#disconnect(): void {
		cancelAnimationFrame(this.#frame);
		window.clearTimeout(this.#seekTimer);
		this.#resize.disconnect();
		this.#scroll.removeEventListener("scroll", this.#onScroll);
		window.removeEventListener("keydown", this.#onKeyDown);
		window.removeEventListener("pagehide", this.#onPageHide);
		this.#paint?.task.cancel();
		for (const slot of this.#painted) this.#forget(slot);
	}

	#showUnavailable(): void {
		if (this.#closed) return;
		this.#disconnect();
		this.#document = null;
		this.view.classList.remove("reader--reading");
		this.#fit.hidden = true;
		this.#toggle.hidden = true;
		this.#setControls("shown");
		this.#label.hidden = true;
		this.#scroll.replaceChildren(
			message("PDF unavailable", "The PDF could not be opened.", "alert"),
		);
	}

	#onScroll = (): void => {
		const top = this.#scroll.scrollTop;
		const area = this.#area;
		if (
			this.#controls === "shown" &&
			top !== this.#scrollTop &&
			area?.fitWidth === this.#fitWidth &&
			area.width === this.#stack.clientWidth &&
			area.height === this.#scroll.clientHeight &&
			!this.#actions.querySelector(":focus-visible")
		) {
			this.#setControls("hidden");
		}
		if (
			this.#seekTimer ||
			Math.abs(top - this.#scrollTop) > this.#scroll.clientHeight
		) {
			window.clearTimeout(this.#seekTimer);
			this.#seekTimer = window.setTimeout(() => {
				this.#seekTimer = 0;
				this.#requestLayout();
			}, 110);
		}
		this.#scrollTop = top;
		this.#requestLayout();
	};
	#onPageHide = (): void => {
		void this.#write();
	};

	#requestLayout(): void {
		if (this.#closed || this.#frame || !this.#document) return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = 0;
			this.#layout();
		});
	}

	#layout(): void {
		if (!this.#document) return;
		const width = this.#stack.clientWidth;
		const height = this.#scroll.clientHeight;
		if (width === 0 || height === 0) return;
		const previous = this.#area;
		if (
			!previous ||
			width !== previous.width ||
			height !== previous.height ||
			this.#fitWidth !== previous.fitWidth
		) {
			const anchor = previous && this.#slots[this.#active - 1];
			if (anchor) {
				this.#scroll.scrollTop = anchor.surface.offsetTop;
				this.#scrollTop = this.#scroll.scrollTop;
			}
			this.#paint?.task.cancel();
			for (const slot of this.#painted) this.#forget(slot);
			this.#area = { width, height, fitWidth: this.#fitWidth };
		}
		const top = this.#scroll.scrollTop;
		const active = this.#activeIndex(top);
		const visibleEnd = this.#indexAt(top + height);
		const indices = new Set([
			active,
			this.#indexAt(top),
			active + 1,
			active - 1,
			Math.min(active + 2, visibleEnd + 1),
			Math.min(active + 3, visibleEnd + 1),
		]);
		this.#wanted =
			this.#slots.length > 0
				? Array.from(indices).flatMap((index) => this.#slots[index] ?? [])
				: [];
		for (const slot of this.#painted) {
			if (!this.#wanted.includes(slot)) this.#forget(slot);
		}
		if (
			this.#paint &&
			(this.#seekTimer || !this.#wanted.includes(this.#paint.slot))
		)
			this.#paint.task.cancel();
		const page = active + 1;
		if (page !== this.#active) {
			this.#active = page;
			const position = { page, total: this.#document.numPages };
			this.#showPosition(position);
			this.#remember(position);
		}
		if (!this.#seekTimer && !this.#working) void this.#renderNext();
	}

	#activeIndex(top: number): number {
		return this.#atEnd()
			? this.#slots.length - 1
			: this.#indexAt(top + Math.min(this.#scroll.clientHeight / 4, 120));
	}

	#indexAt(offset: number): number {
		let left = 0;
		let right = this.#slots.length - 1;
		while (left < right) {
			const middle = Math.floor((left + right + 1) / 2);
			const slot = this.#slots[middle];
			if (slot && slot.surface.offsetTop <= offset) {
				left = middle;
			} else {
				right = middle - 1;
			}
		}
		return left;
	}

	#atEnd(): boolean {
		const { scrollTop, scrollHeight, clientHeight } = this.#scroll;
		return scrollTop > 0 && scrollHeight - clientHeight - scrollTop <= 1;
	}

	async #renderNext(): Promise<void> {
		const slot = this.#wanted.find(
			(candidate) => !this.#painted.has(candidate),
		);
		const pdf = this.#document;
		const area = this.#area;
		if (this.#working || !slot || !pdf || !area || this.#closed) return;
		this.#working = true;
		const canvas = element("canvas");
		let rendered = false;
		try {
			const page = await pdf.getPage(slot.number);
			if (!this.#wants(slot, area)) return;
			const shape = page.getViewport({ scale: 1 });
			this.#sizePage(slot, String(shape.width / shape.height));
			const width = slot.surface.clientWidth;
			if (!width) return;
			const task = paintPage(page, canvas, width, 2_000_000);
			this.#paint = { slot, task };
			await task.promise;
			if (!this.#wants(slot, area)) return;
			page.cleanup();
			slot.surface.replaceChildren(canvas);
			slot.canvas = canvas;
			this.#painted.add(slot);
			rendered = true;
		} catch (error) {
			const cancelled =
				error instanceof Error && error.name === "RenderingCancelledException";
			if (!cancelled && this.#wants(slot, area)) this.#showUnavailable();
		} finally {
			if (!rendered) clearCanvas(canvas);
			this.#paint = null;
			this.#working = false;
			this.#requestLayout();
		}
	}

	#sizePage(slot: PageSlot, ratio: string): void {
		if (
			ratio === this.#defaultRatio ||
			slot.surface.style.getPropertyValue("--page-ratio")
		)
			return;
		const anchor = this.#slots[this.#indexAt(this.#scroll.scrollTop)];
		const before = anchor?.surface.offsetTop ?? 0;
		const atEnd = this.#atEnd();
		slot.surface.style.setProperty("--page-ratio", ratio);
		if (atEnd) {
			this.#scroll.scrollTop = this.#scroll.scrollHeight;
		} else if (anchor) {
			this.#scroll.scrollTop += anchor.surface.offsetTop - before;
		}
		this.#scrollTop = this.#scroll.scrollTop;
	}

	#wants(slot: PageSlot, area: ReadingArea): boolean {
		return (
			!this.#closed &&
			!this.#seekTimer &&
			this.#document !== null &&
			area === this.#area &&
			area.fitWidth === this.#fitWidth &&
			this.#wanted.includes(slot)
		);
	}

	#forget(slot: PageSlot): void {
		if (slot.canvas) clearCanvas(slot.canvas);
		slot.canvas = null;
		this.#painted.delete(slot);
	}

	#showPosition(position: Position): void {
		this.#label.hidden = false;
		this.#label.textContent = positionLabel(position);
	}

	#remember(position: Position): void {
		this.#pending = position;
		window.clearTimeout(this.#saveTimer);
		this.#saveTimer = window.setTimeout(() => {
			void this.#write();
		}, 350);
	}

	#write(): Promise<void> {
		window.clearTimeout(this.#saveTimer);
		if (this.#writing) return this.#writing;
		if (!this.#pending) return this.saveAfter ?? Promise.resolve();
		this.#writing = this.#flushPositions().finally(() => {
			this.#writing = null;
		});
		return this.#writing;
	}

	async #flushPositions(): Promise<void> {
		await this.saveAfter;
		while (this.#pending) {
			const pending = this.#pending;
			this.#pending = null;
			try {
				await savePosition(this.book.id, pending);
				this.#notice.hidden = true;
			} catch {
				this.#notice.textContent = "Reading position could not be saved.";
				this.#notice.hidden = false;
				if (!this.#closed && this.#document) this.#setControls("shown");
			}
		}
	}
}
