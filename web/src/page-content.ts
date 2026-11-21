import { AnnotationType, type PDFPageProxy, TextLayer } from "pdfjs-dist";
import { element } from "./dom";
import {
	bookLink,
	type Destination,
	type PdfRectangle,
	pageRectangle,
} from "./pdf-destinations";

export interface TextMatch {
	start: number;
	length: number;
}

export class PageContent {
	readonly #text = element("div", "page-text");
	readonly #links = element("div", "page-links");
	readonly #viewport;
	readonly #layer: TextLayer;
	#hasText: boolean | undefined;
	#failed = false;
	#removed = false;
	#scale = 0;
	#match: TextMatch | null = null;
	#marks: HTMLElement[] = [];

	constructor(
		readonly surface: HTMLElement,
		page: PDFPageProxy,
		follow: (dest: Destination) => void,
		ready: () => void,
	) {
		this.#viewport = page.getViewport({ scale: 1 });
		this.#layer = new TextLayer({
			container: this.#text,
			viewport: this.#viewport,
			textContentSource: page.streamTextContent({ disableNormalization: true }),
		});
		surface.append(this.#text, this.#links);
		this.resize();
		void this.#layer.render().then(
			() => {
				if (this.#removed) return;
				this.#hasText = this.#layer.textContentItemsStr.some(
					(str) => str.trim().length > 0,
				);
				ready();
			},
			() => {
				if (this.#removed) return;
				this.#failed = true;
				ready();
			},
		);
		void this.#loadLinks(page, follow);
	}

	get textNotice(): string {
		if (this.#failed) return "Text could not be read on this page";
		return this.#hasText === false ? "No searchable text on this page" : "";
	}

	resize(): void {
		const scale =
			(this.surface.getBoundingClientRect().width / this.#viewport.width) *
			this.#viewport.userUnit;
		if (scale === this.#scale) return;
		this.#scale = scale;
		this.#text.style.setProperty("--total-scale-factor", String(scale));
	}

	async #loadLinks(
		page: PDFPageProxy,
		follow: (dest: Destination) => void,
	): Promise<void> {
		const annotations = await page
			.getAnnotations({ intent: "display" })
			.catch(() => []);
		if (this.#removed) return;
		for (const item of annotations) {
			if (
				item.annotationType !== AnnotationType.LINK ||
				item.noHTML ||
				!Array.isArray(item.rect) ||
				item.rect.length !== 4 ||
				!item.rect.every(Number.isFinite)
			)
				continue;
			const label =
				item.contentsObj?.str ||
				item.titleObj?.str ||
				item.url ||
				(typeof item.dest === "string" ? item.dest : "Go to linked page");
			const link = bookLink(item, label, follow);
			if (!link) continue;
			link.setAttribute("aria-label", label);
			link.title = label;
			link.textContent = "";
			const rect = pageRectangle(this.#viewport, item.rect as PdfRectangle);
			link.style.left = `${rect.x * 100}%`;
			link.style.top = `${rect.y * 100}%`;
			link.style.width = `${rect.width * 100}%`;
			link.style.height = `${rect.height * 100}%`;
			this.#links.append(link);
		}
	}

	highlight(match: TextMatch | null): HTMLElement | undefined {
		if (
			this.#match?.start === match?.start &&
			this.#match?.length === match?.length
		)
			return this.#marks[0];
		for (const mark of this.#marks) {
			const parent = mark.parentNode;
			mark.replaceWith(...mark.childNodes);
			parent?.normalize();
		}
		this.#marks = [];
		this.#match = null;
		if (!match || !this.#hasText) return;
		this.#match = match;
		let offset = 0;
		const end = match.start + match.length;
		for (const div of this.#layer.textDivs) {
			const str = div.textContent;
			const startInRun = Math.max(0, match.start - offset);
			const endInRun = Math.min(str.length, end - offset);
			if (startInRun < endInRun) {
				const mark = element(
					"mark",
					undefined,
					str.slice(startInRun, endInRun),
				);
				div.replaceChildren(
					str.slice(0, startInRun),
					mark,
					str.slice(endInRun),
				);
				this.#marks.push(mark);
			}
			offset += str.length;
			if (offset >= end) break;
		}
		return this.#marks[0];
	}

	remove(): void {
		this.#removed = true;
		this.#layer.cancel();
		this.#text.remove();
		this.#links.remove();
	}
}
