import { expect, test } from "@playwright/test";
import { launch } from "chrome-launcher";
import lighthouse from "lighthouse";
import { chromium } from "playwright";
import { withLibrary } from "../tests/fixtures";

const scenarios = [
	{ name: "empty shelf", books: [], bytes: 40 * 1024 },
	{
		name: "shelf with PDF covers",
		books: ["A Field Guide to Clouds", "The Shape of Quiet"],
		bytes: 1500 * 1024,
	},
];

for (const scenario of scenarios) {
	test(scenario.name, async () => {
		await withLibrary(scenario.books, async (url) => {
			const chrome = await launch({
				chromePath: chromium.executablePath(),
				chromeFlags: ["--headless=new", "--disable-extensions"],
				logLevel: "silent",
			});
			try {
				const result = await lighthouse(url, {
					port: chrome.port,
					onlyCategories: ["performance", "accessibility", "best-practices"],
					logLevel: "silent",
				});
				if (!result) throw new Error("Lighthouse returned no result");
				const { audits, categories, runtimeError } = result.lhr;
				const transferred = audits["total-byte-weight"]?.numericValue;
				expect(runtimeError).toBeUndefined();
				expect(transferred).toBeGreaterThan(0);
				expect(transferred).toBeLessThan(scenario.bytes);
				expect(categories.accessibility?.score).toBeGreaterThanOrEqual(0.95);
				expect(categories["best-practices"]?.score).toBeGreaterThanOrEqual(
					0.95,
				);
				expect(audits["errors-in-console"]?.score).toBe(1);
				const requests = audits["network-requests"]?.details;
				const worker =
					requests?.type === "table"
						? requests.items.find(
								(item) =>
									typeof item.url === "string" &&
									item.url.includes("/assets/pdf.worker-"),
							)
						: undefined;
				if (scenario.books.length > 0) {
					expect(worker?.transferSize).toBeLessThan(550 * 1024);
				} else {
					expect(worker).toBeUndefined();
				}
				console.log({
					scenario: scenario.name,
					performance: categories.performance?.score,
					accessibility: categories.accessibility?.score,
					bestPractices: categories["best-practices"]?.score,
					transferred,
					blockingMs: audits["total-blocking-time"]?.numericValue,
				});
			} finally {
				await chrome.kill();
			}
		});
	});
}
