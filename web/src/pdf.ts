import type {
	PDFDocumentLoadingTask,
	PDFPageProxy,
	RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { bookUrl } from "./api";

export async function pdfLoader(): Promise<
	(id: string) => PDFDocumentLoadingTask
> {
	const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
	GlobalWorkerOptions.workerSrc = workerUrl;
	return (id: string): PDFDocumentLoadingTask =>
		getDocument({
			url: `${bookUrl(id)}/pdf`,
			cMapUrl: "/pdfjs/cmaps/",
			iccUrl: "/pdfjs/iccs/",
			standardFontDataUrl: "/pdfjs/standard_fonts/",
			wasmUrl: "/pdfjs/wasm/",
			disableAutoFetch: true,
			disableStream: true,
		});
}

export function paintPage(
	page: PDFPageProxy,
	canvas: HTMLCanvasElement,
	width: number,
	maximumPixels: number,
): RenderTask {
	const natural = page.getViewport({ scale: 1 });
	const displayScale = width / natural.width;
	const pixels = natural.width * natural.height * displayScale ** 2;
	const resolution = Math.min(
		window.devicePixelRatio || 1,
		2,
		Math.sqrt(maximumPixels / pixels),
	);
	const viewport = page.getViewport({ scale: displayScale * resolution });
	canvas.width = Math.max(1, Math.floor(viewport.width));
	canvas.height = Math.max(1, Math.floor(viewport.height));
	return page.render({ canvas, viewport });
}

export function clearCanvas(canvas: HTMLCanvasElement): void {
	canvas.width = 0;
	canvas.height = 0;
	canvas.remove();
}
