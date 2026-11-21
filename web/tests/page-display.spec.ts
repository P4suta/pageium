import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { firstBookId, fixturePdf, ruledScan, withLibrary } from "./fixtures";

test("paints the whole landscape original during continuous scrolling without a preview", async ({
	page,
}) => {
	await page.setViewportSize({ width: 800, height: 600 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.route("**/preview/*", (route) => route.fulfill({ status: 503 }));
	await withLibrary(
		["Mixed paper"],
		async (url) => {
			await page.goto(url);
			await page.locator(".book").click();
			await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
			const target = page.getByRole("group", { name: "Page 8", exact: true });
			const sample = await target.evaluate(async (paper: HTMLElement) => {
				const pane = paper.closest("main");
				if (!pane) throw new Error("Missing reading area");
				pane.scrollTop = paper.offsetTop;
				for (let frame = 0; frame < 90; frame++) {
					pane.scrollBy(0, 1);
					await new Promise(requestAnimationFrame);
					const canvas = paper.querySelector("canvas");
					if (!canvas) continue;
					return {
						placeholder: paper.clientHeight > paper.clientWidth,
						ratio: canvas.width / canvas.height,
						ink: canvas
							.getContext("2d")
							?.getImageData(canvas.width / 8, canvas.height * 0.85, 1, 1)
							.data[0],
					};
				}
				throw new Error("The original did not appear while scrolling");
			});
			expect(sample.placeholder).toBe(true);
			expect(sample.ratio).toBeCloseTo(780 / 600, 2);
			expect(sample.ink).toBeLessThan(95);
			await expect
				.poll(() => target.evaluate((el) => el.clientWidth / el.clientHeight))
				.toBeCloseTo(780 / 600, 2);
		},
		fixturePdf({ pages: 12, pagePadding: 0, landscape: [8] }),
	);
});

test("pans to the far edge of a magnified landscape neighbor while reading a portrait page", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1080, height: 600 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await withLibrary(
		["Mixed paper"],
		async (url) => {
			await page.goto(url);
			await page.locator(".book").click();
			const landscape = page.getByRole("group", {
				name: "Page 2",
				exact: true,
			});
			await expect
				.poll(() =>
					landscape.evaluate((el) => el.clientWidth > el.clientHeight),
				)
				.toBe(true);
			for (let step = 0; step < 6; step++) await page.keyboard.press("+");
			const first = page.getByRole("group", { name: "Page 1", exact: true });
			await first.evaluate((paper: HTMLElement) => {
				const pane = paper.closest("main");
				if (pane)
					pane.scrollTo(
						0,
						paper.offsetTop + paper.clientHeight - pane.clientHeight / 2,
					);
			});
			await expect(page.locator(".page-position")).toHaveText("Page 1 of 4");
			await expect(landscape).toBeInViewport();
			await expect
				.poll(() =>
					landscape.evaluate((el) => {
						const pane = el.closest("main");
						if (!pane) throw new Error("Missing reading area");
						pane.scrollLeft = pane.scrollWidth;
						return (
							el.getBoundingClientRect().right -
							pane.getBoundingClientRect().right
						);
					}),
				)
				.toBeLessThanOrEqual(1);
		},
		fixturePdf({ pages: 4, pagePadding: 0, landscape: [2] }),
	);
});

test("keeps the newly reached page when the scroll pane resizes before the next frame", async ({
	page,
}) => {
	await page.setViewportSize({ width: 900, height: 640 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await withLibrary(["Paper"], async (url) => {
		await page.goto(url);
		await page.locator(".book").click();
		await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
		const target = page.getByRole("group", { name: "Page 4", exact: true });
		await target.evaluate((el: HTMLElement) => {
			const pane = el.closest("main");
			if (!pane) throw new Error("Missing reading area");
			pane.scrollTop = el.offsetTop + el.clientHeight / 3;
			pane.style.blockSize = "400px";
		});
		await expect(page.locator(".page-position")).toHaveText("Page 4 of 8");
		await expect
			.poll(() =>
				target.evaluate(
					(el: HTMLElement) =>
						((el.closest("main")?.scrollTop ?? 0) - el.offsetTop) /
						el.clientHeight,
				),
			)
			.toBeCloseTo(1 / 3, 2);
	});
});

for (const zoom of [1, 2]) {
	test(`holds the reading position at ${zoom}× through a delayed landscape preview and a scroll reversal`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 720, height: 500 });
		await page.addInitScript(() => {
			const decode = HTMLImageElement.prototype.decode;
			const ready = new Promise<void>((done) =>
				window.addEventListener("display-landscape", () => done(), {
					once: true,
				}),
			);
			HTMLImageElement.prototype.decode = async function () {
				await decode.call(this);
				if (this.src.endsWith("/preview/6")) await ready;
			};
		});
		await withLibrary(
			["Mixed pages"],
			async (url) => {
				await page.goto(url);
				await page.locator(".book").click();
				await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
				await page
					.getByRole("button", { name: "Reader controls" })
					.press("Enter");
				const fit = page.getByRole("button", { name: "Fit width" });
				await fit.click();
				await fit.press("Escape");
				if (zoom === 2) {
					await page.emulateMedia({ reducedMotion: "reduce" });
					await page.keyboard.press("+");
					await page.keyboard.press("+");
				}
				const current = page.getByRole("group", {
					name: "Page 8",
					exact: true,
				});
				await current.evaluate((el) => {
					if (!(el instanceof HTMLElement)) throw new Error("Missing paper");
					el.closest("main")?.scrollTo(0, el.offsetTop + 160);
				});
				await expect(current.locator("canvas").first()).toBeVisible();
				const previous = page.getByRole("group", {
					name: "Page 6",
					exact: true,
				});
				await expect
					.poll(() =>
						previous
							.locator("img")
							.evaluate(
								(img) =>
									img instanceof HTMLImageElement &&
									img.complete &&
									img.naturalWidth > img.naturalHeight,
							),
					)
					.toBe(true);
				expect(
					await previous.evaluate((el) => el.clientWidth < el.clientHeight),
				).toBe(true);
				const samples = await current.evaluate(async (el) => {
					const pane = el.closest("main");
					const previous = el.previousElementSibling?.previousElementSibling;
					if (!pane || !previous) throw new Error("Missing reading area");
					const initialTop = el.getBoundingClientRect().top;
					const initialHeight = previous.clientHeight;
					let travel = 0;
					const errors = [];
					const heights = [];
					for (let frame = 0; frame < 18; frame++) {
						const delta = frame < 9 ? 10 : -8;
						pane.scrollBy(0, delta);
						travel += delta;
						if (frame === 3)
							window.dispatchEvent(new Event("display-landscape"));
						await new Promise(requestAnimationFrame);
						errors.push(
							Math.abs(el.getBoundingClientRect().top - initialTop + travel),
						);
						heights.push(previous.clientHeight - initialHeight);
					}
					return { errors, heights, expectedTop: initialTop - travel };
				});
				expect(Math.max(...samples.errors)).toBeLessThan(2);
				expect(new Set(samples.heights)).toEqual(new Set([0]));
				await expect
					.poll(() =>
						previous.evaluate((el) => el.clientWidth > el.clientHeight),
					)
					.toBe(true);
				await expect
					.poll(() => current.evaluate((el) => el.getBoundingClientRect().top))
					.toBeCloseTo(samples.expectedTop, 0);
				await expect(page.locator(".page-position")).toHaveText("Page 8 of 16");
			},
			fixturePdf({ pages: 16, pagePadding: 0, landscape: [6, 10] }),
		);
	});
}

for (const fitWidth of [false, true]) {
	test(`holds the trackpad reading point and pans to both edges with fit width ${fitWidth}`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1080, height: 640 });
		await withLibrary(
			["Book"],
			async (url) => {
				const id = await firstBookId(page.request, url);
				const saved = await page.request.put(
					`${url}/api/books/${id}/progress`,
					{
						data: { page: 800, total: 816 },
					},
				);
				expect(saved.ok()).toBe(true);
				await page.goto(`${url}/#book=${id}`);
				const paper = page.getByRole("group", {
					name: "Page 800",
					exact: true,
				});
				await expect(paper.locator("canvas").first()).toBeVisible();
				if (fitWidth) {
					await page
						.getByRole("button", { name: "Reader controls" })
						.press("Enter");
					const fit = page.getByRole("button", { name: "Fit width" });
					await fit.click();
					await fit.press("Escape");
				}
				const samples = await paper.evaluate(async (el) => {
					const frame = () => new Promise(requestAnimationFrame);
					await frame();
					await frame();
					const original = el.getBoundingClientRect();
					const fittedWidth = el.clientWidth;
					const pane = el.closest("main");
					if (!pane) throw new Error("Missing reader");
					const extent = [pane.scrollWidth, pane.scrollHeight];
					const base = el.querySelector("canvas:not(.page-detail)");
					const detail = el.querySelector(".page-detail");
					const x = Math.round(original.left + original.width * 0.59);
					const y = Math.round(innerHeight * 0.58);
					const point = {
						x: (x - original.left) / original.width,
						y: (y - original.top) / original.height,
					};
					const send = (type: string, scale: number) =>
						!el.dispatchEvent(
							Object.assign(
								new Event(type, { bubbles: true, cancelable: true }),
								{
									scale,
									clientX: x,
									clientY: y,
								},
							),
						);
					const take = () => {
						const r = el.getBoundingClientRect();
						return {
							layoutWidth: el.clientWidth,
							sameExtent:
								pane.scrollWidth === extent[0] &&
								pane.scrollHeight === extent[1],
							scale: r.width / original.width,
							drift: Math.max(
								Math.abs(r.left + r.width * point.x - x),
								Math.abs(r.top + r.height * point.y - y),
							),
						};
					};
					const claimed = send("gesturestart", 1);
					const frames = [];
					let scrollDuringPinch = 0;
					let pausedDrift = 0;
					for (const scale of [
						1.15, 1.6, 2.3, 3.25, 4.8, 6, 8, 10, 15, 13.125, 6.5625,
					]) {
						send("gesturechange", scale);
						await frame();
						frames.push(take());
						if (scale === 6) {
							await new Promise((done) => setTimeout(done, 180));
							const before = pane.scrollTop;
							pane.scrollBy(0, 60);
							await frame();
							await frame();
							scrollDuringPinch = pane.scrollTop - before;
							pausedDrift = take().drift;
						}
					}
					const keptLayers =
						base === el.querySelector("canvas:not(.page-detail)") &&
						detail === el.querySelector(".page-detail");
					send("gestureend", 1);
					return {
						claimed,
						keptLayers,
						scrollDuringPinch,
						pausedDrift,
						fittedWidth,
						frames,
						released: take(),
						root: visualViewport?.scale,
					};
				});
				expect(samples.claimed).toBe(true);
				expect(samples.keptLayers).toBe(true);
				expect(samples.scrollDuringPinch).toBe(60);
				expect(samples.pausedDrift).toBeLessThan(2);
				expect(samples.frames.every((frame) => frame.sameExtent)).toBe(true);
				expect(samples.root).toBe(1);
				expect(
					samples.frames.map(
						(frame) => frame.layoutWidth - samples.fittedWidth,
					),
				).toEqual(samples.frames.map(() => 0));
				expect(
					samples.frames.map((result) => Math.round(result.scale * 100) / 100),
				).toEqual([1.15, 1.6, 2.3, 3.25, 4.8, 6, 8, 8, 8, 7, 3.5]);
				expect(
					Math.max(...samples.frames.map((result) => result.drift)),
				).toBeLessThan(2);
				expect(samples.released.scale).toBeCloseTo(3.5, 2);
				expect(samples.released.layoutWidth / samples.fittedWidth).toBeCloseTo(
					3.5,
					2,
				);
				await expect(paper.locator(".page-detail")).toBeVisible();
				const area = page.locator(".reader-scroll");
				await page.mouse.move(510, 350);
				for (const side of ["left", "right"] as const) {
					await page.mouse.wheel(side === "left" ? -90000 : 90000, 0);
					await expect
						.poll(async () =>
							paper.evaluate((el, side) => {
								const r = el.getBoundingClientRect();
								const edge = r[side];
								return edge >= -1 && edge <= innerWidth + 1;
							}, side),
						)
						.toBe(true);
				}
				await expect(page.locator(".page-position")).toHaveText(
					"Page 800 of 816",
				);
				await area.evaluate((pane) => {
					pane.scrollTop = pane.scrollHeight;
				});
				await expect(page.locator(".page-position")).toHaveText(
					"Page 816 of 816",
				);
				const last = page.getByRole("group", { name: "Page 816", exact: true });
				await expect(last.locator(".page-detail")).toBeVisible();
				await page.keyboard.press("0");
				await expect
					.poll(() =>
						area.evaluate((pane) => pane.scrollWidth <= pane.clientWidth + 1),
					)
					.toBe(true);
			},
			fixturePdf({ pages: 816, pagePadding: 0 }),
		);
	});
}

test("ends a pinch at the fitted position from opposite corners of a zoomed book", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1000, height: 640 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await withLibrary(
		["Corners"],
		async (url) => {
			await page.goto(url);
			await page.locator(".book").click();
			const pane = page.locator(".reader-scroll");
			await expect(
				page
					.getByRole("group", { name: "Page 1", exact: true })
					.locator("canvas")
					.first(),
			).toBeVisible();
			for (const number of [1, 6]) {
				for (let step = 0; step < 6; step++) await page.keyboard.press("+");
				await pane.evaluate(
					(area, last) =>
						area.scrollTo(
							last ? area.scrollWidth : 0,
							last ? area.scrollHeight : 0,
						),
					number === 6,
				);
				const paper = page.getByRole("group", {
					name: `Page ${number}`,
					exact: true,
				});
				await expect(paper.locator(".page-detail")).toBeVisible();
				const shift = await paper.evaluate(async (el) => {
					const r = el.getBoundingClientRect();
					const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
					const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
					const send = (kind: string, scale: number) =>
						el.dispatchEvent(
							Object.assign(
								new Event(kind, { bubbles: true, cancelable: true }),
								{ scale, clientX: x, clientY: y },
							),
						);
					send("gesturestart", 1);
					send("gesturechange", 0.125);
					await new Promise(requestAnimationFrame);
					const before = el.getBoundingClientRect();
					send("gestureend", 0.125);
					await new Promise(requestAnimationFrame);
					const after = el.getBoundingClientRect();
					return Math.max(
						Math.abs(before.x - after.x),
						Math.abs(before.y - after.y),
						Math.abs(before.width - after.width),
					);
				});
				expect(shift).toBeLessThan(2);
				await expect
					.poll(() =>
						pane.evaluate((area) => area.scrollWidth - area.clientWidth),
					)
					.toBeLessThan(2);
			}
		},
		fixturePdf({ pages: 6, pagePadding: 0 }),
	);
});

test("combines a desktop pinch wheel, keyboard zoom and fit width", async ({
	page,
}) => {
	await page.setViewportSize({ width: 1024, height: 660 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await withLibrary(
		["Scan"],
		async (url) => {
			await page.goto(url);
			await page.locator(".book").click();
			const paper = page.getByRole("group", { name: "Page 1", exact: true });
			await expect(paper.locator("canvas").first()).toBeVisible();
			const width = () =>
				paper.evaluate((el) => el.getBoundingClientRect().width);
			const initial = await width();
			await page.mouse.move(547, 330);
			await page.keyboard.down("Control");
			await page.mouse.wheel(0, -35);
			await page.keyboard.up("Control");
			await expect
				.poll(async () => (await width()) / initial)
				.toBeCloseTo(Math.exp(0.35), 2);
			await page.keyboard.press("+");
			await expect
				.poll(async () => (await width()) / initial)
				.toBeCloseTo(1.5, 2);
			await page
				.getByRole("button", { name: "Reader controls" })
				.press("Enter");
			const fit = page.getByRole("button", { name: "Fit width" });
			await fit.click();
			await expect(fit).toHaveAttribute("aria-pressed", "true");
			await expect(
				page.getByRole("button", { name: "Zoom out" }),
			).toBeDisabled();
			await expect(
				page.getByLabel("Zoom relative to the fitted page"),
			).toHaveText("1×");
			await expect
				.poll(() => page.evaluate(() => visualViewport?.scale))
				.toBe(1);
		},
		ruledScan(),
	);
});

test("keeps the full paper painted while zoom reverses and pans without a preview", async ({
	page,
}) => {
	await page.route("**/preview/*", (route) => route.fulfill({ status: 503 }));
	await page.setViewportSize({ width: 720, height: 540 });
	await withLibrary(
		["Paper"],
		async (url) => {
			await page.goto(url);
			await page.locator(".book").click();
			const paper = page.getByRole("group", { name: "Page 1", exact: true });
			await expect(paper.locator("canvas")).toBeVisible();
			for (let step = 0; step < 4; step++) await page.keyboard.press("+");
			await expect(paper.locator(".page-detail")).toBeVisible();
			const gaps = await paper.evaluate(async (surface) => {
				const pane = surface.closest(".reader-scroll");
				if (!(pane instanceof HTMLElement)) throw new Error("Missing reader");
				const sample = document.createElement("canvas");
				sample.width = sample.height = 1;
				const composite = sample.getContext("2d", { willReadFrequently: true });
				if (!composite) throw new Error("Missing pixel sampler");
				let missing = 0;
				for (let frame = 0; frame < 24; frame++) {
					if (frame === 0 || frame === 8) {
						pane.scrollLeft = frame === 0 ? pane.scrollWidth : 0;
					}
					if (frame === 12 || frame === 16) {
						window.dispatchEvent(
							new KeyboardEvent("keydown", { key: frame === 12 ? "-" : "+" }),
						);
					}
					await new Promise(requestAnimationFrame);
					const page = surface.getBoundingClientRect();
					const width =
						Math.min(innerWidth, page.right) - Math.max(0, page.left);
					const y =
						Math.max(0, page.top) +
						(Math.min(innerHeight, page.bottom) - Math.max(0, page.top)) / 2;
					for (const fraction of [0.15, 0.5, 0.85]) {
						const x = Math.max(0, page.left) + width * fraction;
						composite.clearRect(0, 0, 1, 1);
						for (const canvas of surface.querySelectorAll("canvas")) {
							const r = canvas.getBoundingClientRect();
							if (x < r.left || x >= r.right || y < r.top || y >= r.bottom)
								continue;
							const sx = Math.floor(((x - r.left) * canvas.width) / r.width);
							const sy = Math.floor(((y - r.top) * canvas.height) / r.height);
							composite.drawImage(canvas, sx, sy, 1, 1, 0, 0, 1, 1);
						}
						const pixel = composite.getImageData(0, 0, 1, 1).data;
						if ((pixel[0] ?? 255) >= 95 || pixel[3] !== 255) missing++;
					}
				}
				return missing;
			});
			expect(gaps).toBe(0);
		},
		fixturePdf({ pages: 1, pagePadding: 0 }),
	);
});

test("keeps native macOS magnification aligned above and below the pinch peak", async ({
	browserName,
	page,
}) => {
	test.skip(
		process.platform !== "darwin" || browserName !== "webkit",
		"Requires the macOS system WebKit view.",
	);
	test.setTimeout(90_000);
	await withLibrary(
		["Paper"],
		async (url) => {
			await page.goto(url);
			const id = await page
				.getByRole("link", { name: "Paper", exact: true })
				.getAttribute("id");
			const saved = await page.request.put(`${url}/api/books/${id}/progress`, {
				data: { page: 48, total: 50 },
			});
			expect(saved.ok()).toBe(true);
			await promisify(execFile)(
				"xcrun",
				[
					"swift",
					fileURLToPath(
						new URL("../../verification/macos-pinch.swift", import.meta.url),
					),
					`${url}/#book=${id}`,
				],
				{ timeout: 65_000, killSignal: "SIGKILL" },
			);
		},
		fixturePdf({ pages: 50, pagePadding: 0 }),
	);
});

test("zooms around the reading point across frames and respects reduced motion", async ({
	page,
}) => {
	await page.setViewportSize({ width: 800, height: 600 });
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await withLibrary(
		["Paper"],
		async (url) => {
			await page.goto(url);
			await page.locator(".book").click();
			const paper = page.getByRole("group", { name: "Page 1", exact: true });
			await expect(paper.locator("canvas")).toBeVisible();
			const sample = () =>
				paper.evaluate(async (surface) => {
					const before = surface.getBoundingClientRect();
					const anchor = (r: DOMRect) => (innerHeight / 2 - r.top) / r.height;
					const start = performance.now();
					window.dispatchEvent(new KeyboardEvent("keydown", { key: "+" }));
					const ratios = [surface.getBoundingClientRect().width / before.width];
					while (performance.now() - start < 240) {
						await new Promise(requestAnimationFrame);
						ratios.push(surface.getBoundingClientRect().width / before.width);
					}
					return {
						ratios,
						drift: Math.abs(
							anchor(surface.getBoundingClientRect()) - anchor(before),
						),
					};
				});
			const { ratios, drift } = await sample();
			expect(drift).toBeLessThan(0.01);
			expect(ratios.some((value) => value > 1.01 && value < 1.49)).toBe(true);
			expect(ratios.at(-1)).toBeCloseTo(1.5, 2);
			await page.emulateMedia({ reducedMotion: "reduce" });
			await page.keyboard.press("0");
			const immediate = await sample();
			expect(immediate.ratios[0]).toBeCloseTo(1.5, 2);
		},
		fixturePdf({ pages: 1, pagePadding: 0 }),
	);
});

test("prepares a newly scanned cover before the first shelf visit", async ({
	page,
}) => {
	await withLibrary([], async (url, booksPath) => {
		await expect
			.poll(
				async () =>
					(await (await page.request.get(`${url}/api/library`)).json()).status,
			)
			.toBe("ready");
		await writeFile(join(booksPath, "New scan.pdf"), ruledScan());
		const result = await page.request.post(`${url}/api/library/scan`, {
			data: "null",
			headers: { "Content-Type": "application/json" },
		});
		expect(result.status()).toBe(204);
		const shelf = await (await page.request.get(`${url}/api/library`)).json();
		expect(shelf.books).toEqual([
			expect.objectContaining({ title: "New scan" }),
		]);
		const db = new DatabaseSync(join(booksPath, "../state/previews.sqlite3"), {
			readOnly: true,
		});
		try {
			const covers = db.prepare(
				"SELECT count(*) AS count FROM previews WHERE page=1 AND length(jpeg)>0",
			);
			await expect.poll(() => covers.get()?.count, { timeout: 20_000 }).toBe(1);
		} finally {
			db.close();
		}
		await page.goto(url);
		await expect(page.locator(".cover img")).toBeVisible();
	});
});

test("preserves color on JPEG and JPEG 2000 scan pages", async ({ page }) => {
	const pdf = await readFile(new URL("./color-scans.pdf", import.meta.url));
	await withLibrary(
		["Color scans"],
		async (url) => {
			await page.goto(url);
			await page.locator(".book").click();
			for (const number of [1, 2]) {
				const paper = page.getByRole("group", {
					name: `Page ${number}`,
					exact: true,
				});
				await paper.scrollIntoViewIfNeeded();
				const canvas = paper.locator("canvas");
				await expect(canvas).toBeVisible();
				const channels = await canvas.evaluate((el) => {
					if (!(el instanceof HTMLCanvasElement))
						throw new Error("Missing page canvas");
					const context = el.getContext("2d");
					if (!context) throw new Error("Missing pixel data");
					const left = context.getImageData(
						el.width / 4,
						el.height / 2,
						1,
						1,
					).data;
					const right = context.getImageData(
						(3 * el.width) / 4,
						el.height / 2,
						1,
						1,
					).data;
					return [left[0], left[2], right[0], right[2]];
				});
				expect(channels[0]).toBeGreaterThan(180);
				expect(channels[1]).toBeLessThan(70);
				expect(channels[2]).toBeLessThan(70);
				expect(channels[3]).toBeGreaterThan(180);
			}
		},
		pdf,
	);
});

test("renders JBIG2 ink and distinct Japanese glyphs without an embedded font", async ({
	page,
}) => {
	const pdf = await readFile(new URL("./print-samples.pdf", import.meta.url));
	await withLibrary(
		["Print samples"],
		async (url) => {
			await page.goto(url);
			await page.locator(".book").click();
			const scan = page.getByRole("group", { name: "Page 1", exact: true });
			const tones = await scan.locator("canvas").evaluate((canvas) => {
				if (!(canvas instanceof HTMLCanvasElement))
					throw new Error("Missing scan canvas");
				const ctx = canvas.getContext("2d");
				if (!ctx) throw new Error("Missing scan pixels");
				return [0.1, 0.5].map(
					(point) =>
						ctx.getImageData(point * canvas.width, point * canvas.height, 1, 1)
							.data[0],
				);
			});
			expect(tones).toEqual([0, 255]);
			const text = page.getByRole("group", { name: "Page 2", exact: true });
			await text.scrollIntoViewIfNeeded();
			const glyphs = await text.locator("canvas").evaluate((canvas) => {
				if (!(canvas instanceof HTMLCanvasElement))
					throw new Error("Missing text canvas");
				const copy = document.createElement("canvas");
				copy.width = 240;
				copy.height = 90;
				const ctx = copy.getContext("2d");
				if (!ctx) throw new Error("Missing glyph pixels");
				ctx.drawImage(canvas, 0, 0, copy.width, copy.height);
				return [15, 69, 123].map((x) => {
					const pixels = ctx.getImageData(x, 0, 54, 90).data;
					return Array.from(
						pixels.filter((_, i) => i % 4 === 0),
						(red) => red < 128,
					);
				});
			});
			for (const [index, glyph] of glyphs.entries()) {
				expect(glyph.filter(Boolean).length).toBeGreaterThan(100);
				for (const other of glyphs.slice(index + 1)) {
					expect(
						glyph.filter((pixel, i) => pixel !== other[i]).length,
					).toBeGreaterThan(150);
				}
			}
		},
		pdf,
	);
});

test("keeps the loading indicator until the cover pixels are ready to paint", async ({
	page,
}) => {
	await page.addInitScript(() => {
		const decode = HTMLImageElement.prototype.decode;
		const ready = new Promise<void>((resolve) =>
			window.addEventListener("release-previews", () => resolve(), {
				once: true,
			}),
		);
		HTMLImageElement.prototype.decode = async function () {
			await decode.call(this);
			await ready;
		};
	});
	await withLibrary(
		["Scan"],
		async (url) => {
			await page.goto(url);
			const cover = page.locator(".cover img");
			await expect
				.poll(() =>
					cover.evaluate((el) => (el as HTMLImageElement).naturalWidth),
				)
				.toBeGreaterThan(0);
			await expect(page.getByText("Loading cover…")).toBeVisible();
			await expect(cover).toBeHidden();
			await page.evaluate(() =>
				window.dispatchEvent(new Event("release-previews")),
			);
			await expect(cover).toBeVisible();
			await expect(page.getByText("Loading cover…")).toHaveCount(0);
		},
		ruledScan(),
	);
});

test("renders at the physical display density after a mobile pinch", async ({
	browser,
	browserName,
}) => {
	test.skip(
		browserName !== "chromium",
		"Native pinch emulation requires the Chrome DevTools Protocol.",
	);
	const page = await browser.newPage({
		viewport: { width: 430, height: 850 },
		deviceScaleFactor: 3,
		isMobile: true,
		hasTouch: true,
	});
	try {
		await withLibrary(
			["Scan"],
			async (url) => {
				await page.goto(url);
				await page.locator(".book").click();
				const first = page.getByRole("group", { name: "Page 1", exact: true });
				await expect(first.locator("canvas")).toBeVisible();
				const session = await page.context().newCDPSession(page);
				await session.send("Emulation.setPageScaleFactor", {
					pageScaleFactor: 3,
				});
				await expect(page.getByRole("main", { name: "PDF pages" })).toHaveCSS(
					"scroll-snap-type",
					"none",
				);
				const detail = first.locator("canvas.page-detail");
				await expect(detail).toBeVisible();
				const density = await detail.evaluate(
					(c) =>
						(c as HTMLCanvasElement).width / c.getBoundingClientRect().width,
				);
				expect(density).toBeCloseTo(9, 1);
				await session.send("Emulation.setPageScaleFactor", {
					pageScaleFactor: 1,
				});
				await expect(detail).toHaveCount(0);
			},
			ruledScan(),
		);
	} finally {
		await page.close();
	}
});

test("unlocks an encrypted document after an incorrect password", async ({
	page,
}) => {
	const bytes = await readFile(new URL("./locked.pdf", import.meta.url));
	await withLibrary(
		["Protected scan"],
		async (url, books) => {
			const id = await firstBookId(page.request, url);
			const db = new DatabaseSync(join(books, "../state/book-text.sqlite3"), {
				readOnly: true,
			});
			try {
				const record = db.prepare(
					"SELECT body FROM prepared_pages WHERE book=?",
				);
				await expect.poll(() => record.get(id)).toEqual({ body: null });
				expect(
					(await page.request.get(`${url}/api/books/${id}/text`)).status(),
				).toBe(404);
				expect(
					(
						await page.request.post(`${url}/api/books/${id}/matches`, {
							data: { query: "paper" },
						})
					).status(),
				).toBe(404);
			} finally {
				db.close();
			}
			await page.goto(url);
			await page.locator(".book").click();
			const password = page.getByLabel("PDF password", { exact: true });
			await expect(password).toBeFocused();
			await password.fill("wrong");
			await password.press("Enter");
			await expect(page.getByText("Incorrect password.")).toBeVisible();
			await password.fill("paper");
			await password.press("Enter");
			await expect(page.locator(".pdf-page canvas")).toBeVisible();
		},
		bytes,
	);
});

test("opens the original when previews fail and retries a failed document request", async ({
	page,
}) => {
	await withLibrary(
		["Scan"],
		async (url) => {
			await page.route("**/preview/*", (route) =>
				route.fulfill({ status: 503 }),
			);
			await page.route("**/api/books/*/pdf", (route) =>
				route.fulfill({ status: 503 }),
			);
			await page.goto(url);
			await expect(page.getByText("Preview unavailable")).toBeVisible();
			await page.locator(".book").click();
			await expect(
				page.getByRole("heading", { name: "PDF unavailable" }),
			).toBeVisible();
			await page.unroute("**/api/books/*/pdf");
			await page.getByRole("button", { name: "Retry" }).click();
			await expect(page.locator(".pdf-page canvas").first()).toBeVisible();
		},
		ruledScan(),
	);
});

test("resolves fine scan lines when zooming and keeps panned detail inside its pixel budget", async ({
	page,
}) => {
	await page.setViewportSize({ width: 430, height: 700 });
	await withLibrary(
		["Scan"],
		async (url) => {
			await page.goto(url);
			await page.locator(".book").click();
			const first = page.getByRole("group", { name: "Page 1", exact: true });
			await expect(first.locator("canvas")).toBeVisible();
			for (let i = 0; i < 4; i++) await page.keyboard.press("+");
			const detail = first.locator(".page-detail");
			const checkInk = async () => {
				await expect
					.poll(() =>
						detail.evaluate((el) => {
							if (!(el instanceof HTMLCanvasElement))
								throw new Error("Expected a canvas");
							const row = el
								.getContext("2d")
								?.getImageData(el.width / 2 - 60, el.height / 2, 120, 1).data;
							if (!row) throw new Error("Missing scan line");
							const values = Array.from(row).filter((_, i) => i % 4 === 0);
							return (
								Math.min(...values) < 50 &&
								Math.max(...values) > 205 &&
								el.width * el.height <= 8_388_608
							);
						}),
					)
					.toBe(true);
			};
			await expect(detail).toBeVisible();
			await checkInk();
			const area = page.locator(".reader-scroll");
			await area.evaluate((el) => {
				el.scrollLeft = el.scrollWidth;
			});
			await expect
				.poll(() =>
					detail.evaluate(
						(el) =>
							el.getBoundingClientRect().right >=
							Math.min(
								window.innerWidth - 2,
								el.parentElement?.getBoundingClientRect().right ?? 0,
							) -
								2,
					),
				)
				.toBe(true);
			await checkInk();
			const fraction = () =>
				first.evaluate((el) => {
					const pane = el.closest(".reader-scroll");
					if (!(pane instanceof HTMLElement) || !(el instanceof HTMLElement))
						throw new Error("Missing reading area");
					return (pane.scrollTop - el.offsetTop) / el.clientHeight;
				});
			await first.evaluate((el) => {
				const pane = el.closest(".reader-scroll");
				if (pane instanceof HTMLElement && el instanceof HTMLElement)
					pane.scrollTop = el.offsetTop + el.clientHeight * 0.4;
			});
			await expect.poll(fraction).toBeCloseTo(0.4, 2);
			await page.setViewportSize({ width: 700, height: 430 });
			await expect.poll(fraction).toBeCloseTo(0.4, 1);
			await page.keyboard.press("0");
			await expect
				.poll(() => area.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
				.toBe(true);
		},
		ruledScan(),
	);
});

test("loads covers without opening a PDF and shows the saved page before PDF.js loads", async ({
	page,
}) => {
	await withLibrary(
		["Scan"],
		async (url) => {
			const book = await firstBookId(page.request, url);
			const path = `${url}/api/books/${book}`;
			await page.request.put(`${path}/progress`, {
				data: { page: 2, total: 2 },
			});
			const jpg = await page.request.get(`${path}/preview/2`);
			expect(jpg.status()).toBe(200);
			expect(jpg.headers()["content-type"]).toBe("image/jpeg");
			expect(jpg.headers()["cache-control"]).toContain("private");
			expect((await jpg.body()).subarray(0, 2)).toEqual(
				Buffer.from([255, 216]),
			);
			expect((await page.request.get(`${path}/preview/0`)).ok()).toBe(false);
			expect((await page.request.get(`${path}/preview/3`)).ok()).toBe(false);
			const requests: string[] = [];
			page.on("request", (req) => requests.push(req.url()));
			let release!: () => void;
			const wait = new Promise<void>((resolve) => {
				release = resolve;
			});
			await page.route("**/assets/pdf-*.js", async (route) => {
				await wait;
				await route.continue();
			});
			try {
				await page.goto(url);
				const cover = page.locator(".cover img");
				await expect(cover).toBeVisible();
				await expect
					.poll(() =>
						cover.evaluate((el) => (el as HTMLImageElement).naturalWidth),
					)
					.toBeGreaterThan(0);
				expect(
					requests.some((u) => u.endsWith("/pdf") || u.includes("pdf.worker-")),
				).toBe(false);
				await page.locator(".book").click();
				const preview = page.locator('.reader img[src$="/preview/2"]');
				await expect(preview).toBeVisible();
				await expect
					.poll(() =>
						preview.evaluate((el) => (el as HTMLImageElement).naturalWidth),
					)
					.toBeGreaterThan(0);
				expect(
					await preview.evaluate(
						(el) =>
							(el as HTMLImageElement).naturalWidth >
							(el as HTMLImageElement).naturalHeight,
					),
				).toBe(true);
				await expect(
					page.locator('.reader img[src$="/preview/1"]'),
				).toHaveCount(0);
			} finally {
				release();
			}
			await expect(
				page
					.getByRole("group", { name: "Page 2", exact: true })
					.locator("canvas"),
			).toBeVisible();
		},
		ruledScan(),
	);
});
