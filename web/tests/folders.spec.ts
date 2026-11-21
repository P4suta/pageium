import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { firstBookId, fixturePdf, withLibrary } from "./fixtures";

function gate() {
	let open!: () => void;
	const wait = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { open, wait };
}

test("shows the latest page in the root resume link while saving a nested book", async ({
	page,
}) => {
	await withLibrary([], async (url, root) => {
		await mkdir(join(root, "Notes"));
		await writeFile(
			join(root, "Notes", "Journal.pdf"),
			fixturePdf({ pages: 4, pagePadding: 0 }),
		);
		await page.goto(url);
		await page.getByRole("button", { name: "Rescan library" }).click();
		await page.getByRole("link", { name: "Notes", exact: true }).click();
		const id = await page
			.getByRole("link", { name: "Journal" })
			.getAttribute("id");
		const saved = await page.request.put(`${url}/api/books/${id}/progress`, {
			data: { page: 1, total: 4 },
		});
		expect(saved.ok()).toBe(true);
		await page.getByRole("link", { name: "Library", exact: true }).click();
		const resume = page.getByRole("link", {
			name: /Continue reading.*Journal/,
		});
		await expect(resume).toContainText("Page 1 of 4");
		const write = gate();
		const read = gate();
		const reply = gate();
		await page.route("**/progress", async (route) => {
			await write.wait;
			await route.continue();
		});
		try {
			await resume.click();
			await expect(page.locator(".page-position")).toHaveText("Page 1 of 4");
			await page
				.getByRole("group", { name: "Page 2", exact: true })
				.evaluate((el) => el.scrollIntoView({ block: "start" }));
			await expect(page.locator(".page-position")).toHaveText("Page 2 of 4");
			await page.route("**/api/library?*", async (route) => {
				const response = await route.fetch();
				read.open();
				await reply.wait;
				await route.fulfill({ response });
			});
			await page.goBack();
			await read.wait;
			await expect(resume).toContainText("Page 2 of 4");
			const saved = page.waitForResponse(
				(res) => res.url().endsWith("/progress") && res.ok(),
			);
			write.open();
			await saved;
			reply.open();
			await expect(page.locator(".shelf-grid")).not.toHaveAttribute(
				"aria-busy",
				"true",
			);
			await expect(resume).toContainText("Page 2 of 4");
		} finally {
			write.open();
			reply.open();
		}
	});
});

test("browses nested folders and returns to the search that opened a book", async ({
	page,
}) => {
	const branch = "推理 #1 & 50%";
	const pdf = fixturePdf({ pages: 4, pagePadding: 0 });
	await withLibrary(
		["Loose"],
		async (url, root) => {
			await firstBookId(page.request, url);
			for (const directory of [`小説/${branch}`, "卒論", "オライリー"]) {
				await mkdir(join(root, directory), { recursive: true });
			}
			for (const path of [
				"小説/Atlas.pdf",
				`小説/${branch}/Atlas.pdf`,
				"卒論/Atlas.pdf",
			]) {
				await writeFile(join(root, path), pdf);
			}
			expect(
				(
					await page.request.post(`${url}/api/library/scan`, {
						data: "null",
						headers: { "Content-Type": "application/json" },
					})
				).status(),
			).toBe(204);
			await page.setViewportSize({ width: 320, height: 700 });
			await page.goto(url);
			const link = (name: string) =>
				page.getByRole("link", { name, exact: true });
			const heading = (name: string) =>
				page.getByRole("heading", { name, exact: true, level: 1 });
			await expect(link("Loose")).toBeVisible();
			await expect(page.locator(".book")).toHaveCount(1);
			await link("小説").focus();
			await link("小説").press("Enter");
			await expect(heading("小説")).toBeFocused();
			await expect(link("Loose")).toHaveCount(0);
			await link(branch).click();
			const trail = page.getByRole("navigation", { name: "Folder path" });
			await expect(trail.locator('[aria-current="page"]')).toHaveText(branch);
			await expect(trail.getByRole("link")).toHaveText(["Library", "小説"]);
			const folderUrl = page.url();
			await page.reload();
			await expect(heading(branch)).toBeVisible();
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth),
			).toBe(320);
			await trail.getByRole("link", { name: "小説" }).click();
			await expect(heading("小説")).toBeFocused();
			const search = page.getByRole("searchbox", { name: "Search books" });
			await search.fill("Atlas");
			await expect(page.locator(".book")).toHaveCount(2);
			const match = page.locator(".book").filter({ hasText: `小説/${branch}` });
			await match.click();
			await expect(page.locator(".page-position")).toHaveText("Page 1 of 4");
			await page.goBack();
			await expect(search).toHaveValue("Atlas");
			await expect(match).toBeFocused();
			await page.goto(folderUrl);
			await page.locator(".book").click();
			await expect(page.locator(".page-position")).toBeVisible();
			await page.reload();
			await expect(page.locator(".page-position")).toBeVisible();
			const controls = page.getByRole("button", { name: "Reader controls" });
			if ((await controls.getAttribute("aria-expanded")) === "false")
				await controls.press("Enter");
			await page.locator(".library-link").click();
			await expect(heading(branch)).toBeVisible();
			await expect(page.locator(".book")).toBeFocused();
			await trail.getByRole("link", { name: "Library" }).click();
			await expect(heading("Library")).toBeVisible();
			await expect(
				page.getByRole("link", { name: /Continue reading.*Atlas/ }),
			).toBeVisible();
			await link("オライリー").click();
			await expect(
				page.getByRole("heading", { name: "Folder is empty" }),
			).toBeVisible();
			await rename(join(root, "オライリー"), join(root, "技術書"));
			await page.getByRole("button", { name: "Rescan library" }).click();
			await expect(
				page.getByRole("heading", { name: "Folder unavailable" }),
			).toBeVisible();
			await link("Library").click();
			await expect(link("技術書")).toBeVisible();
			await expect(link("オライリー")).toHaveCount(0);
		},
		pdf,
	);
});

test("loads folders across a shelf page boundary and wraps long names", async ({
	page,
}) => {
	const last = `Z-${"catalogue".repeat(12)}`;
	await withLibrary(["Loose"], async (url, root) => {
		const names = Array.from({ length: 48 }, (_, n) => `Collection ${n}`);
		await Promise.all([...names, last].map((name) => mkdir(join(root, name))));
		await page.setViewportSize({ width: 320, height: 640 });
		await page.goto(url);
		await page.getByRole("button", { name: "Rescan library" }).click();
		await expect(page.getByText("49 folders · 1 book")).toBeVisible();
		await expect(page.locator(".folder-link")).toHaveCount(48);
		await page.evaluate(() =>
			window.scrollTo(0, document.documentElement.scrollHeight),
		);
		const folder = page.getByRole("link", { name: last });
		await expect(folder).toBeVisible();
		await expect(page.getByRole("link", { name: "Loose" })).toBeVisible();
		await folder.focus();
		await page.addStyleTag({ content: ":root { font-size: 200% }" });
		await expect(folder).toBeFocused();
		expect(
			await folder.evaluate((el) => el.getBoundingClientRect().height),
		).toBeGreaterThanOrEqual(48);
		await folder.click();
		await expect(page.getByRole("heading", { name: last })).toBeFocused();
		await expect(
			page.getByRole("navigation", { name: "Folder path" }),
		).toContainText(last);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth),
		).toBe(320);
	});
});
