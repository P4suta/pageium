import type {
	PDFDocumentLoadingTask,
	PDFDocumentProxy,
	PDFPageProxy,
	RenderTask,
} from "pdfjs-dist";
import {
	type Book,
	type Position,
	positionLabel,
	previewUrl,
	savePosition,
} from "./api";
import { element, message } from "./dom";
import { backToShelf, type ShelfLocation } from "./location";
import {
	clearCanvas,
	coversView,
	pageBacking,
	pageRaster,
	paintPage,
	pdfLoader,
	type Raster,
	visibleReadingArea,
} from "./pdf";
import { PaperZoom } from "./zoom";

interface PageLayer {
	canvas: HTMLCanvasElement;
	raster: Raster;
}

interface PageSlot {
	number: number;
	surface: HTMLDivElement;
	base: PageLayer | null;
	detail: PageLayer | null;
	preview: HTMLImageElement | null;
	page: PDFPageProxy | null;
	failed: { raster: Raster; adjacent: boolean } | null;
}

interface PagePaint {
	slot: PageSlot;
	task: RenderTask | null;
	detail: boolean;
}

function pageSlot(number: number): PageSlot {
	const surface = element("div", "pdf-page");
	surface.setAttribute("role", "img");
	surface.setAttribute("aria-label", `Page ${number}`);
	surface.dataset.status = `Loading page ${number}…`;
	return {
		number,
		surface,
		base: null,
		detail: null,
		preview: null,
		page: null,
		failed: null,
	};
}

interface ReadingArea {
	width: number;
	height: number;
	fitWidth: boolean;
}

type ReaderControls = "hidden" | "hover" | "shown";

const controlsRevealMargin = 24;
const readingDwellMs = 400;

export class Reader {
	readonly view = element("div", "reader");
	readonly heading: HTMLHeadingElement;
	#header = element("header", "reader-header");
	#actions = element("div", "reader-actions");
	#toggle = element("button", "reader-controls-toggle");
	#fit = element("button", "reader-fit");
	#tools = element("div", "reader-zoom");
	#zoomIn = element("button", "reader-fit", "+");
	#zoomOut = element("button", "reader-fit", "−");
	#magnification = element("output", "reader-magnification", "1×");
	#resume: PageSlot;
	#protected = false;
	#controls: ReaderControls = "shown";
	#headerHeight = 0;
	#pointerNearHeader = false;
	#fitWidth = false;
	#scroll = element("main", "reader-scroll");
	#stack = element("div", "pdf-pages");
	#zoom = new PaperZoom(
		this.#scroll,
		(y) =>
			this.#slots[this.#indexAt(y - this.#stack.getBoundingClientRect().top)]
				?.surface,
		() => this.#wanted.map((slot) => slot.surface),
		() => {
			this.#scroll.classList.add("reader-scroll--free-pan");
			if (this.#zoom.moving) {
				this.#cancelPaint();
				return;
			}
			this.#area = null;
			this.#stack.style.setProperty("--reader-zoom", String(this.#zoom.scale));
			this.#zoomIn.disabled = this.#zoom.atMaximum;
			this.#zoomOut.disabled = this.#zoom.scale <= 1;
			const label = `${Number(this.#zoom.scale.toFixed(1))}×`;
			if (this.#magnification.value !== label)
				this.#magnification.value = label;
			this.#onViewport();
		},
	);
	#label = element("span", "page-position");
	#notice = element("span", "save-notice");
	#loading: PDFDocumentLoadingTask | null = null;
	#document: PDFDocumentProxy | null = null;
	#slots: PageSlot[] = [];
	#near = new Set<PageSlot>();
	#wanted: PageSlot[] = [];
	#paint: PagePaint | null = null;
	#zoomTimer = 0;
	#forward = true;
	#resize = new ResizeObserver(() => {
		this.#headerHeight = this.#header.offsetHeight;
		this.#requestLayout();
	});
	#frame = 0;
	#closed = false;
	#area: ReadingArea | null = null;
	#defaultRatio = "";
	#active = 0;
	#enteredPageAt = 0;
	#pageBounds = { top: 0, height: 1 };
	#scrollTop = 0;
	#scrollTimer = 0;
	#pageSizes = new Map<PageSlot, string>();
	#pending: Position | null = null;
	#writing: Promise<void> | null = null;
	#saveTimer = 0;

	constructor(
		readonly book: Book,
		location: ShelfLocation,
		readonly saveAfter?: Promise<void>,
	) {
		const back = backToShelf(location);
		this.heading = element("h1", "reader-title", book.title);
		this.heading.tabIndex = -1;
		this.#label.setAttribute("aria-live", "polite");
		this.#label.hidden = true;
		this.#notice.setAttribute("role", "status");
		this.#notice.hidden = true;
		this.#scroll.tabIndex = 0;
		this.#scroll.setAttribute("aria-label", "PDF pages");
		this.#resume = pageSlot(book.progress?.page ?? 1);
		this.#stack.append(this.#resume.surface);
		this.#scroll.append(this.#stack);
		this.#preview(this.#resume, true);

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
		this.#tools.hidden = true;
		for (const [button, label, step] of [
			[this.#zoomOut, "Zoom out", -1],
			[this.#zoomIn, "Zoom in", 1],
		] as const) {
			button.type = "button";
			button.setAttribute("aria-label", label);
			button.title = label;
			button.addEventListener("click", () => this.#zoom.step(step));
		}
		this.#zoomOut.disabled = true;
		this.#magnification.setAttribute(
			"aria-label",
			"Zoom relative to the fitted page",
		);
		this.#magnification.setAttribute("aria-live", "off");
		this.#tools.append(
			this.#zoomOut,
			this.#magnification,
			this.#zoomIn,
			this.#fit,
		);
		this.#fit.addEventListener("click", () => {
			this.#zoom.refit(() => {
				this.#area = null;
				this.#fitWidth = !this.#fitWidth;
				this.#fit.setAttribute("aria-pressed", String(this.#fitWidth));
				this.view.classList.toggle("reader--fit-width", this.#fitWidth);
			});
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
		this.#actions.append(back, this.#tools);
		this.#header.append(this.#actions, this.heading, this.#label, this.#notice);
		this.view.append(this.#header, this.#toggle, this.#scroll);
		this.#setControls("shown");
	}

	async open(): Promise<void> {
		try {
			const load = await pdfLoader();
			if (this.#closed) return;
			this.#loading = load(this.book.id, this.#askPassword);
			const pdf = await this.#loading.promise;
			if (this.#closed) return;
			const start = Math.min(pdf.numPages, this.book.progress?.page ?? 1);
			const first = await pdf.getPage(start);
			if (this.#closed) return;
			const shape = first.getViewport({ scale: 1 });
			this.#defaultRatio = String(shape.width / shape.height);
			this.#stack.style.setProperty("--page-ratio", this.#defaultRatio);
			this.#slots = Array.from({ length: pdf.numPages }, (_, index) =>
				index + 1 === this.#resume.number ? this.#resume : pageSlot(index + 1),
			);
			const anchor = this.#slots[start - 1];
			if (!anchor) throw new Error("Missing saved page");
			if (anchor !== this.#resume) {
				this.#forget(this.#resume);
				this.#stack.replaceChildren(anchor.surface);
			}
			const before = document.createDocumentFragment();
			const after = document.createDocumentFragment();
			for (const slot of this.#slots) {
				if (slot !== anchor)
					(slot.number < start ? before : after).append(slot.surface);
			}
			anchor.surface.before(before);
			anchor.surface.after(after);
			if (!this.#stack.isConnected) this.#scroll.replaceChildren(this.#stack);
			anchor.surface.style.setProperty("--page-ratio", this.#defaultRatio);
			anchor.page = first;
			this.#document = pdf;
			this.view.classList.add("reader--reading");
			this.#tools.hidden = false;
			this.#toggle.hidden = false;
			this.#setControls("hidden");
			this.#active = start;
			this.#enteredPageAt = performance.now();
			this.#showPosition({ page: start, total: pdf.numPages });
			const resume = this.#slots[start - 1];
			if (resume) this.#scroll.scrollTop = resume.surface.offsetTop;
			this.#scrollTop = this.#scroll.scrollTop;
			this.#scroll.addEventListener("scroll", this.#onScroll, {
				passive: true,
			});
			window.addEventListener("keydown", this.#onKeyDown);
			this.#zoom.connect();
			window.visualViewport?.addEventListener("resize", this.#onViewport);
			window.visualViewport?.addEventListener("scroll", this.#onViewport);
			window.addEventListener("scroll", this.#onViewport, { passive: true });
			window.addEventListener("pagehide", this.#onPageHide);
			this.#resize.observe(this.#scroll);
			this.#resize.observe(this.#header, { box: "border-box" });
			if (start !== this.book.progress?.page) {
				this.#remember({ page: start, total: pdf.numPages });
			}
			this.#onViewport();
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

	#askPassword = (
		submit: (password: string) => void,
		incorrect: boolean,
	): void => {
		if (this.#closed) return;
		this.#protected = true;
		this.#forget(this.#resume);
		const form = element("form", "message reader-password");
		const label = element("label", undefined, "PDF password");
		const input = element("input");
		input.type = "password";
		input.required = true;
		input.autocomplete = "off";
		input.id = "pdf-password";
		label.htmlFor = input.id;
		const unlock = element("button", "reader-fit", "Open PDF");
		unlock.type = "submit";
		form.append(label, input);
		if (incorrect) {
			const error = element("p", "message-detail", "Incorrect password.");
			error.id = "password-error";
			input.setAttribute("aria-describedby", error.id);
			input.setAttribute("aria-invalid", "true");
			form.append(error);
		}
		form.append(unlock);
		form.addEventListener(
			"submit",
			(event) => {
				event.preventDefault();
				submit(input.value);
				input.value = "";
				this.#scroll.replaceChildren(this.#stack);
			},
			{ once: true },
		);
		this.#scroll.replaceChildren(form);
		input.focus();
	};

	#preview(slot: PageSlot, first = false): void {
		this.#near.add(slot);
		if (this.#protected || slot.preview || slot.base) return;
		const image = element("img", "page-preview");
		image.alt = "";
		image.decoding = "async";
		image.fetchPriority = first ? "high" : "low";
		image.hidden = true;
		slot.preview = image;
		slot.surface.prepend(image);
		image.src = previewUrl(this.book.id, slot.number);
		void image.decode().then(
			() => {
				if (this.#closed || slot.preview !== image) return;
				const ratio = Number(this.#defaultRatio);
				const rounding = Math.abs(
					image.naturalWidth - image.naturalHeight * ratio,
				);
				if (
					!slot.page &&
					!slot.surface.style.getPropertyValue("--page-ratio") &&
					rounding > Math.max(1, ratio)
				)
					this.#sizePage(
						slot,
						String(image.naturalWidth / image.naturalHeight),
					);
				image.hidden = false;
				delete slot.surface.dataset.status;
				this.#requestLayout();
			},
			() => {
				image.remove();
				this.#requestLayout();
			},
		);
	}

	#settleZoom(): void {
		if (this.#paint?.detail) this.#cancelPaint();
		window.clearTimeout(this.#zoomTimer);
		this.#zoomTimer = window.setTimeout(() => {
			this.#zoomTimer = 0;
			this.#requestLayout();
		}, 100);
	}

	#onViewport = (): void => {
		if ((window.visualViewport?.scale ?? 1) > 1)
			this.#scroll.classList.add("reader-scroll--free-pan");
		this.#settleZoom();
		this.#requestLayout();
	};

	#onKeyDown = (event: KeyboardEvent): void => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (["+", "=", "-", "0"].includes(event.key)) {
			event.preventDefault();
			if (event.key === "0") this.#zoom.reset();
			else this.#zoom.step(event.key === "-" ? -1 : 1);
			return;
		}
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
		this.#frame = 0;
		this.#zoom.disconnect();
		this.#pageSizes.clear();
		window.clearTimeout(this.#scrollTimer);
		this.#scrollTimer = 0;
		window.clearTimeout(this.#zoomTimer);
		this.#zoomTimer = 0;
		this.#resize.disconnect();
		this.#scroll.removeEventListener("scroll", this.#onScroll);
		window.removeEventListener("keydown", this.#onKeyDown);
		window.visualViewport?.removeEventListener("resize", this.#onViewport);
		window.visualViewport?.removeEventListener("scroll", this.#onViewport);
		window.removeEventListener("scroll", this.#onViewport);
		window.removeEventListener("pagehide", this.#onPageHide);
		this.#cancelPaint();
		for (const slot of this.#near) this.#forget(slot);
	}

	#showUnavailable(): void {
		if (this.#closed) return;
		this.#disconnect();
		this.#document = null;
		this.view.classList.remove("reader--reading");
		this.#tools.hidden = true;
		this.#toggle.hidden = true;
		this.#setControls("shown");
		this.#label.hidden = true;
		const notice = message(
			"PDF unavailable",
			"The PDF could not be opened.",
			"alert",
		);
		const retry = element("button", "reader-fit", "Retry");
		retry.type = "button";
		retry.addEventListener(
			"click",
			async () => {
				retry.disabled = true;
				await this.#loading?.destroy().catch(() => {});
				if (this.#closed) return;
				this.#stack.replaceChildren(this.#resume.surface);
				this.#scroll.replaceChildren(this.#stack);
				this.#preview(this.#resume, true);
				this.#scroll.focus();
				await this.open();
			},
			{ once: true },
		);
		notice.append(retry);
		this.#scroll.replaceChildren(notice);
	}

	#onScroll = (): void => {
		const top = this.#scroll.scrollTop;
		const area = this.#area;
		if (
			this.#controls === "shown" &&
			top !== this.#scrollTop &&
			area?.fitWidth === this.#fitWidth &&
			area.width === this.#scroll.clientWidth &&
			area.height === this.#scroll.clientHeight &&
			!this.#actions.querySelector(":focus-visible")
		) {
			this.#setControls("hidden");
		}
		if (top !== this.#scrollTop) {
			if (
				area &&
				this.#scroll.classList.contains("reader-scroll--free-pan") &&
				!this.#zoom.moving &&
				this.#zoom.scale === 1 &&
				(window.visualViewport?.scale ?? 1) === 1
			)
				this.#scroll.classList.remove("reader-scroll--free-pan");
			window.clearTimeout(this.#scrollTimer);
			this.#scrollTimer = window.setTimeout(() => {
				this.#scrollTimer = 0;
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
		if (this.#closed || this.#frame || !this.#document || this.#zoom.moving)
			return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = 0;
			this.#layout();
		});
	}

	#layout(): void {
		if (!this.#document || this.#zoom.moving) return;
		if (!this.#scrollTimer) this.#applyPageSizes();
		const width = this.#scroll.clientWidth;
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
				const fraction = Math.max(
					0,
					Math.min(
						1,
						(this.#scroll.scrollTop - this.#pageBounds.top) /
							this.#pageBounds.height,
					),
				);
				this.#scroll.scrollTop =
					anchor.surface.offsetTop + fraction * anchor.surface.clientHeight;
			}
			this.#scrollTop = this.#scroll.scrollTop;
			this.#cancelPaint();
			this.#area = { width, height, fitWidth: this.#fitWidth };
		}
		const top = this.#scroll.scrollTop;
		const active = this.#activeIndex(top);
		const visibleEnd = this.#indexAt(top + height);
		const activeSlot = this.#slots[active];
		if (!activeSlot) return;
		const ratio =
			activeSlot.surface.style.getPropertyValue("--page-ratio") ||
			this.#defaultRatio;
		if (this.#stack.style.getPropertyValue("--active-ratio") !== ratio)
			this.#stack.style.setProperty("--active-ratio", ratio);
		const nearby = this.#slots.slice(
			Math.max(0, this.#indexAt(top) - 1),
			visibleEnd + 2,
		);
		this.#sizeNearby(nearby);
		this.#pageBounds = {
			top: activeSlot.surface.offsetTop,
			height: Math.max(1, activeSlot.surface.clientHeight),
		};
		this.#wanted = [
			activeSlot,
			...nearby.filter((slot) => slot !== activeSlot),
		];
		const page = active + 1;
		if (page !== this.#active) {
			this.#forward = page > this.#active;
			this.#enteredPageAt = performance.now();
			this.#slots[this.#active - 1]?.page?.cleanup();
			this.#active = page;
			const position = { page, total: this.#document.numPages };
			this.#showPosition(position);
			this.#remember(position);
		}
		this.#preparePages(activeSlot);
	}

	#preparePages(active: PageSlot): void {
		const bounds = visibleReadingArea(this.#scroll);
		const visible = this.#wanted.filter(({ surface }) => {
			const rect = surface.getBoundingClientRect();
			return rect.bottom > bounds.top && rect.top < bounds.bottom;
		});
		if (!visible.length) visible.push(active);
		const numbers = visible.map((slot) => slot.number);
		const first = Math.min(...numbers) - 1;
		const end = Math.max(...numbers);
		const after = this.#slots.slice(end, end + (this.#forward ? 4 : 2));
		const before = this.#slots
			.slice(Math.max(0, first - (this.#forward ? 2 : 4)), first)
			.reverse();
		const ahead = this.#forward ? after : before;
		const behind = this.#forward ? before : after;
		const adjacent = [...ahead.slice(0, 1), ...behind.slice(0, 1)];
		const previews = [...ahead, ...behind];
		for (const slot of this.#near) {
			if (visible.includes(slot)) continue;
			if (adjacent.includes(slot)) {
				if (slot.detail) clearCanvas(slot.detail.canvas);
				slot.detail = null;
				continue;
			}
			if (!previews.includes(slot)) this.#forget(slot);
			else if (slot.base || slot.page || slot.failed) this.#releaseLayers(slot);
		}
		for (const slot of visible) this.#preview(slot, true);
		if (
			!this.#protected &&
			this.#canReadAhead() &&
			!previews.some((slot) => slot.preview?.isConnected && slot.preview.hidden)
		) {
			const next = previews.find((slot) => !slot.preview && !slot.base);
			if (next) this.#preview(next);
		}
		this.#renderNext(visible, adjacent);
	}

	#sizeNearby(nearby: PageSlot[]): void {
		const entering = nearby.filter((slot) => !this.#wanted.includes(slot));
		if (!entering.length && nearby.length === this.#wanted.length) return;
		const leaving = this.#wanted.filter((slot) => !nearby.includes(slot));
		const resize = () => {
			for (const slot of entering) slot.surface.classList.add("pdf-page--near");
			for (const slot of leaving)
				slot.surface.classList.remove("pdf-page--near");
		};
		if (this.#zoom.scale === 1) resize();
		else {
			this.#keepReadingPoint(resize);
			this.#requestLayout();
		}
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

	#nextRaster(slot: PageSlot, adjacent: boolean): Raster | null {
		if (!this.#canPaint(slot) || (adjacent && !this.#canReadAhead()))
			return null;
		const target = pageRaster(
			slot.surface,
			this.#scroll,
			this.#zoom.scale > 1,
			adjacent,
		);
		if (!target) return null;
		const base = slot.base?.raster;
		if (
			adjacent &&
			base &&
			base.width === target.width &&
			base.height === target.height &&
			base.density >= target.density
		)
			return null;
		let next = target;
		if (target.detail) {
			if (!slot.base) next = pageBacking(target);
			else if (
				this.#zoomTimer ||
				coversView(slot.detail?.raster ?? null, target)
			)
				return null;
		} else if (coversView(slot.base?.raster ?? null, target)) {
			if (slot.detail) clearCanvas(slot.detail.canvas);
			slot.detail = null;
			return null;
		}
		const failed = slot.failed;
		return failed &&
			(!failed.adjacent || adjacent) &&
			coversView(failed.raster, next)
			? null
			: next;
	}

	#cancelPaint(): void {
		this.#paint?.task?.cancel();
		this.#paint = null;
	}

	#renderNext(visible: PageSlot[], adjacent: PageSlot[]): void {
		const pdf = this.#document;
		const area = this.#area;
		if (!pdf || !area || this.#closed) return;
		for (const slot of [...visible, ...adjacent]) {
			const background = adjacent.includes(slot);
			const raster = this.#nextRaster(slot, background);
			if (!raster) continue;
			if (this.#paint?.slot === slot) return;
			this.#cancelPaint();
			const paint: PagePaint = { slot, task: null, detail: raster.detail };
			this.#paint = paint;
			this.#near.add(slot);
			void this.#renderPage(pdf, area, paint, raster, background);
			return;
		}
		this.#cancelPaint();
	}

	async #renderPage(
		pdf: PDFDocumentProxy,
		area: ReadingArea,
		paint: PagePaint,
		requested: Raster,
		adjacent: boolean,
	): Promise<void> {
		const { slot } = paint;
		let raster: Raster | null = requested;
		const canvas = element("canvas");
		try {
			const page = slot.page ?? (await pdf.getPage(slot.number));
			if (!this.#wants(paint, area)) return;
			slot.page = page;
			const shape = page.getViewport({ scale: 1 });
			this.#sizePage(slot, String(shape.width / shape.height));
			raster = this.#nextRaster(slot, adjacent);
			if (!raster) return;
			const task = paintPage(page, canvas, raster);
			paint.task = task;
			paint.detail = raster.detail;
			await task.promise;
			if (!this.#wants(paint, area)) return;
			if (raster.detail) {
				const visible = pageRaster(
					slot.surface,
					this.#scroll,
					this.#zoom.scale > 1,
				);
				if (!visible || !coversView(raster, visible)) return;
			}
			const key = raster.detail ? "detail" : "base";
			const previous = slot[key];
			if (previous) previous.canvas.replaceWith(canvas);
			else slot.surface.append(canvas);
			slot[key] = { canvas, raster };
			if (previous) clearCanvas(previous.canvas);
			slot.failed = null;
			if (slot.number !== this.#active) page.cleanup();
			delete slot.surface.dataset.status;
		} catch (error) {
			const cancelled =
				error instanceof Error && error.name === "RenderingCancelledException";
			if (!cancelled && raster && this.#wants(paint, area)) {
				slot.failed = { raster, adjacent };
				if (!slot.base && (!slot.preview?.isConnected || slot.preview.hidden))
					slot.surface.dataset.status = `Page ${slot.number} could not be rendered.`;
			}
		} finally {
			if (slot.base?.canvas !== canvas && slot.detail?.canvas !== canvas)
				clearCanvas(canvas);
			if (this.#paint === paint) {
				this.#paint = null;
				this.#requestLayout();
			}
		}
	}

	#sizePage(slot: PageSlot, ratio: string): void {
		if (
			ratio ===
			(slot.surface.style.getPropertyValue("--page-ratio") ||
				this.#defaultRatio)
		) {
			this.#pageSizes.delete(slot);
			return;
		}
		this.#pageSizes.set(slot, ratio);
		if (!this.#scrollTimer && !this.#zoom.moving) this.#applyPageSizes();
	}

	#applyPageSizes(): void {
		if (!this.#pageSizes.size) return;
		this.#keepReadingPoint(() => {
			for (const [slot, ratio] of this.#pageSizes)
				slot.surface.style.setProperty("--page-ratio", ratio);
			this.#pageSizes.clear();
		});
	}

	#keepReadingPoint(resize: () => void): void {
		const atEnd = this.#atEnd();
		const y =
			this.#scroll.getBoundingClientRect().top +
			Math.min(this.#scroll.clientHeight / 4, 120);
		const anchor =
			this.#slots[this.#indexAt(y - this.#stack.getBoundingClientRect().top)]
				?.surface;
		const before = anchor?.getBoundingClientRect();
		resize();
		if (!anchor || !before?.height) return;
		const after = anchor.getBoundingClientRect();
		const fraction = (y - before.top) / before.height;
		const delta = atEnd
			? this.#scroll.scrollHeight -
				this.#scroll.clientHeight -
				this.#scroll.scrollTop
			: after.top + fraction * after.height - y;
		if (Math.abs(delta) >= 0.5)
			this.#scroll.scrollTop = Math.round(this.#scroll.scrollTop + delta);
		this.#scrollTop = this.#scroll.scrollTop;
	}

	#canPaint(slot: PageSlot): boolean {
		return (
			!this.#zoom.moving &&
			(!this.#scrollTimer ||
				(!slot.base &&
					(this.#protected ||
						slot.preview?.isConnected === false ||
						this.#canReadAhead())))
		);
	}

	#canReadAhead(): boolean {
		return (
			!this.#zoomTimer &&
			(!this.#scrollTimer ||
				performance.now() - this.#enteredPageAt >= readingDwellMs)
		);
	}

	#wants(paint: PagePaint, area: ReadingArea): boolean {
		return (
			this.#paint === paint &&
			this.#canPaint(paint.slot) &&
			area === this.#area &&
			area.fitWidth === this.#fitWidth
		);
	}

	#releaseLayers(slot: PageSlot): void {
		if (slot.detail) clearCanvas(slot.detail.canvas);
		if (slot.base) clearCanvas(slot.base.canvas);
		slot.detail = null;
		slot.base = null;
		slot.page?.cleanup();
		slot.page = null;
		slot.failed = null;
		if (!slot.preview || slot.preview.hidden)
			slot.surface.dataset.status = `Loading page ${slot.number}…`;
	}

	#forget(slot: PageSlot): void {
		this.#releaseLayers(slot);
		if (slot.preview) {
			slot.preview.removeAttribute("src");
			slot.preview.remove();
			slot.preview = null;
		}
		slot.surface.dataset.status = `Loading page ${slot.number}…`;
		this.#near.delete(slot);
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
