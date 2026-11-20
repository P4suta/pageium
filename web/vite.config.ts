import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants } from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const compress = promisify(brotliCompress);

function prepareBrotliAssets(): Plugin {
	return {
		name: "pageium-brotli-assets",
		apply: "build",
		async writeBundle(output, bundle): Promise<void> {
			if (!output.dir) throw new Error("Missing asset output directory");
			for (const asset of Object.values(bundle)) {
				if (
					!asset.fileName.startsWith("assets/") ||
					!/\.(js|mjs|css)$/.test(asset.fileName)
				)
					continue;
				const source = asset.type === "asset" ? asset.source : asset.code;
				const bytes = typeof source === "string" ? Buffer.from(source) : source;
				const compressed = await compress(bytes, {
					params: { [constants.BROTLI_PARAM_QUALITY]: 7 },
				});
				if (compressed.length < bytes.length) {
					await writeFile(join(output.dir, `${asset.fileName}.br`), compressed);
				}
			}
		},
	};
}

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^pdfjs-dist$/,
				replacement: fileURLToPath(
					new URL(
						"./node_modules/pdfjs-dist/legacy/build/pdf.mjs",
						import.meta.url,
					),
				),
			},
		],
	},
	plugins: [
		prepareBrotliAssets(),
		viteStaticCopy({
			targets: [
				{
					src: [
						"node_modules/pdfjs-dist/cmaps",
						"node_modules/pdfjs-dist/iccs",
						"node_modules/pdfjs-dist/standard_fonts",
						"node_modules/pdfjs-dist/wasm",
						"node_modules/pdfjs-dist/LICENSE",
					],
					dest: "pdfjs",
					rename: { stripBase: 2 },
				},
			],
		}),
	],
});
