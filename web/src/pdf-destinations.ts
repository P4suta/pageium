import {
	isValidExplicitDest,
	type PDFDocumentProxy,
	type PDFPageProxy,
} from "pdfjs-dist";
import { element } from "./dom";

export type Destination = string | unknown[];
export type PdfRectangle = [number, number, number, number];
type ExplicitDestination = [
	number | Parameters<PDFDocumentProxy["getPageIndex"]>[0],
	{ name: string },
	...(number | null)[],
];

function isDestination(value: unknown): value is ExplicitDestination {
	return isValidExplicitDest(value);
}
export interface PagePoint {
	x: number;
	y: number;
}

interface LinkTarget {
	dest?: Destination | null;
	url?: string | null;
}

export function bookLink(
	target: LinkTarget,
	label: string,
	follow: (dest: Destination) => void,
): HTMLAnchorElement | null {
	const link = element("a");
	const { dest, url } = target;
	if (url) {
		const address = URL.parse(url);
		if (!address || !["https:", "http:"].includes(address.protocol))
			return null;
		link.href = address.href;
		link.target = "_blank";
		link.rel = "noopener noreferrer";
	} else if (typeof dest === "string" || Array.isArray(dest)) {
		link.href = window.location.hash;
		link.addEventListener("click", (event) => {
			event.preventDefault();
			follow(dest);
		});
	} else return null;
	link.textContent = label;
	return link;
}

export function pageRectangle(
	viewport: ReturnType<PDFPageProxy["getViewport"]>,
	[left, bottom, right, top]: PdfRectangle,
) {
	const [x1, y1] = viewport.convertToViewportPoint(left, bottom);
	const [x2, y2] = viewport.convertToViewportPoint(right, top);
	return {
		x: Math.min(x1, x2) / viewport.width,
		y: Math.min(y1, y2) / viewport.height,
		width: Math.abs(x2 - x1) / viewport.width,
		height: Math.abs(y2 - y1) / viewport.height,
	};
}

function destinationPoint(
	page: PDFPageProxy,
	[, mode, a, b, c, d]: ExplicitDestination,
): PagePoint {
	const viewport = page.getViewport({ scale: 1 });
	const [left = 0, bottom = 0, right = 0, top = 0] = viewport.viewBox;
	let rect: PdfRectangle;
	switch (mode.name) {
		case "Fit":
		case "FitB":
			return { x: 0, y: 0 };
		case "XYZ": {
			const x = a ?? left;
			const y = b ?? top;
			rect = [x, y, x, y];
			break;
		}
		case "FitH":
		case "FitBH": {
			const y = a ?? top;
			rect = [left, y, right, y];
			break;
		}
		case "FitV":
		case "FitBV": {
			const x = a ?? left;
			rect = [x, bottom, x, top];
			break;
		}
		case "FitR":
			rect = [a ?? left, b ?? bottom, c ?? right, d ?? top];
			break;
		default:
			throw new Error("Unknown PDF destination type");
	}
	return pageRectangle(viewport, rect);
}

export async function resolveDestination(
	pdf: PDFDocumentProxy,
	destination: Destination,
) {
	const dest =
		typeof destination === "string"
			? await pdf.getDestination(destination)
			: destination;
	if (!isDestination(dest)) throw new Error("Invalid PDF destination");
	const ref = dest[0];
	const index = typeof ref === "number" ? ref : await pdf.getPageIndex(ref);
	if (index < 0 || index >= pdf.numPages)
		throw new Error("Invalid PDF destination page");
	const page = await pdf.getPage(index + 1);
	return { page, point: destinationPoint(page, dest) };
}
