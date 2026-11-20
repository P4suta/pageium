import type {
	PDFDocumentLoadingTask,
	PDFPageProxy,
	RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { bookUrl } from "./api";

export async function pdfLoader(): Promise<
	(
		id: string,
		ask: (submit: (password: string) => void, incorrect: boolean) => void,
	) => PDFDocumentLoadingTask
> {
	const { getDocument, GlobalWorkerOptions, PasswordResponses } = await import(
		"pdfjs-dist"
	);
	GlobalWorkerOptions.workerSrc = workerUrl;
	return (id, ask) => {
		const task = getDocument({
			url: `${bookUrl(id)}/pdf`,
			cMapUrl: "/pdfjs/cmaps/",
			iccUrl: "/pdfjs/iccs/",
			standardFontDataUrl: "/pdfjs/standard_fonts/",
			wasmUrl: "/pdfjs/wasm/",
			disableAutoFetch: true,
			disableStream: true,
		});
		task.onPassword = (submit: (password: string) => void, reason: number) =>
			ask(submit, reason === PasswordResponses.INCORRECT_PASSWORD);
		return task;
	};
}

const pixelBudget = 8_388_608;
const maxSide = 8192;

interface Clip {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface Raster {
	width: number;
	height: number;
	density: number;
	visible: Clip;
	clip: Clip;
	detail: boolean;
}

export function visibleReadingArea(scroll: HTMLElement): Clip {
	const bounds = scroll.getBoundingClientRect();
	const root = document.documentElement.getBoundingClientRect();
	const screen = window.visualViewport;
	const x = screen ? root.left + screen.pageLeft : 0;
	const y = screen ? root.top + screen.pageTop : 0;
	return {
		left: Math.max(bounds.left, x),
		top: Math.max(bounds.top, y),
		right: Math.min(bounds.right, x + (screen?.width ?? innerWidth)),
		bottom: Math.min(bounds.bottom, y + (screen?.height ?? innerHeight)),
	};
}

export function pageRaster(
	surface: HTMLElement,
	scroll: HTMLElement,
	zoomed: boolean,
	adjacent = false,
): Raster | null {
	const page = surface.getBoundingClientRect();
	const { width, height } = page;
	if (width <= 0 || height <= 0) return null;
	const screen = window.visualViewport;
	const pinch = screen?.scale ?? 1;
	const dpr = window.devicePixelRatio;
	// Desktop WebKit includes native magnification in the reported pixel ratio.
	const includesPinch =
		pinch > 1 && matchMedia(`(resolution: ${dpr / pinch}dppx)`).matches;
	const density = Math.max(1, includesPinch ? dpr : dpr * pinch);
	if (adjacent) {
		return pageBacking(
			page,
			Math.min(
				zoomed || pinch > 1 ? 1 : density,
				Math.sqrt(pixelBudget / 2 / (width * height)),
				maxSide / Math.max(width, height),
			),
		);
	}
	const bounds = visibleReadingArea(scroll);
	const visible = {
		left: Math.max(0, bounds.left - page.left),
		top: Math.max(0, bounds.top - page.top),
		right: Math.min(width, bounds.right - page.left),
		bottom: Math.min(height, bounds.bottom - page.top),
	};
	const w = visible.right - visible.left;
	const h = visible.bottom - visible.top;
	if (w <= 0 || h <= 0) return null;
	const whole = { left: 0, top: 0, right: width, bottom: height };
	if (
		!zoomed &&
		pinch <= 1 &&
		width * height * density ** 2 <= pixelBudget &&
		Math.max(width, height) * density <= maxSide
	) {
		return {
			width,
			height,
			density,
			visible,
			clip: whole,
			detail: false,
		};
	}
	const spare = Math.max(
		0,
		Math.min(0.2, (Math.sqrt(pixelBudget / (w * h)) / density - 1) / 2),
	);
	const clip = {
		left: Math.max(0, Math.floor(visible.left - w * spare)),
		top: Math.max(0, Math.floor(visible.top - h * spare)),
		right: Math.min(width, Math.ceil(visible.right + w * spare)),
		bottom: Math.min(height, Math.ceil(visible.bottom + h * spare)),
	};
	return { width, height, density, visible, clip, detail: true };
}

export function pageBacking(
	{ width, height }: Pick<Raster, "width" | "height">,
	density = 1,
): Raster {
	const clip = { left: 0, top: 0, right: width, bottom: height };
	return { width, height, density, visible: clip, clip, detail: false };
}

export function coversView(painted: Raster | null, wanted: Raster): boolean {
	if (
		!painted ||
		painted.width !== wanted.width ||
		painted.height !== wanted.height ||
		painted.density !== wanted.density ||
		painted.detail !== wanted.detail
	)
		return false;
	const { clip } = painted;
	const { visible } = wanted;
	return (
		clip.left <= visible.left &&
		clip.top <= visible.top &&
		clip.right >= visible.right &&
		clip.bottom >= visible.bottom
	);
}

export function paintPage(
	page: PDFPageProxy,
	canvas: HTMLCanvasElement,
	raster: Raster,
): RenderTask {
	const { width, height, clip } = raster;
	const w = clip.right - clip.left;
	const h = clip.bottom - clip.top;
	const density = Math.min(
		raster.density,
		Math.sqrt(pixelBudget / (w * h)),
		maxSide / Math.max(w, h),
	);
	canvas.width = Math.max(1, Math.floor(w * density));
	canvas.height = Math.max(1, Math.floor(h * density));
	if (raster.detail) canvas.className = "page-detail";
	canvas.style.left = `${(100 * clip.left) / width}%`;
	canvas.style.top = `${(100 * clip.top) / height}%`;
	canvas.style.width = `${(100 * w) / width}%`;
	canvas.style.height = `${(100 * h) / height}%`;
	const natural = page.getViewport({ scale: 1 });
	const viewport = page.getViewport({ scale: width / natural.width });
	const sx = canvas.width / w;
	const sy = canvas.height / h;
	return page.render({
		canvas,
		viewport,
		transform: [sx, 0, 0, sy, -clip.left * sx, -clip.top * sy],
	});
}

export function clearCanvas(canvas: HTMLCanvasElement): void {
	canvas.remove();
	canvas.width = 0;
	canvas.height = 0;
}
