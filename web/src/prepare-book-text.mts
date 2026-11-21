import { fstatSync, readSync } from "node:fs";
import { setPriority } from "node:os";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
	getDocument,
	PDFDataRangeTransport,
	PermissionFlag,
	version,
} from "pdfjs-dist/legacy/build/pdf.mjs";

const assets = import.meta.resolve("pdfjs-dist/package.json");
const directory = (name: string) => fileURLToPath(new URL(`${name}/`, assets));
const textLimit = 32 * 1024 * 1024;

// Use positional reads on the file descriptor already checked by the server.
class BookRanges extends PDFDataRangeTransport {
	override requestDataRange(begin: number, end: number): void {
		const bytes = new Uint8Array(end - begin);
		for (let offset = 0; offset < bytes.length; ) {
			const read = readSync(
				0,
				bytes,
				offset,
				bytes.length - offset,
				begin + offset,
			);
			if (!read) throw new Error("Incomplete PDF range");
			offset += read;
		}
		queueMicrotask(() => this.onDataRange(begin, bytes));
	}
}

async function prepare(): Promise<
	{ body: Buffer; positionsOnly: boolean } | undefined
> {
	setPriority(0, 10);
	const task = getDocument({
		range: new BookRanges(fstatSync(0).size, new Uint8Array()),
		disableStream: true,
		disableAutoFetch: true,
		cMapUrl: directory("cmaps"),
		standardFontDataUrl: directory("standard_fonts"),
		wasmUrl: directory("wasm"),
		verbosity: 0,
	});
	try {
		const pdf = await task.promise;
		if (pdf.numPages > 100_000) return;
		const { info } = await pdf.getMetadata();
		const permissions = await pdf.getPermissions();
		const positionsOnly = permissions
			? !permissions.has(PermissionFlag.COPY)
			: Boolean("EncryptFilterName" in info && info.EncryptFilterName);
		const pages: string[] = [];
		let size = 0;
		for (let number = 1; number <= pdf.numPages; number++) {
			const page = await pdf.getPage(number);
			const { items } = await page.getTextContent({
				disableNormalization: true,
			});
			const text = items
				.map((item) =>
					"str" in item ? item.str + (item.hasEOL ? "\n" : "") : "",
				)
				.join("");
			size += Buffer.byteLength(JSON.stringify(text)) + 1;
			if (size > textLimit) return;
			pages.push(text);
			page.cleanup();
		}
		return {
			body: gzipSync(JSON.stringify({ version, pages })),
			positionsOnly,
		};
	} finally {
		await task.destroy();
	}
}

try {
	const result = await prepare();
	if (result) {
		process.stdout.write(result.body);
		process.exitCode = result.positionsOnly ? 3 : 0;
	} else process.exitCode = 2;
} catch (error) {
	process.exitCode =
		error instanceof Error && error.name === "PasswordException" ? 2 : 1;
}
