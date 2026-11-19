import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	outputDir: "../../.local/quality/lighthouse",
	timeout: 90_000,
	workers: 1,
});
