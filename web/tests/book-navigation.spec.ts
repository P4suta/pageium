import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";
import {
	annotatedBook,
	firstBookId,
	fixturePdf,
	withLibrary,
} from "./fixtures";

async function openBook(page: Page, url: string) {
	const id = await firstBookId(page.request, url);
	await page.goto(`${url}/#book=${id}`);
	await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
	return id;
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`matches the ${colorScheme} shelf and reader controls`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
		const width = colorScheme === "light" ? 768 : 390;
		await page.setViewportSize({
			width,
			height: 740,
		});
		await withLibrary(
			["Navigation"],
			async (url) => {
				await page.goto(url);
				const card = page.getByRole("link", { name: "Navigation" });
				await expect(card).toBeVisible();
				const surface = await card.evaluate((el) => {
					const style = getComputedStyle(el);
					return {
						fill: style.backgroundColor,
						ink: style.color,
						shadow: style.boxShadow,
					};
				});
				const fieldShadow = await page
					.locator(".shelf-search")
					.evaluate((el) => getComputedStyle(el).boxShadow);
				await card.click();
				await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
				await page.mouse.move(24, 4);
				const find = page.getByRole("button", { name: "Find in book" });
				const fit = page.getByRole("button", { name: "Fit width" });
				await expect(find).toHaveCSS(
					"box-shadow",
					await fit.evaluate((el) => getComputedStyle(el).boxShadow),
				);
				await expect(find).toHaveCSS(
					"border-radius",
					await fit.evaluate((el) => getComputedStyle(el).borderRadius),
				);
				await expect(find).toHaveCSS("color", surface.ink);
				expect(
					await page
						.locator(".page-position")
						.evaluate((el) => el.getBoundingClientRect().right),
				).toBeLessThanOrEqual(width);
				await find.click();
				const panel = page.getByRole("search", { name: "Find in book" });
				await expect(panel).toHaveCSS("background-color", surface.fill);
				await expect(panel).toHaveCSS("box-shadow", surface.shadow);
				await expect(panel.locator("label")).toHaveCSS(
					"box-shadow",
					fieldShadow,
				);
				const query = panel.getByRole("searchbox");
				await query.fill("OCR passage");
				const mark = page.locator(".page-text mark");
				await expect(mark).toHaveText("OCR passage");
				await expect(mark).toHaveCSS("outline-style", "solid");
				await expect(mark).not.toHaveCSS(
					"background-color",
					"rgba(0, 0, 0, 0)",
				);
				expect(
					await mark.evaluate(
						(el) => getComputedStyle(el, "::selection").color,
					),
				).toBe(surface.ink);
				const tint = await mark.evaluate(
					(el) => getComputedStyle(el).backgroundColor,
				);
				await page.evaluate(() =>
					document.documentElement.style.setProperty(
						"--accent",
						"rebeccapurple",
					),
				);
				await expect(mark).not.toHaveCSS("background-color", tint);
				await page.evaluate(() =>
					document.documentElement.style.removeProperty("--accent"),
				);
				await query.press("Escape");
				await page.mouse.move(24, 400);
				await page.mouse.move(24, 4);
				await page
					.getByRole("button", { name: "Contents", exact: true })
					.click();
				const contents = page.getByRole("navigation", { name: "Contents" });
				await expect(contents).toHaveCSS("background-color", surface.fill);
				await expect(contents).toHaveCSS("box-shadow", surface.shadow);
				await expect(contents.getByRole("link", { name: "Notes" })).toHaveCSS(
					"color",
					surface.ink,
				);
			},
			annotatedBook(),
		);
	});
}

test("finds Japanese across text runs and selects the OCR match on the next page", async ({
	page,
}) => {
	await withLibrary(
		["Bilingual notes"],
		async (url) => {
			const id = await firstBookId(page.request, url);
			const text = `${url}/api/books/${id}/text`;
			await expect
				.poll(async () => (await page.request.head(text)).status())
				.toBe(200);
			const payload = await page.request.get(text);
			expect(payload.headers()["content-type"]).toBe("application/gzip");
			const prepared = JSON.parse(gunzipSync(await payload.body()).toString());
			expect(prepared.pages).toHaveLength(3);
			expect(prepared.pages[0]).toContain("日本\n語");
			expect(prepared.pages[1]).toContain("OCR passage");
			expect(prepared.pages[2]).toBe("");
			let requests = 0;
			page.on("request", (request) => {
				if (request.url() === text) requests++;
			});
			await openBook(page, url);
			await page.keyboard.press("Control+f");
			const query = page.getByRole("searchbox", { name: "Find in book" });
			await expect(query).toBeFocused();
			expect(requests).toBe(0);
			await query.dispatchEvent("compositionstart");
			await query.fill("日本");
			await query.press("Enter");
			await expect(page.locator(".pdf-page mark")).toHaveCount(0);
			await query.fill("日本語");
			await query.dispatchEvent("compositionend", { data: "日本語" });
			await expect(page.getByText("1 of 2 matches")).toBeVisible();
			const first = page.getByRole("group", { name: "Page 1", exact: true });
			await expect(first.locator("mark")).toHaveText(["日本", "語"]);
			await query.press("Enter");
			await expect(page.getByText("2 of 2 matches")).toBeVisible();
			const second = page.getByRole("group", { name: "Page 2", exact: true });
			await expect(second.locator("mark")).toHaveText("日本語");
			await expect(second.locator("mark")).toBeInViewport();
			await query.press("Shift+Enter");
			await expect(first.locator("mark").first()).toBeInViewport();
			await page.getByRole("button", { name: "Next match" }).click();
			await expect(second.locator("mark")).toBeInViewport();
			await page.getByRole("button", { name: "Previous match" }).click();
			await expect(first.locator("mark").first()).toBeInViewport();
			await query.fill("no such passage");
			await expect(page.getByText("No matches", { exact: true })).toBeVisible();
			expect(requests).toBe(1);
			await query.press("Escape");
			await expect(query).toBeHidden();
			await expect(page.getByRole("main", { name: "PDF pages" })).toBeFocused();
			await page.keyboard.press("Meta+f");
			await expect(query).toBeFocused();
		},
		annotatedBook(),
	);
});

test("copies transparent text after zoom and reports a page with only an image", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 740 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await withLibrary(
		["Bilingual notes"],
		async (url) => {
			await openBook(page, url);
			await page.keyboard.press("Control+f");
			const query = page.getByRole("searchbox", { name: "Find in book" });
			await query.fill("OCR passage");
			expect((await query.boundingBox())?.width).toBeGreaterThan(120);
			await expect(page.locator(".pdf-page mark")).toBeInViewport();
			await query.press("Escape");
			await page.keyboard.press("+");
			await expect(page.locator(".reader-magnification")).toHaveText("1.5×");
			const text = page.getByText("OCR passage", { exact: true });
			await text.scrollIntoViewIfNeeded();
			const bounds = await text.boundingBox();
			const paper = await page
				.getByRole("group", { name: "Page 2", exact: true })
				.boundingBox();
			if (!bounds || !paper) throw new Error("Missing OCR text or page");
			expect(bounds.height).toBeGreaterThan(bounds.width * 3);
			expect((bounds.x - paper.x) / paper.width).toBeCloseTo(
				(610 - 80) / 660,
				1,
			);
			expect((bounds.y - paper.y) / paper.height).toBeCloseTo(
				(330 - 40) / 520,
				2,
			);
			const x = bounds.x + bounds.width / 2;
			await page.mouse.move(x, bounds.y + 1);
			await page.mouse.down();
			await page.mouse.move(x, bounds.y + bounds.height - 1, { steps: 12 });
			await page.mouse.up();
			await expect
				.poll(() => page.evaluate(() => getSelection()?.toString()))
				.toBe("OCR passage");
			await page.keyboard.press("ControlOrMeta+c");
			await page.evaluate(() => {
				const paste = document.createElement("textarea");
				paste.setAttribute("aria-label", "Clipboard check");
				document.body.prepend(paste);
				paste.focus({ preventScroll: true });
			});
			await page.keyboard.press("ControlOrMeta+v");
			await expect(
				page.getByRole("textbox", { name: "Clipboard check" }),
			).toHaveValue("OCR passage");
			await page
				.getByRole("group", { name: "Page 3", exact: true })
				.evaluate((el) => el.scrollIntoView());
			await page.keyboard.press("Control+f");
			await expect(
				page.getByText("No searchable text on this page"),
			).toBeVisible();
			await query.fill("Footnote");
			await expect(
				page.getByText("1 of 1 match", { exact: true }),
			).toBeVisible();
			await expect(page.locator(".pdf-page mark")).toBeInViewport();
		},
		annotatedBook(),
	);
});

test("follows nested contents and a footnote to the same point at reading zoom and resumes there", async ({
	page,
	context,
}) => {
	await page.setViewportSize({ width: 800, height: 520 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await withLibrary(
		["Bilingual notes"],
		async (url) => {
			const id = await openBook(page, url);
			await page.keyboard.press("+");
			await page.keyboard.press("+");
			await expect(page.locator(".reader-magnification")).toHaveText("2×");
			const first = page.getByRole("group", { name: "Page 1", exact: true });
			const reference = first.getByRole("link", { name: "Reference" });
			await expect(reference).toHaveAttribute("rel", /noopener/);
			await expect(first.getByRole("link", { name: "Email" })).toHaveCount(0);
			await context.route("https://example.org/reference", (route) =>
				route.fulfill({ body: "Reference" }),
			);
			const opened = context.waitForEvent("page");
			await reference.click();
			const external = await opened;
			await expect(external).toHaveURL("https://example.org/reference");
			await external.close();
			await first.getByRole("link", { name: "Footnote" }).click();
			const second = page.getByRole("group", { name: "Page 2", exact: true });
			const point = () =>
				second.evaluate((el) => {
					const rect = el.getBoundingClientRect();
					return {
						x: rect.left + (rect.width * 530) / 660,
						y: rect.top + (rect.height * 360) / 520,
					};
				});
			await expect(page.locator(".page-position")).toHaveText("Page 2 of 3");
			const note = await point();
			expect(note.x).toBeGreaterThanOrEqual(0);
			expect(note.x).toBeLessThan(800);
			expect(note.y).toBeGreaterThanOrEqual(0);
			expect(note.y).toBeLessThan(520);
			const sources = second.getByRole("link", { name: "Sources" });
			await expect(sources).toHaveAttribute(
				"href",
				"http://example.org/sources",
			);
			await expect(sources).toHaveAttribute("target", "_blank");
			const linkBox = await sources.boundingBox();
			const pageBox = await second.boundingBox();
			if (!linkBox || !pageBox) throw new Error("Missing rotated link");
			expect((linkBox.x - pageBox.x) / pageBox.width).toBeCloseTo(100 / 660, 3);
			expect((linkBox.y - pageBox.y) / pageBox.height).toBeCloseTo(80 / 520, 3);
			expect(linkBox.width / pageBox.width).toBeCloseTo(28 / 660, 3);
			expect(linkBox.height / pageBox.height).toBeCloseTo(45 / 520, 3);
			await page.mouse.move(30, 4);
			const contents = page.getByRole("button", {
				name: "Contents",
				exact: true,
			});
			await contents.click();
			const outline = page.getByRole("navigation", { name: "Contents" });
			await expect(outline.getByRole("list").getByRole("list")).toContainText(
				"Notes",
			);
			await outline.getByRole("link", { name: "Chapter" }).press("Enter");
			await expect(page.locator(".page-position")).toHaveText("Page 1 of 3");
			await page.mouse.move(30, 400);
			await page.mouse.move(30, 4);
			await contents.click();
			await outline.getByRole("link", { name: "Notes" }).press("Enter");
			await expect(outline).toBeHidden();
			await expect(page.locator(".page-position")).toHaveText("Page 2 of 3");
			expect((await point()).y).toBeCloseTo(note.y, 0);
			expect((await point()).x).toBeCloseTo(note.x, 0);
			await expect(page.locator(".reader-magnification")).toHaveText("2×");
			await expect
				.poll(
					async () =>
						(await (await page.request.get(`${url}/api/books/${id}`)).json())
							.book.progress?.page,
				)
				.toBe(2);
			await page.reload();
			await expect(page.locator(".page-position")).toHaveText("Page 2 of 3");
		},
		annotatedBook(),
	);
});

test("resumes the linked page when the last page shares the viewport", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await withLibrary(
		["Bilingual notes"],
		async (url) => {
			const id = await openBook(page, url);
			await page
				.getByRole("link", { name: "Footnote", exact: true })
				.press("Enter");
			await expect(
				page.getByRole("group", { name: "Page 3", exact: true }),
			).toBeInViewport();
			await expect(page.locator(".page-position")).toHaveText("Page 2 of 3");
			await expect
				.poll(
					async () =>
						(await (await page.request.get(`${url}/api/books/${id}`)).json())
							.book.progress?.page,
				)
				.toBe(2);
			await page.reload();
			await expect(
				page
					.getByRole("group", { name: "Page 2", exact: true })
					.locator("canvas")
					.first(),
			).toBeVisible();
			await expect(page.locator(".page-position")).toHaveText("Page 2 of 3");
			await page.getByRole("main", { name: "PDF pages" }).hover();
			await page.mouse.wheel(0, 840);
			await expect(page.locator(".page-position")).toHaveText("Page 3 of 3");
		},
		annotatedBook(),
	);
});

test("searches a copy-restricted book by position without serving its page text", async ({
	page,
}) => {
	const pdf = await readFile(new URL("./copy-restricted.pdf", import.meta.url));
	await withLibrary(
		["Restricted"],
		async (url) => {
			const id = await firstBookId(page.request, url);
			const base = `${url}/api/books/${id}`;
			await expect
				.poll(async () => (await page.request.head(`${base}/text`)).status())
				.toBe(204);
			expect(
				(await (await page.request.get(`${base}/text`)).body()).length,
			).toBe(0);
			const positions = await page.request.post(`${base}/matches`, {
				data: { query: "日本語" },
			});
			expect(positions.status()).toBe(200);
			expect(await positions.json()).toEqual({
				pages: 3,
				hits: [
					[1, 0, 3],
					[2, 11, 3],
				],
			});
			let queries = 0;
			page.on("request", (request) => {
				if (request.url().endsWith("/matches")) queries++;
			});
			await openBook(page, url);
			await page.keyboard.press("Control+f");
			const input = page.getByRole("searchbox", { name: "Find in book" });
			await input.fill("日本語");
			await expect(page.getByText("1 of 2 matches")).toBeVisible();
			await expect(page.locator(".page-text mark")).toHaveText(["日本", "語"]);
			await input.press("Enter");
			await expect(page.getByText("2 of 2 matches")).toBeVisible();
			await expect(page.locator(".page-text mark")).toHaveText("日本語");
			await input.press("Shift+Enter");
			await expect(page.getByText("1 of 2 matches")).toBeVisible();
			expect(queries).toBe(1);
			await input.fill("absent");
			await expect(page.getByText("No matches", { exact: true })).toBeVisible();
		},
		pdf,
	);
});

test("invalidates prepared text when a PDF is replaced", async ({
	request,
}) => {
	await withLibrary(["Revision"], async (url, books) => {
		const id = await firstBookId(request, url);
		const text = `${url}/api/books/${id}/text`;
		await expect
			.poll(async () => (await request.head(text)).status())
			.toBe(200);
		await writeFile(join(books, "Revision.pdf"), annotatedBook());
		expect((await request.get(text)).status()).toBe(404);
		expect(
			(
				await request.post(`${url}/api/library/scan`, {
					data: "null",
					headers: { "Content-Type": "application/json" },
				})
			).status(),
		).toBe(204);
		const replacement = await firstBookId(request, url);
		expect(replacement).not.toBe(id);
		const fresh = `${url}/api/books/${replacement}/text`;
		await expect
			.poll(async () => (await request.head(fresh)).status())
			.toBe(200);
		const payload = JSON.parse(
			gunzipSync(await (await request.get(fresh)).body()).toString(),
		);
		expect(payload.pages).toHaveLength(3);
		const db = new DatabaseSync(join(books, "../state/book-text.sqlite3"), {
			readOnly: true,
		});
		try {
			expect(db.prepare("SELECT book FROM prepared_pages").all()).toEqual([
				{ book: replacement },
			]);
		} finally {
			db.close();
		}
	});
});

test("counts matches without fetching distant PDF ranges on a fresh device", async ({
	page,
}) => {
	const pdf = fixturePdf({ pages: 28, pagePadding: 192_000 });
	const middle = pdf.indexOf("Reading sample 16)") + 110_000;
	await withLibrary(
		["Prepared book"],
		async (url) => {
			const id = await firstBookId(page.request, url);
			await expect
				.poll(async () =>
					(await page.request.head(`${url}/api/books/${id}/text`)).status(),
				)
				.toBe(200);
			let distant = false;
			await page.route(`**/${id}/pdf`, (route) => {
				const range = /^bytes=(\d+)-(\d+)$/.exec(
					route.request().headers().range ?? "",
				);
				if (range && Number(range[1]) <= middle && middle <= Number(range[2])) {
					distant = true;
					return route.abort();
				}
				return route.continue();
			});
			await openBook(page, url);
			await page.keyboard.press("Control+f");
			await page
				.getByRole("searchbox", { name: "Find in book" })
				.fill("Reading sample");
			await expect(page.getByText("1 of 28 matches")).toBeVisible();
			await expect(page.locator(".pdf-page mark")).toHaveText("Reading sample");
			expect(distant).toBe(false);
		},
		pdf,
	);
});

test("keeps an idle book partially loaded and drops a pending search when switching books", async ({
	page,
}) => {
	const pdf = fixturePdf({ pages: 28, pagePadding: 192_000 });
	const distantByte = pdf.indexOf("Reading sample 16)") + 110_000;
	await withLibrary(
		["First sample", "Second sample"],
		async (url) => {
			const id = await firstBookId(page.request, url);
			const { books } = await (
				await page.request.get(`${url}/api/library`)
			).json();
			const otherBook = books.find((book: { id: string }) => book.id !== id);
			await page.route(`**/api/books/${id}/text`, (route) =>
				route.fulfill({ status: 404 }),
			);
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let pending = false;
			let bytes = 0;
			page.on("response", (response) => {
				if (response.url().endsWith(`${id}/pdf`) && response.status() === 206)
					bytes += Number(response.headers()["content-length"]);
			});
			await page.route(`**/api/books/${id}/pdf`, async (route) => {
				const range = /^bytes=(\d+)-(\d+)$/.exec(
					route.request().headers().range ?? "",
				);
				if (
					range &&
					Number(range[1]) <= distantByte &&
					distantByte <= Number(range[2])
				) {
					pending = true;
					await held;
				}
				await route.continue();
			});
			try {
				await openBook(page, url);
				await page.mouse.move(30, 4);
				await page
					.getByRole("button", { name: "Contents", exact: true })
					.click();
				await expect(page.getByText("No contents in this book")).toBeVisible();
				await page.keyboard.press("Escape");
				await page.mouse.move(30, 400);
				await page.mouse.move(30, 4);
				await page.getByRole("button", { name: "Find in book" }).press("Enter");
				const query = page.getByRole("searchbox", { name: "Find in book" });
				await expect(query).toBeFocused();
				expect(pending).toBe(false);
				expect(bytes).toBeLessThan(pdf.length / 4);
				await query.fill("Reading sample");
				await expect.poll(() => pending).toBe(true);
				await expect(
					page.getByText(/^Searching… 1 of \d+ matches$/),
				).toBeVisible();
				await page.evaluate((other) => {
					location.hash = `book=${other}`;
				}, otherBook.id);
				await expect(page.locator(".reader-title")).toHaveText(otherBook.title);
				await expect(page.locator(".page-position")).toHaveText("Page 1 of 28");
				await page.keyboard.press("Control+f");
				await expect(query).toHaveValue("");
				release();
				await query.fill("sample 1");
				await expect(page.locator(".pdf-page mark").first()).toHaveText(
					"sample 1",
				);
				await expect(page.locator(".page-position")).toHaveText("Page 1 of 28");
			} finally {
				release();
			}
		},
		pdf,
	);
});
