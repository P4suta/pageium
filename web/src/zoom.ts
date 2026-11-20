import { visibleReadingArea } from "./pdf";

const maximum = 8;
const levels = [1, 1.5, 2, 3, 4, 6, maximum];

interface PaperPoint {
	paper: HTMLElement;
	x: number;
	y: number;
	fractionX: number;
	fractionY: number;
}

interface PinchEvent extends Event {
	scale: number;
	clientX: number;
	clientY: number;
}

interface ZoomPreview {
	point: PaperPoint;
	layers: { paper: HTMLElement; heightBefore: number }[];
	focusX: number;
	focusY: number;
	fittedWidth: number;
	scaledHeight: number;
	scrollX: number;
	scrollY: number;
	overflowY: number;
}

export class PaperZoom {
	scale = 1;
	#target = 1;
	#displayed = 1;
	#frame = 0;
	#wheelEnd = 0;
	#pinchScale: number | null = null;
	#motion: ZoomPreview | null = null;

	constructor(
		readonly pane: HTMLElement,
		readonly paperAt: (y: number) => HTMLElement | undefined,
		readonly nearby: () => HTMLElement[],
		readonly changed: () => void,
	) {}

	connect(): void {
		this.pane.addEventListener("gesturestart", this.#start, { passive: false });
		window.addEventListener("gesturechange", this.#change, { passive: false });
		window.addEventListener("gestureend", this.#end, { passive: false });
		window.addEventListener("blur", this.#onBlur);
		this.pane.addEventListener("wheel", this.#onWheel, { passive: false });
	}

	disconnect(): void {
		this.pane.removeEventListener("gesturestart", this.#start);
		window.removeEventListener("gesturechange", this.#change);
		window.removeEventListener("gestureend", this.#end);
		window.removeEventListener("blur", this.#onBlur);
		this.pane.removeEventListener("wheel", this.#onWheel);
		this.#clear();
	}

	get moving(): boolean {
		return this.#motion !== null;
	}

	get atMaximum(): boolean {
		return this.scale >= maximum;
	}

	step(direction: number): void {
		const next =
			direction > 0
				? levels.find((level) => level > this.#target)
				: levels.findLast((level) => level < this.#target);
		if (next !== undefined) this.#animate(next);
	}

	reset(): void {
		this.#animate(1);
	}

	refit(changeFit: () => void): void {
		this.#finish();
		const point = this.#point();
		changeFit();
		this.#commit(1, point);
	}

	#point(x?: number, y?: number): PaperPoint | null {
		if (x === undefined || y === undefined || !Number.isFinite(x + y)) {
			const area = visibleReadingArea(this.pane);
			x = (area.left + area.right) / 2;
			y = (area.top + area.bottom) / 2;
		}
		const paper = this.paperAt(y);
		if (!paper) return null;
		const r = paper.getBoundingClientRect();
		x = Math.max(r.left, Math.min(r.right, x));
		y = Math.max(r.top, Math.min(r.bottom, y));
		return {
			paper,
			x,
			y,
			fractionX: (x - r.left) / r.width,
			fractionY: (y - r.top) / r.height,
		};
	}

	#begin(point: PaperPoint): void {
		const papers = this.nearby();
		if (!papers.includes(point.paper)) papers.push(point.paper);
		const bounds = papers.map((paper) => ({
			paper,
			rect: paper.getBoundingClientRect(),
		}));
		const fittedWidth = (bounds[0]?.rect.width ?? 0) / this.scale;
		bounds.sort((a, b) => a.rect.top - b.rect.top);
		let scaledHeight = 0;
		let focusX = 0;
		let focusY = 0;
		const layers = bounds.map(({ paper, rect }) => {
			const heightBefore = scaledHeight;
			scaledHeight += rect.height;
			if (paper === point.paper) {
				focusX = point.fractionX * rect.width;
				focusY = heightBefore + point.fractionY * rect.height;
			}
			return { paper, heightBefore };
		});
		const style = getComputedStyle(this.pane);
		const bookHeight =
			point.paper.parentElement?.getBoundingClientRect().height ?? scaledHeight;
		this.#motion = {
			point,
			layers,
			focusX,
			focusY,
			fittedWidth,
			scaledHeight,
			scrollX: this.pane.scrollLeft,
			scrollY: this.pane.scrollTop,
			overflowY:
				bookHeight +
				Number.parseFloat(style.paddingTop) +
				Number.parseFloat(style.paddingBottom) -
				this.pane.clientHeight,
		};
		this.pane.classList.add("reader-scroll--scaling");
		this.pane.addEventListener("scroll", this.#scheduleDisplay, {
			passive: true,
		});
		this.changed();
	}

	#clear(): void {
		cancelAnimationFrame(this.#frame);
		this.#frame = 0;
		window.clearTimeout(this.#wheelEnd);
		this.#wheelEnd = 0;
		for (const { paper } of this.#motion?.layers ?? []) {
			paper.style.removeProperty("transform");
		}
		this.pane.classList.remove("reader-scroll--scaling");
		this.pane.removeEventListener("scroll", this.#scheduleDisplay);
		this.#motion = null;
		this.#pinchScale = null;
	}

	#commit(scale: number, point: PaperPoint | null): void {
		this.scale = this.#displayed = this.#target = scale;
		this.changed();
		if (!point) return;
		const r = point.paper.getBoundingClientRect();
		const dx = r.left + point.fractionX * r.width - point.x;
		const dy = r.top + point.fractionY * r.height - point.y;
		if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) this.pane.scrollBy(dx, dy);
	}

	#finish = (scale = this.#target): void => {
		if (!this.#motion) return;
		const { point } = this.#motion;
		this.#clear();
		this.#commit(scale, point);
	};

	#display(scale: number): void {
		if (!this.#motion) return;
		this.#displayed = scale;
		const preview = this.#motion;
		const factor = scale / this.scale;
		const change = factor - 1;
		const left = Math.max(
			0,
			Math.min(
				(scale - 1) * preview.fittedWidth,
				preview.scrollX + change * preview.focusX,
			),
		);
		const top = Math.max(
			0,
			Math.min(
				preview.overflowY + change * preview.scaledHeight,
				preview.scrollY + change * preview.focusY,
			),
		);
		const x = this.pane.scrollLeft - left;
		const scrollY = this.pane.scrollTop - top;
		for (const { paper, heightBefore } of preview.layers) {
			const y = scrollY + change * heightBefore;
			paper.style.transform = `translate(${x}px, ${y}px) scale(${factor})`;
		}
	}

	#animate(target: number): void {
		if (target === this.#target) return;
		this.#finish(this.#displayed);
		const point = this.#point();
		if (!point) return;
		if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
			this.#commit(target, point);
			return;
		}
		this.#begin(point);
		this.#target = target;
		const from = this.scale;
		const start = performance.now();
		const advance = (now: number) => {
			const t = Math.min(1, Math.max(0, (now - start) / 150));
			if (t === 1) this.#finish();
			else {
				this.#display(from + (target - from) * (1 - (1 - t) ** 3));
				this.#frame = requestAnimationFrame(advance);
			}
		};
		this.#frame = requestAnimationFrame(advance);
	}

	#scaleBy(factor: number): void {
		this.#target = Math.min(maximum, Math.max(1, this.#target * factor));
		if (this.#displayed !== this.#target) this.#scheduleDisplay();
	}

	#scheduleDisplay = (): void => {
		if (this.#frame || !this.#motion) return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = 0;
			this.#display(this.#target);
		});
	};

	#start = (event: Event): void => {
		if (
			navigator.maxTouchPoints > 0 ||
			!event.cancelable ||
			(window.visualViewport?.scale ?? 1) > 1.01
		)
			return;
		this.#finish(this.#displayed);
		const gesture = event as PinchEvent;
		const point = this.#point(gesture.clientX, gesture.clientY);
		if (!point) return;
		event.preventDefault();
		this.#begin(point);
		this.#pinchScale = gesture.scale || 1;
	};

	#change = (event: Event): void => {
		if (this.#pinchScale === null) return;
		event.preventDefault();
		const scale = (event as PinchEvent).scale;
		if (!(scale > 0 && Number.isFinite(scale))) return;
		this.#scaleBy(scale / this.#pinchScale);
		this.#pinchScale = scale;
	};

	#end = (event: Event): void => {
		if (this.#pinchScale === null) return;
		event.preventDefault();
		this.#finish();
	};

	#onBlur = (): void => this.#finish(this.#displayed);

	#onWheel = (event: WheelEvent): void => {
		if (!event.ctrlKey) {
			if (this.#motion && this.#pinchScale === null)
				this.#finish(this.#wheelEnd ? this.#target : this.#displayed);
			return;
		}
		if (!event.cancelable || (window.visualViewport?.scale ?? 1) > 1.01) return;
		event.preventDefault();
		if (this.#pinchScale !== null) return;
		if (!this.#wheelEnd) {
			this.#finish();
			const anchor = this.#point(event.clientX, event.clientY);
			if (!anchor) return;
			this.#begin(anchor);
		}
		const unit =
			event.deltaMode === WheelEvent.DOM_DELTA_LINE
				? 16
				: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
					? this.pane.clientHeight
					: 1;
		this.#scaleBy(Math.exp(-0.01 * event.deltaY * unit));
		window.clearTimeout(this.#wheelEnd);
		this.#wheelEnd = window.setTimeout(this.#finish, 100);
	};
}
