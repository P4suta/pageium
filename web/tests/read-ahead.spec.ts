import { expect, type Page, test } from "@playwright/test";
import { firstBookId, fixturePdf, withLibrary } from "./fixtures";

const paper = (page: Page, number: number) =>
	page.getByRole("group", { name: `Page ${number}`, exact: true });

async function resume(page: Page, url: string, number: number, total: number) {
	const id = await firstBookId(page.request, url);
	const saved = await page.request.put(`${url}/api/books/${id}/progress`, {
		data: { page: number, total },
	});
	expect(saved.ok()).toBe(true);
	await page.goto(`${url}/#book=${id}`);
	await expect(paper(page, number).locator("canvas").first()).toBeVisible();
	await page.getByRole("button", { name: "Reader controls" }).press("Enter");
	const fit = page.getByRole("button", { name: "Fit width" });
	await fit.click();
	await fit.press("Escape");
}

test.use({ viewport: { width: 900, height: 640 }, deviceScaleFactor: 2 });

test("bounds large prepared pages and upgrades their resolution on arrival", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1180, height: 640 });
	await withLibrary(["Large paper"], async (url) => {
		await resume(page, url, 1, 8);
		const next = paper(page, 2);
		const pixels = () =>
			next.evaluate((el) => {
				const canvas = el.querySelector("canvas");
				return canvas ? canvas.width * canvas.height : 0;
			});
		await expect.poll(pixels).toBeGreaterThan(4_180_000);
		expect(await pixels()).toBeLessThanOrEqual(4_194_304);
		const turn = await next.evaluate(async (el) => {
			el.scrollIntoView({ block: "start" });
			await new Promise(requestAnimationFrame);
			const canvas = el.querySelector("canvas");
			return canvas?.getContext("2d")?.getImageData(10, 10, 1, 1).data[3];
		});
		expect(turn).toBe(255);
		await expect.poll(pixels).toBeGreaterThan(6_000_000);
		expect(await pixels()).toBeLessThanOrEqual(8_388_608);
	});
});

test("prepares sharp paper before a page turn and reverses its bounded preview window", async ({
	page,
}) => {
	await withLibrary(
		["Reading ahead"],
		async (url) => {
			await resume(page, url, 10, 32);
			const next = paper(page, 11);
			await expect(next.locator("canvas")).toHaveCount(1);
			expect(
				await next.evaluate((el) => el.getBoundingClientRect().top),
			).toBeGreaterThanOrEqual(640);
			await expect(paper(page, 14).locator("img:not([hidden])")).toHaveCount(1);
			await expect(paper(page, 8).locator("img:not([hidden])")).toHaveCount(1);
			await expect(paper(page, 15).locator("img,canvas")).toHaveCount(0);
			await expect(paper(page, 7).locator("img,canvas")).toHaveCount(0);
			await expect
				.poll(() =>
					next.evaluate(
						(el) =>
							(el.querySelector("canvas")?.width ?? 0) /
							el.getBoundingClientRect().width,
					),
				)
				.toBeCloseTo(2, 2);

			const frames = await next.evaluate(async (el) => {
				const canvas = el.querySelector("canvas");
				const pane = el.closest("main");
				if (!(el instanceof HTMLElement) || !canvas || !pane)
					throw new Error("Missing prepared page");
				pane.scrollTop = el.offsetTop;
				const samples = [];
				for (let i = 0; i < 12; i++) {
					await new Promise(requestAnimationFrame);
					const ink = canvas.getContext("2d")?.getImageData(10, 10, 1, 1).data;
					samples.push({
						top: el.getBoundingClientRect().top,
						retained: el.querySelector("canvas") === canvas,
						status: el.getAttribute("data-status"),
						density: canvas.width / el.getBoundingClientRect().width,
						ink: Array.from(ink ?? []),
					});
				}
				return samples;
			});
			for (const frame of frames) {
				expect(frame.top).toBeLessThan(24);
				expect(frame.retained).toBe(true);
				expect(frame.status).toBeNull();
				expect(frame.density).toBeCloseTo(2, 2);
				expect(frame.ink).toEqual([38, 64, 76, 255]);
			}

			await paper(page, 22).evaluate((el) =>
				el.scrollIntoView({ block: "start" }),
			);
			await expect(paper(page, 26).locator("img:not([hidden])")).toHaveCount(1);
			await paper(page, 18).evaluate((el) =>
				el.scrollIntoView({ block: "start" }),
			);
			await expect(paper(page, 14).locator("img:not([hidden])")).toHaveCount(1);
			await expect(paper(page, 17).locator("canvas")).toHaveCount(1);
			await expect(paper(page, 20).locator("img:not([hidden])")).toHaveCount(1);
			await expect(paper(page, 21).locator("img,canvas")).toHaveCount(0);
			await expect(paper(page, 10).locator("img,canvas")).toHaveCount(0);
			expect(
				await page.locator(".pdf-page canvas").count(),
			).toBeLessThanOrEqual(3);
		},
		fixturePdf({ pages: 32, pagePadding: 90_000 }),
	);
});

test("continues reading ahead during a slow uninterrupted scroll", async ({
	page,
}) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await withLibrary(
		["Slow scroll"],
		async (url) => {
			await resume(page, url, 1, 20);
			const ready = await paper(page, 9).evaluate(async (el) => {
				const pane = el.closest("main");
				if (!(el instanceof HTMLElement) || !pane)
					throw new Error("Missing reader");
				const origin = el.offsetTop + 80;
				pane.scrollTop = origin;
				const start = performance.now();
				let ticks = 0;
				while (performance.now() - start < 3500) {
					await new Promise(requestAnimationFrame);
					pane.scrollTop = origin + 120 - Math.abs(120 - (++ticks % 240));
					const next = el.nextElementSibling;
					if (
						next &&
						next.getBoundingClientRect().top >=
							pane.getBoundingClientRect().bottom &&
						next.querySelector("canvas") &&
						el.querySelector("canvas") &&
						pane.querySelector('[aria-label="Page 13"] img:not([hidden])')
					)
						return true;
				}
				return false;
			});
			expect(ready).toBe(true);
		},
		fixturePdf({ pages: 20, pagePadding: 90_000 }),
	);
});

test("yields a blocked PDF range to the page selected by a jump", async ({
	page,
}) => {
	const pdf = fixturePdf({ pages: 28, pagePadding: 256_000 });
	const pageTen = pdf.indexOf("Reading sample 10)");
	expect(pageTen).toBeGreaterThan(0);
	const heldByte = pageTen + 128_000;
	await withLibrary(
		["Slow original"],
		async (url) => {
			let release = () => {};
			const held = new Promise<void>((done) => {
				release = done;
			});
			let pending = false;
			await page.route("**/api/books/*/pdf", async (route) => {
				const range = /^bytes=(\d+)-(\d+)$/.exec(
					route.request().headers().range ?? "",
				);
				if (
					range &&
					Number(range[1]) <= heldByte &&
					heldByte <= Number(range[2])
				) {
					pending = true;
					await held;
				}
				await route.continue();
			});
			try {
				await resume(page, url, 1, 28);
				await paper(page, 9).evaluate((el) =>
					el.scrollIntoView({ block: "start" }),
				);
				await expect(paper(page, 9).locator("canvas")).toHaveCount(1);
				await expect.poll(() => pending).toBe(true);
				await expect(paper(page, 10).locator("canvas")).toHaveCount(0);
				await paper(page, 22).evaluate((el) =>
					el.scrollIntoView({ block: "start" }),
				);
				await expect(paper(page, 22).locator("canvas")).toHaveCount(1);
				release();
				await expect(paper(page, 23).locator("canvas")).toHaveCount(1);
				await expect(paper(page, 10).locator("img,canvas")).toHaveCount(0);
			} finally {
				release();
			}
		},
		pdf,
	);
});

test("renders the next original through a stalled preview and prioritizes a distant page", async ({
	page,
}) => {
	await withLibrary(
		["Slow preview"],
		async (url) => {
			let release = () => {};
			const held = new Promise<void>((done) => {
				release = done;
			});
			const requests: number[] = [];
			await page.route("**/preview/*", async (route) => {
				const number = Number(route.request().url().split("/").at(-1));
				requests.push(number);
				if (number === 11) await held;
				await route.continue();
			});
			try {
				await resume(page, url, 1, 30);
				await paper(page, 10).evaluate((el) =>
					el.scrollIntoView({ block: "start" }),
				);
				await expect.poll(() => requests.includes(11)).toBe(true);
				await expect(paper(page, 11).locator("canvas")).toHaveCount(1);
				expect(requests.some((n) => n > 11)).toBe(false);
				await paper(page, 20).evaluate((el) =>
					el.scrollIntoView({ block: "start" }),
				);
				await expect(paper(page, 20).locator("canvas")).toHaveCount(1);
				await expect(paper(page, 24).locator("img:not([hidden])")).toHaveCount(
					1,
				);
				await expect(paper(page, 11).locator("img,canvas")).toHaveCount(0);
				expect(requests.some((n) => n > 11 && n < 18)).toBe(false);
			} finally {
				release();
			}
		},
		fixturePdf({ pages: 30, pagePadding: 90_000 }),
	);
});
