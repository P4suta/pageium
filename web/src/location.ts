import { element, icon } from "./dom";

export interface ShelfLocation {
	folder: string;
	query: string;
}

export function shelfHref(
	{ folder, query }: ShelfLocation,
	book?: string,
): string {
	const params = new URLSearchParams();
	if (book) params.set("book", book);
	params.set("folder", folder);
	if (query) params.set("q", query);
	return `#${params}`;
}

export function backToShelf(location: ShelfLocation): HTMLAnchorElement {
	const link = element("a", "library-link");
	link.href = shelfHref(location);
	link.append(
		icon("arrow-left"),
		element("span", undefined, location.folder ? "Folder" : "Library"),
	);
	return link;
}
