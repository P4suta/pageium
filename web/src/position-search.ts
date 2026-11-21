import { bookUrl } from "./api";
import type { TextMatch } from "./page-content";

type Hit = [page: number, start: number, length: number];

function readHits(value: unknown, pages: number): Hit[] | null {
	if (
		typeof value !== "object" ||
		!value ||
		!("pages" in value) ||
		value.pages !== pages ||
		!("hits" in value) ||
		!Array.isArray(value.hits)
	)
		return null;
	const hits: Hit[] = [];
	for (const hit of value.hits) {
		if (
			!Array.isArray(hit) ||
			hit.length !== 3 ||
			!hit.every(Number.isSafeInteger)
		)
			return null;
		const [page, start, length] = hit;
		if (page < 1 || page > pages || start < 0 || length < 1) return null;
		hits.push([page, start, length]);
	}
	return hits;
}

export class PositionSearch {
	#pending: AbortController | null = null;
	#query = "";
	#hits: Hit[] = [];
	#index = -1;
	active = false;

	constructor(
		readonly id: string,
		readonly pages: number,
		readonly currentPage: () => number,
		readonly reveal: (page: number) => void,
		readonly refresh: () => void,
		readonly report: (message: string) => void,
	) {}

	async search(
		query: string,
		again: boolean,
		previous: boolean,
	): Promise<boolean> {
		this.#pending?.abort();
		if (query !== this.#query) {
			const pending = new AbortController();
			this.#pending = pending;
			try {
				const response = await fetch(`${bookUrl(this.id)}/matches`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ query }),
					signal: AbortSignal.any([pending.signal, AbortSignal.timeout(8000)]),
				});
				if (!response.ok) return false;
				const hits = readHits(await response.json(), this.pages);
				if (!hits || pending.signal.aborted) return false;
				this.#hits = hits;
				this.#query = query;
			} catch {
				return false;
			}
			const page = this.currentPage();
			this.#index = previous
				? this.#hits.findLastIndex(([n]) => n <= page)
				: this.#hits.findIndex(([n]) => n >= page);
			if (this.#index < 0) this.#index = previous ? this.#hits.length - 1 : 0;
		} else if (again && this.#hits.length) {
			this.#index =
				(this.#index + (previous ? -1 : 1) + this.#hits.length) %
				this.#hits.length;
		}
		this.active = true;
		const hit = this.#hits[this.#index];
		const total = this.#hits.length;
		this.report(
			hit
				? `${this.#index + 1} of ${total} ${total === 1 ? "match" : "matches"}`
				: "No matches",
		);
		if (hit) this.reveal(hit[0]);
		this.refresh();
		return true;
	}

	match(page: number): TextMatch | null {
		const hit = this.#hits[this.#index];
		return hit?.[0] === page ? { start: hit[1], length: hit[2] } : null;
	}

	hide(): void {
		this.#pending?.abort();
		this.active = false;
	}
}
