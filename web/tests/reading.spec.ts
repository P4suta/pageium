import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { faxScan, fixturePdf, withLibrary } from "./fixtures";

const longTitle = "海辺の町を歩くための地図と季節の記録";
const titles = [
	"A Field Guide to Clouds",
	"The Shape of Quiet",
	"The Night Garden",
	longTitle,
];

async function returnToLibrary(page: Page): Promise<void> {
	const toggle = page.getByRole("button", { name: "Reader controls" });
	if (
		(await toggle.count()) > 0 &&
		(await toggle.getAttribute("aria-expanded")) === "false"
	) {
		await toggle.press("Enter");
	}
	await page.getByRole("link", { name: "Library", exact: true }).click();
}

test("paints the ink in a fax-compressed scan on the cover and page", async ({
	page,
}) => {
	await withLibrary(
		["Scan"],
		async (url) => {
			await page.goto(url);
			for (const selector of [".cover img", ".pdf-page canvas"]) {
				const canvas = page.locator(selector);
				await expect(canvas).toBeVisible();
				const levels = await canvas.evaluate((source) => {
					const node =
						source instanceof HTMLCanvasElement
							? source
							: document.createElement("canvas");
					if (source instanceof HTMLImageElement) {
						node.width = source.naturalWidth;
						node.height = source.naturalHeight;
						node.getContext("2d")?.drawImage(source, 0, 0);
					}
					const context = node.getContext("2d");
					if (!context) throw new Error("Missing canvas context");
					const pixel = (fraction: number) =>
						context.getImageData(
							node.width * fraction,
							node.height * fraction,
							1,
							1,
						).data[0];
					return [pixel(0.1), pixel(0.5)];
				});
				expect(levels).toEqual([255, 0]);
				if (selector === ".cover img")
					await page.getByRole("link", { name: "Scan" }).click();
			}
		},
		faxScan(),
	);
});

test("rescans the books folder from the library", async ({ page }) => {
	const pdf = fixturePdf({ pages: 3, pagePadding: 0 });
	await withLibrary(
		["The Shape of Quiet"],
		async (url, booksPath) => {
			await page.goto(url);
			const search = page.getByRole("searchbox", { name: "Search books" });
			const rescan = page.getByRole("button", { name: "Rescan library" });
			const retained = page.getByRole("link", { name: "The Shape of Quiet" });
			const added = page.getByRole("link", { name: "The Shape of Rain" });
			await expect(rescan).toBeVisible();
			await expect(retained).toBeVisible();
			await search.fill("Shape");
			await expect(retained).toBeVisible();
			await writeFile(join(booksPath, "The Shape of Rain.pdf"), pdf);
			await expect(added).toHaveCount(0);

			let release!: () => void;
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			let requests = 0;
			const endpoint = "**/api/library/scan";
			await page.route(endpoint, async (route) => {
				requests += 1;
				await pending;
				await route.continue();
			});
			try {
				await rescan.focus();
				await rescan.press("Enter");
				await expect(rescan).toBeDisabled();
				await expect(
					page.getByRole("status").filter({ hasText: "Scanning for PDFs" }),
				).toBeVisible();
				await expect(retained).toBeVisible();
				await rescan.press("Enter");
			} finally {
				release();
			}
			await expect(added).toBeVisible();
			expect(requests).toBe(1);
			await expect(search).toHaveValue("Shape");
			await expect(rescan).toBeEnabled();
			await expect(rescan).toBeFocused();
			await page.unroute(endpoint);

			const offline = `${booksPath}-offline`;
			await rename(booksPath, offline);
			await rescan.click();
			await expect(
				page.getByRole("status").filter({ hasText: "Could not rescan" }),
			).toBeVisible();
			await expect(added).toBeVisible();
			await expect(rescan).toBeEnabled();
			await rename(offline, booksPath);
			await rescan.click();
			await expect(
				page.getByRole("status").filter({ hasText: "Scan complete" }),
			).toBeVisible();
		},
		pdf,
	);
});

test("fills the cover frame and honors reduced motion", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await withLibrary(["The Shape of Quiet"], async (url) => {
		await page.goto(url);
		const canvas = page.locator(".cover img");
		await expect(canvas).toBeVisible();
		await expect(canvas).toHaveCSS("object-fit", "cover");
		await expect(canvas).not.toHaveCSS("animation-name", "none");
		const card = page.getByRole("link", { name: "The Shape of Quiet" });
		await card.hover();
		await expect(card).not.toHaveCSS("transform", "none");
		await expect(canvas).toHaveCSS("transform", "none");
		await page.emulateMedia({ reducedMotion: "reduce" });
		await expect(canvas).toHaveCSS("animation-name", "none");
		await page.getByRole("link", { name: "The Shape of Quiet" }).click();
		await expect(page.locator(".reader-header")).toHaveCSS(
			"animation-name",
			"none",
		);
	});
});

test("presses book cards and controls into the surface", async ({ page }) => {
	await page.emulateMedia({
		colorScheme: "light",
		reducedMotion: "no-preference",
	});
	await withLibrary(["The Shape of Quiet"], async (url) => {
		await page.goto(url);
		const card = page.getByRole("link", { name: "The Shape of Quiet" });
		const cover = card.locator("img");
		await expect(cover).toBeVisible();
		await card.hover();
		await expect(card).not.toHaveCSS("box-shadow", /inset/);
		const coverSize = () =>
			cover.evaluate((canvas) => {
				const { width, height } = canvas.getBoundingClientRect();
				return { width, height };
			});
		const restingSize = await coverSize();
		await page.mouse.down();
		await expect(card).toHaveCSS("box-shadow", /inset/);
		await expect(card).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 2)");
		const pressedSize = await coverSize();
		expect(pressedSize.width).toBeCloseTo(restingSize.width, 2);
		expect(pressedSize.height).toBeCloseTo(restingSize.height, 2);
		await page.mouse.up();
		const first = page.getByRole("group", { name: "Page 1", exact: true });
		await expect(first.locator("canvas")).toBeVisible();

		await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
		await page.mouse.move(240, 8);
		const fit = page.getByRole("button", { name: "Fit width" });
		await fit.hover();
		await expect(fit).not.toHaveCSS("box-shadow", /inset/);
		await page.mouse.down();
		await expect(fit).toHaveCSS("box-shadow", /inset/);
		await expect(fit).toHaveCSS("transform", "none");
		await page.mouse.up();
		await expect(fit).toHaveAttribute("aria-pressed", "true");
		await expect(fit).toHaveCSS("box-shadow", /inset/);

		await returnToLibrary(page);
		const rescan = page.getByRole("button", { name: "Rescan library" });
		await rescan.hover();
		await expect(rescan).not.toHaveCSS("box-shadow", /inset/);
		await page.mouse.down();
		await expect(rescan).toHaveCSS("box-shadow", /inset/);
		await expect(rescan).toHaveCSS("transform", "none");
		await page.mouse.up();
		await expect(rescan).not.toHaveCSS("box-shadow", /inset/);
	});
});

test("scrolls through a bounded shelf and restores the filter", async ({
	page,
}) => {
	const books = Array.from(
		{ length: 260 },
		(_, index) => `Sample ${String(index + 1).padStart(3, "0")}`,
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await withLibrary(
		books,
		async (url) => {
			await page.goto(url);
			await expect(page.getByRole("link")).toHaveCount(48);
			for (const name of [
				"Sample 049",
				"Sample 097",
				"Sample 145",
				"Sample 193",
				"Sample 241",
			]) {
				await page.evaluate(() =>
					window.scrollTo(0, document.documentElement.scrollHeight),
				);
				await expect(page.getByRole("link", { name })).toBeAttached();
			}
			await expect(page.getByRole("link", { name: "Sample 001" })).toHaveCount(
				0,
			);
			expect(await page.locator(".books .book").count()).toBeLessThanOrEqual(
				144,
			);
			const deepBook = page.getByRole("link", { name: /Sample 250/ });
			await deepBook.click();
			await expect(page.locator(".page-position")).toHaveText("Page 1 of 4");
			await returnToLibrary(page);
			await expect(deepBook).toBeFocused();
			await expect(deepBook).toBeInViewport();
			const search = page.getByRole("searchbox", { name: "Search books" });
			await search.fill("samPLE 110");
			await expect(page.getByRole("link")).toHaveCount(1);
			await expect(search).toBeFocused();
			await page.getByRole("link", { name: "Sample 110" }).click();
			await expect(
				page
					.getByRole("group", { name: "Page 1", exact: true })
					.locator("canvas"),
			).toBeVisible();
			await returnToLibrary(page);
			await expect(search).toHaveValue("samPLE 110");
			await expect(
				page.getByRole("link", { name: /Sample 110/ }),
			).toBeFocused();
			await search.clear();
			const distantBook = page.getByRole("link", { name: /Sample 035/ });
			await distantBook.click();
			await expect(page.locator(".page-position")).toHaveText("Page 1 of 4");
			await returnToLibrary(page);
			await expect(distantBook).toBeFocused();
			await expect(distantBook).toBeInViewport();
		},
		fixturePdf({ pages: 4, pagePadding: 0 }),
	);
});

test("renders new covers after leaving stalled thumbnails behind", async ({
	page,
}) => {
	const books = Array.from(
		{ length: 156 },
		(_, index) => `Scan ${String(index + 1).padStart(3, "0")}`,
	);
	await withLibrary(
		books,
		async (url) => {
			let held = 0;
			const catalog = async () =>
				(await page.request.get(`${url}/api/library`)).json();
			await expect.poll(async () => (await catalog()).status).toBe("ready");
			const { books: entries } = await catalog();
			const preview = await page.request.get(
				`${url}/api/books/${entries[0].id}/preview/1`,
			);
			expect(preview.ok()).toBe(true);
			const jpeg = await preview.body();
			let release = (): void => {};
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			await page.route("**/api/books/*/preview/1", async (route) => {
				if (held < 2) {
					held += 1;
					await blocked;
					await route.abort().catch(() => {});
				} else {
					await route.fulfill({ contentType: "image/jpeg", body: jpeg });
				}
			});
			try {
				await page.goto(url);
				await expect.poll(() => held).toBe(2);
				for (const name of ["Scan 049", "Scan 097", "Scan 145"]) {
					await page.evaluate(() =>
						window.scrollTo(0, document.documentElement.scrollHeight),
					);
					await expect(page.getByRole("link", { name })).toBeAttached();
				}
				const last = page.getByRole("link", { name: "Scan 156" });
				await last.scrollIntoViewIfNeeded();
				await expect(last.locator("img")).toBeVisible();
			} finally {
				release();
			}
		},
		fixturePdf({ pages: 3, pagePadding: 0 }),
	);
});

test("returns from a rapid seek while the final position is still saving", async ({
	page,
}) => {
	await withLibrary(
		["The Long Return"],
		async (url) => {
			let release = (): void => {};
			const writing = new Promise<void>((resolve) => {
				release = resolve;
			});
			await page.route("**/api/books/*/progress", async (route) => {
				await writing;
				await route.continue();
			});
			try {
				await page.goto(url);
				await page.getByRole("link", { name: "The Long Return" }).click();
				await expect(page.locator(".page-position")).toHaveText(
					"Page 1 of 128",
				);
				await page.locator(".reader-scroll").evaluate(async (area) => {
					for (const position of [0.8, 0.2, 0.9, 0.1, 0.95, 0.3, 1]) {
						area.scrollTop = area.scrollHeight * position;
						await new Promise<void>((done) =>
							requestAnimationFrame(() => done()),
						);
					}
				});
				await expect(page.locator(".page-position")).toHaveText(
					"Page 128 of 128",
				);
				await returnToLibrary(page);
				await expect(
					page.getByRole("heading", { name: "Library" }),
				).toBeVisible({ timeout: 1500 });
				await page.getByRole("link", { name: /The Long Return/ }).click();
				await expect(page.locator(".page-position")).toHaveText(
					"Page 128 of 128",
				);
			} finally {
				release();
			}
		},
		fixturePdf({ pages: 128, pagePadding: 0 }),
	);
});

test("opens a PDF at phone width, reads down, and resumes at the saved page", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await withLibrary(titles, async (url) => {
		let partial = 0;
		page.on("response", (response) => {
			if (response.url().endsWith("/pdf") && response.status() === 206)
				partial += 1;
		});
		await page.goto(url);
		const book = page.getByRole("link", { name: "The Shape of Quiet" });
		await expect(book).toBeVisible();
		await expect(book.locator("img")).toBeVisible();
		await expect(page.locator(".books")).toHaveCSS(
			"grid-template-columns",
			/^\d+(?:\.\d+)?px \d+(?:\.\d+)?px$/,
		);
		await page.screenshot({ path: info.outputPath("iphone-library.png") });

		await book.click();
		await expect(
			page.getByRole("heading", { name: "The Shape of Quiet" }),
		).toBeAttached();
		await expect(
			page
				.getByRole("group", { name: "Page 1", exact: true })
				.locator("canvas"),
		).toBeVisible();
		await expect(page.locator(".page-position")).toHaveText("Page 1 of 8");
		await page.screenshot({ path: info.outputPath("iphone-reader.png") });
		await page.locator(".reader-scroll").evaluate((area) => {
			const third = area.querySelector<HTMLElement>("[aria-label='Page 3']");
			if (!third) throw new Error("Missing third page");
			area.scrollTop = third.offsetTop;
		});
		await expect(page.locator(".page-position")).toHaveText("Page 3 of 8");
		await returnToLibrary(page);
		await expect(page.getByText("Continue reading")).toBeVisible();
		await expect(page.getByText("Page 3 of 8")).toBeVisible();
		await page.reload();
		await page.getByRole("link", { name: /The Shape of Quiet/ }).click();
		await expect(page.locator(".page-position")).toHaveText("Page 3 of 8");
		await expect(
			page
				.getByRole("group", { name: "Page 3", exact: true })
				.locator("canvas"),
		).toBeVisible();
		await page.locator(".reader-scroll").evaluate((area) => {
			area.scrollTop = area.scrollHeight;
		});
		await expect(page.locator(".page-position")).toHaveText("Page 8 of 8");
		expect(partial).toBeGreaterThan(0);
	});
});

test("fits a whole page and keeps the controls out of the reading area", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1200, height: 550 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await withLibrary(["The Shape of Quiet"], async (url) => {
		await page.goto(url);
		await page.getByRole("link", { name: "The Shape of Quiet" }).click();
		const reader = page.getByRole("main", { name: "PDF pages" });
		const header = page.locator(".reader-header");
		const first = page.getByRole("group", { name: "Page 1", exact: true });
		const toggle = page.getByRole("button", { name: "Reader controls" });
		const library = page.getByRole("link", { name: "Library", exact: true });
		await expect(first.locator("canvas")).toBeVisible();

		const viewport = await reader.evaluate((area) => area.clientHeight);
		const fitted = await first.evaluate(
			(surface) => surface.getBoundingClientRect().height,
		);
		expect(viewport).toBe(550);
		expect(fitted).toBeGreaterThan(500);
		expect(fitted).toBeLessThanOrEqual(viewport);
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await expect(toggle).toHaveCSS("pointer-events", "none");
		await expect(library).toBeHidden();

		await page.keyboard.press("Tab");
		await expect(toggle).toBeFocused();
		await expect(toggle).toHaveCSS("pointer-events", "auto");
		await reader.evaluate(() => {
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
		});
		await page.mouse.move(240, 8);
		await expect(library).toBeVisible();
		const headerBottom = await header.evaluate(
			(panel) => panel.getBoundingClientRect().bottom,
		);
		const lowerHeader = Math.floor(headerBottom) - 4;
		await page.mouse.move(240, lowerHeader);
		await expect(library).toBeVisible();
		await page.mouse.move(240, 300);
		await expect(library).toBeHidden();
		await page.mouse.move(240, headerBottom + 12);
		await expect(library).toBeVisible();
		await expect(header).toHaveCSS("animation-name", "none");
		await expect(header).toHaveCSS("transition-duration", "0s");
		await page.keyboard.press("Escape");
		await expect(library).toBeHidden();
		await page.mouse.move(260, 8);
		await expect(library).toBeHidden();
		await page.mouse.move(240, 300);
		await page.mouse.move(240, 8);
		await expect(library).toBeVisible();
		await page.mouse.move(240, 300);
		await expect(library).toBeHidden();

		await first.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(library).toBeVisible();
		expect(await reader.evaluate((area) => area.clientHeight)).toBe(viewport);
		const fit = page.getByRole("button", { name: "Fit width" });
		await fit.click();
		await expect(fit).toHaveAttribute("aria-pressed", "true");
		await expect
			.poll(() => first.evaluate((surface) => surface.clientHeight))
			.toBeGreaterThan(viewport);
		await fit.press("Escape");
		await expect(toggle).toBeFocused();
		await expect(library).toBeHidden();

		await toggle.press("Enter");
		await expect(library).toBeVisible();
		await expect(library).toBeFocused();
		await reader.focus();
		await reader.hover();
		await page.mouse.wheel(0, 200);
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
	});
});

test("slides the reader header in and out through the top edge", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1200, height: 550 });
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await withLibrary(["The Shape of Quiet"], async (url) => {
		await page.goto(url);
		await page.getByRole("link", { name: "The Shape of Quiet" }).click();
		const header = page.locator(".reader-header");
		const library = page.getByRole("link", { name: "Library", exact: true });
		await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
		await expect(library).toBeHidden();
		await page.addStyleTag({
			content:
				".reader--reading .reader-header { --reader-header-duration: 1s; }",
		});

		const bounds = (finish = true) =>
			header.evaluate(async (panel, finish) => {
				const animations = panel.getAnimations();
				if (!animations.length)
					throw new Error("Reader header motion unavailable");
				for (const animation of animations) animation.pause();
				await Promise.all(animations.map((animation) => animation.ready));
				for (const animation of animations) animation.currentTime = 0;
				const begin = Math.round(panel.getBoundingClientRect().bottom);
				for (const animation of animations) {
					const duration = animation.effect?.getComputedTiming().activeDuration;
					if (typeof duration !== "number")
						throw new Error("Missing motion duration");
					animation.currentTime = duration / 2;
				}
				const middle = Math.round(panel.getBoundingClientRect().bottom);
				if (finish) {
					for (const animation of animations) animation.finish();
				}
				const { bottom, height } = panel.getBoundingClientRect();
				return {
					begin,
					middle,
					end: Math.round(bottom),
					height: Math.round(height),
				};
			}, finish);

		await page.mouse.move(240, 8);
		await expect(library).toBeVisible();
		const opening = await bounds();
		expect(opening.begin).toBe(0);
		expect(opening.middle).toBeGreaterThan(0);
		expect(opening.middle).toBeLessThan(opening.height);
		expect(opening.end).toBe(opening.height);

		await page.mouse.move(240, 300);
		const closing = await bounds(false);
		expect(closing.begin).toBe(closing.height);
		expect(closing.middle).toBeGreaterThan(0);
		expect(closing.middle).toBeLessThan(closing.height);
		await expect(header.locator(".reader-actions")).toHaveAttribute(
			"inert",
			"",
		);
		await expect(header.locator(".reader-actions")).toHaveCSS(
			"visibility",
			"visible",
		);

		await page.mouse.move(240, 8);
		const reopening = await bounds();
		expect(reopening.begin).toBe(closing.middle);
		expect(reopening.end).toBe(reopening.height);

		await page.keyboard.press("Escape");
		expect((await bounds()).end).toBe(0);
		await expect(library).toBeHidden();
	});
});

test("starts closing the reader header when the pointer leaves the viewport", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1200, height: 550 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await withLibrary(["The Shape of Quiet"], async (url) => {
		await page.goto(url);
		await page.getByRole("link", { name: "The Shape of Quiet" }).click();
		const reader = page.locator(".reader");
		const toggle = page.getByRole("button", { name: "Reader controls" });
		const library = page.getByRole("link", { name: "Library", exact: true });
		await expect(reader.locator(".pdf-page canvas").first()).toBeVisible();
		await page.mouse.move(240, 8);
		await expect(library).toBeVisible();
		await reader.dispatchEvent("pointerleave", {
			pointerType: "mouse",
			clientY: -1,
		});
		expect(await toggle.getAttribute("aria-expanded")).toBe("false");
		await expect(library).toBeHidden();
		await page.mouse.move(248, 8);
		expect(await toggle.getAttribute("aria-expanded")).toBe("true");
		await expect(library).toBeVisible();
	});
});

test("toggles the reader controls by tapping a page", async ({ browser }) => {
	const page = await browser.newPage({
		hasTouch: true,
		viewport: { width: 390, height: 844 },
	});
	try {
		await withLibrary(["The Shape of Quiet"], async (url) => {
			await page.goto(url);
			await page.getByRole("link", { name: "The Shape of Quiet" }).tap();
			const first = page.getByRole("group", { name: "Page 1", exact: true });
			const library = page.getByRole("link", { name: "Library", exact: true });
			await expect(first.locator("canvas")).toBeVisible();
			await expect(library).toBeHidden();
			await first.tap();
			await expect(library).toBeVisible();
			await first.tap();
			await expect(library).toBeHidden();
		});
	} finally {
		await page.close();
	}
});

test("keeps the paper under a fast scroll across pages and back while zoomed", async ({
	page,
}) => {
	await page.setViewportSize({ width: 820, height: 600 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await withLibrary(
		["Mixed pages"],
		async (url) => {
			await page.goto(url);
			await page.locator(".book").click();
			await expect(
				page
					.getByRole("group", { name: "Page 1", exact: true })
					.locator("canvas")
					.first(),
			).toBeVisible();
			await page.keyboard.press("+");
			await page.keyboard.press("+");
			const pane = page.locator(".reader-scroll");
			const samples = await pane.evaluate(async (area) => {
				const errors: number[] = [];
				const pages = new Set<string>();
				const x = innerWidth / 2,
					y = innerHeight / 2;
				for (let frame = 0; frame < 66; frame++) {
					const delta = frame < 38 ? 118 : -118;
					const paper = document.elementFromPoint(x, y)?.closest(".pdf-page");
					const rect = paper?.getBoundingClientRect();
					area.scrollBy(0, delta);
					await new Promise(requestAnimationFrame);
					if (!paper || !rect) continue;
					pages.add(paper.getAttribute("aria-label") ?? "");
					const after = paper.getBoundingClientRect();
					const fraction = (y - rect.top) / rect.height;
					errors.push(
						Math.abs(after.top + fraction * after.height - (y - delta)),
					);
				}
				return { errors, pages: [...pages] };
			});
			expect(samples.errors.length).toBeGreaterThan(50);
			expect(samples.pages.length).toBeGreaterThan(3);
			expect(Math.max(...samples.errors)).toBeLessThan(2);
		},
		fixturePdf({ pages: 14, landscape: [3, 6], pagePadding: 0 }),
	);
});

test("settles near fitted page starts in both directions and scrolls freely inside a tall page", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await withLibrary(["The Shape of Quiet"], async (url) => {
		await page.goto(url);
		await page.getByRole("link", { name: "The Shape of Quiet" }).click();
		const reader = page.getByRole("main", { name: "PDF pages" });
		const first = page.getByRole("group", { name: "Page 1", exact: true });
		const second = page.getByRole("group", { name: "Page 2", exact: true });
		await expect(first.locator("canvas")).toBeVisible();
		const fourth = page.getByRole("group", { name: "Page 4", exact: true });
		const start = await second.evaluate(
			(surface: HTMLElement) => surface.offsetTop,
		);
		const later = await fourth.evaluate(
			(surface: HTMLElement) => surface.offsetTop,
		);
		await reader.hover();
		await page.mouse.wheel(0, start - 24);
		await expect
			.poll(() => reader.evaluate((area) => Math.round(area.scrollTop)))
			.toBe(start);
		await expect(page.locator(".page-position")).toHaveText("Page 2 of 8");
		await page.mouse.wheel(0, later - start - 18);
		await expect
			.poll(() => reader.evaluate((area) => Math.round(area.scrollTop)))
			.toBe(later);
		await page.mouse.wheel(0, start - later + 24);
		await expect
			.poll(() => reader.evaluate((area) => Math.round(area.scrollTop)))
			.toBe(start);

		await page.setViewportSize({ width: 1200, height: 550 });
		await page.getByRole("button", { name: "Reader controls" }).press("Enter");
		const fit = page.getByRole("button", { name: "Fit width" });
		await fit.click();
		await expect(fit).toHaveAttribute("aria-pressed", "true");
		await fit.press("Escape");
		await reader.evaluate(async (area) => {
			await new Promise<void>((done) =>
				requestAnimationFrame(() => requestAnimationFrame(() => done())),
			);
			area.scrollTo(0, 0);
		});
		await expect(first.locator("canvas")).toBeVisible();
		const height = await first.evaluate((surface) => surface.clientHeight);
		const visible = await reader.evaluate((area) => area.clientHeight);
		const middle = Math.floor((height - visible) / 2);
		expect(middle).toBeGreaterThan(100);
		await reader.hover();
		await page.mouse.wheel(0, 20);
		await expect
			.poll(() => reader.evaluate((area) => Math.round(area.scrollTop)))
			.toBe(20);
		await page.mouse.wheel(0, middle - 20);
		await expect
			.poll(() => reader.evaluate((area) => Math.round(area.scrollTop)))
			.toBe(middle);
		await expect(page.locator(".page-position")).toHaveText("Page 1 of 8");

		await page.emulateMedia({ reducedMotion: "reduce" });
		await expect(reader).toHaveCSS("scroll-snap-type", "none");
	});
});

for (const mode of ["reader zoom", "reduced motion"] as const) {
	test(`keeps a near-boundary stop while reading with ${mode}`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 480, height: 720 });
		await page.emulateMedia({
			reducedMotion: mode === "reader zoom" ? "no-preference" : "reduce",
		});
		await withLibrary(["Book"], async (url) => {
			await page.goto(url);
			await page.getByRole("link", { name: "Book", exact: true }).click();
			const reader = page.getByRole("main", { name: "PDF pages" });
			await expect(reader.locator("canvas").first()).toBeVisible();
			if (mode === "reader zoom") {
				await page.keyboard.press("+");
				await expect(page.locator(".reader-magnification")).toHaveText("1.5×");
			}
			const paper = page.getByRole("group", { name: "Page 2", exact: true });
			const target = await paper.evaluate(
				(el: HTMLElement) => el.offsetTop - 24,
			);
			const before = await reader.evaluate((area) => area.scrollTop);
			await reader.hover();
			await page.mouse.wheel(0, target - before);
			await expect
				.poll(() => reader.evaluate((area) => area.scrollTop))
				.toBe(target);
			const drift = await reader.evaluate(async (area, target) => {
				let drift = 0;
				for (let frame = 0; frame < 30; frame++) {
					await new Promise(requestAnimationFrame);
					drift = Math.max(drift, Math.abs(area.scrollTop - target));
				}
				return drift;
			}, target);
			expect(drift).toBeLessThan(1);
		});
	});
}

test("holds the reading point on returning to fit and snaps on the next page turn", async ({
	page,
}) => {
	await page.setViewportSize({ width: 820, height: 600 });
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await withLibrary(["Book"], async (url) => {
		await page.goto(url);
		await page.getByRole("link", { name: "Book", exact: true }).click();
		const reader = page.getByRole("main", { name: "PDF pages" });
		await expect(reader.locator("canvas").first()).toBeVisible();
		await page.keyboard.press("+");
		await expect(page.locator(".reader-magnification")).toHaveText("1.5×");
		const paper = page.getByRole("group", { name: "Page 2", exact: true });
		const expectedTop = await paper.evaluate((sheet) => {
			const pane = sheet.closest("main");
			if (!pane) throw new Error("Missing reading area");
			const center = pane.getBoundingClientRect().top + pane.clientHeight / 2;
			const fittedTop =
				pane.getBoundingClientRect().top +
				parseFloat(getComputedStyle(pane).paddingTop) -
				24;
			const zoomedTop = center - 1.5 * (center - fittedTop);
			pane.scrollBy(0, sheet.getBoundingClientRect().top - zoomedTop);
			return fittedTop;
		});
		await expect(paper.locator("canvas").first()).toBeVisible();
		await page.keyboard.press("0");
		await expect(page.locator(".reader-magnification")).toHaveText("1×");
		const drift = await paper.evaluate(async (sheet, top) => {
			let drift = 0;
			for (let frame = 0; frame < 30; frame++) {
				await new Promise(requestAnimationFrame);
				drift = Math.max(
					drift,
					Math.abs(sheet.getBoundingClientRect().top - top),
				);
			}
			return drift;
		}, expectedTop);
		expect(drift).toBeLessThan(2);
		const next = await page
			.getByRole("group", { name: "Page 3", exact: true })
			.evaluate((el: HTMLElement) => el.offsetTop);
		const current = await reader.evaluate((pane) => pane.scrollTop);
		await reader.hover();
		await page.mouse.wheel(0, next - current - 24);
		await expect
			.poll(() => reader.evaluate((pane) => Math.round(pane.scrollTop)))
			.toBe(next);
	});
});

test("fits the tablet grid and the narrow dark shelf", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 834, height: 1194 });
	await withLibrary(titles, async (url) => {
		await page.goto(url);
		await expect(page.getByRole("link")).toHaveCount(4);
		await expect(page.locator(".books")).toHaveCSS(
			"grid-template-columns",
			/^(?:\d+(?:\.\d+)?px ){3}\d+(?:\.\d+)?px$/,
		);
		await expect(page.locator(".cover img")).toHaveCount(4);
		await page.screenshot({ path: info.outputPath("ipad-library.png") });
		await page.setViewportSize({ width: 320, height: 844 });
		await page.emulateMedia({ colorScheme: "dark" });
		const book = page.getByRole("link", { name: longTitle });
		await book.focus();
		await expect(book).toHaveCSS("outline-width", "3px");
		const geometry = await page.locator("body").evaluate((body) => ({
			content: body.scrollWidth,
			viewport: document.documentElement.clientWidth,
		}));
		expect(geometry.content).toBeLessThanOrEqual(geometry.viewport);
		await expect(page.locator("html")).toHaveCSS(
			"background-color",
			"rgb(36, 33, 43)",
		);
		await page.screenshot({ path: info.outputPath("narrow-dark.png") });
	});
});

test("renders the first page of a large PDF with partial responses", async ({
	page,
}) => {
	const pdf = fixturePdf({ pages: 24, pagePadding: 256_000 });
	const title = "A Large Reading Sample";
	await withLibrary(
		[title],
		async (url) => {
			await page.setViewportSize({ width: 390, height: 844 });
			await page.goto(url);
			const book = page.getByRole("link", { name: title });
			await expect(book.locator("img")).toBeVisible();
			let partialBytes = 0;
			page.on("response", (response) => {
				if (response.url().endsWith("/pdf") && response.status() === 206) {
					partialBytes += Number(response.headers()["content-length"]);
				}
			});
			await book.click();
			await expect(
				page
					.getByRole("group", { name: "Page 1", exact: true })
					.locator("canvas"),
			).toBeVisible();
			expect(partialBytes).toBeGreaterThan(0);
			expect(partialBytes).toBeLessThan(pdf.length / 4);
		},
		pdf,
	);
});

test("shows an empty shelf and returns from an unreadable file", async ({
	page,
}) => {
	await withLibrary([], async (url) => {
		await page.goto(url);
		await expect(
			page.getByRole("heading", { name: "No books yet" }),
		).toBeVisible();
	});
	await withLibrary(["Broken PDF"], async (url) => {
		await page.goto(url);
		await page.getByRole("link", { name: "Broken PDF" }).click();
		await expect(
			page.getByRole("heading", { name: "PDF unavailable" }),
		).toBeVisible();
		await returnToLibrary(page);
		await expect(page.getByRole("link", { name: "Broken PDF" })).toBeVisible();
	});
});

test("leaving a reader while the PDF module loads cancels its document request", async ({
	page,
}) => {
	await withLibrary(["The Shape of Quiet", "Another book"], async (url) => {
		let release = (): void => {};
		const waitForRelease = new Promise<void>((resolve) => {
			release = resolve;
		});
		const documentLoads: string[] = [];
		page.on("request", (request) => {
			if (request.url().endsWith("/pdf")) documentLoads.push(request.url());
		});
		await page.route("**/assets/pdf-*.js", async (route) => {
			await waitForRelease;
			await route.continue();
		});
		try {
			await page.goto(url);
			const book = page.getByRole("link", { name: "The Shape of Quiet" });
			const cancelled = `${url}/api/books/${await book.getAttribute("id")}/pdf`;
			await book.click();
			await expect(
				page.getByRole("group", { name: "Page 1", exact: true }),
			).toBeVisible();
			await returnToLibrary(page);
			await expect(book).toBeVisible();
			expect(documentLoads).not.toContain(cancelled);
			release();
			const other = page.getByRole("link", { name: "Another book" });
			const opened = `${url}/api/books/${await other.getAttribute("id")}/pdf`;
			await other.click();
			await expect(
				page
					.getByRole("group", { name: "Page 1", exact: true })
					.locator("canvas")
					.first(),
			).toBeVisible();
			expect(documentLoads).toContain(opened);
			expect(documentLoads).not.toContain(cancelled);
		} finally {
			release();
		}
	});
});
