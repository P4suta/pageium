export interface Position {
	page: number;
	total: number;
}

export interface Book {
	id: string;
	title: string;
	folder: string;
	progress: Position | null;
	duplicate_title: boolean;
}

type Pending = { status: "scanning" } | { status: "unavailable" };

export type Library =
	| Pending
	| {
			status: "ready";
			books: Book[];
			recent: string | null;
			revision: string;
			page: number;
			pages: number;
			total: number;
	  };

type BookLookup = Pending | { status: "ready"; book: Book };

export function isBookId(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPage(value: unknown): value is number {
	return isCount(value) && value > 0;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPosition(value: unknown): value is Position {
	return (
		isObject(value) &&
		isPage(value.page) &&
		isPage(value.total) &&
		value.page <= value.total
	);
}

function isBook(value: unknown): value is Book {
	return (
		isObject(value) &&
		isBookId(value.id) &&
		typeof value.title === "string" &&
		typeof value.folder === "string" &&
		typeof value.duplicate_title === "boolean" &&
		(value.progress === null || isPosition(value.progress))
	);
}

function parseLibrary(value: unknown): Library {
	if (!isObject(value)) {
		throw new Error("Invalid library response");
	}
	if (value.status === "scanning" || value.status === "unavailable") {
		return { status: value.status };
	}
	if (
		value.status === "ready" &&
		Array.isArray(value.books) &&
		value.books.every(isBook) &&
		isPage(value.page) &&
		isPage(value.pages) &&
		value.page <= value.pages &&
		isCount(value.total) &&
		isBookId(value.revision) &&
		(value.recent === null || isBookId(value.recent))
	) {
		return {
			status: "ready",
			books: value.books,
			recent: value.recent,
			revision: value.revision,
			page: value.page,
			pages: value.pages,
			total: value.total,
		};
	}
	throw new Error("Invalid library response");
}

export async function getLibrary(
	page: number,
	query: string,
	signal: AbortSignal,
	pin?: string,
): Promise<Library> {
	const filter = new URLSearchParams({ page: String(page) });
	if (query) filter.set("q", query);
	if (pin !== undefined) filter.set("pin", pin);
	const response = await fetch(`/api/library?${filter}`, { signal });
	if (!response.ok) {
		throw new Error("Library unavailable");
	}
	const value: unknown = await response.json();
	return parseLibrary(value);
}

export async function rescanLibrary(): Promise<void> {
	const response = await fetch("/api/library/scan", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "null",
	});
	if (response.status !== 204) throw new Error("Library scan failed");
}

export function bookUrl(id: string): string {
	return `/api/books/${encodeURIComponent(id)}`;
}

export async function getBook(
	id: string,
	signal: AbortSignal,
): Promise<BookLookup> {
	const response = await fetch(bookUrl(id), { signal });
	if (response.status === 404) return { status: "unavailable" };
	if (!response.ok) throw new Error("Book unavailable");
	const value: unknown = await response.json();
	if (isObject(value)) {
		if (value.status === "scanning" || value.status === "unavailable") {
			return { status: value.status };
		}
		if (
			value.status === "ready" &&
			isBook(value.book) &&
			value.book.id === id
		) {
			return { status: "ready", book: value.book };
		}
	}
	throw new Error("Invalid book response");
}

export async function savePosition(
	id: string,
	position: Position,
): Promise<void> {
	const response = await fetch(`${bookUrl(id)}/progress`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(position),
		keepalive: true,
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok) {
		throw new Error("Reading position unavailable");
	}
}

export function positionLabel({ page, total }: Position): string {
	return `Page ${page} of ${total}`;
}
