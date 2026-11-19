import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests",
	workers: 1,
	timeout: 35_000,
	use: { trace: "retain-on-failure" },
	projects: [
		{ name: "webkit", use: { browserName: "webkit" } },
		{ name: "chromium", use: { browserName: "chromium", channel: "chromium" } },
	],
});
