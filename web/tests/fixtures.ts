import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { type APIRequestContext, expect } from "@playwright/test";

const web = fileURLToPath(new URL("../dist", import.meta.url));
const executable = fileURLToPath(
	new URL("../../target/debug/pageium", import.meta.url),
);

export function fixturePdf({
	pages = 8,
	pagePadding = 24_000,
	landscape = [],
}: {
	pages?: number;
	pagePadding?: number;
	landscape?: readonly number[];
} = {}): Buffer {
	const kids = Array.from({ length: pages }, (_, index) => `${4 + index} 0 R`);
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Count ${pages} /Kids [${kids.join(" ")}] >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	for (let page = 1; page <= pages; page += 1) {
		const box = landscape.includes(page) ? "780 600" : "600 780";
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${box}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${3 + pages + page} 0 R >>`,
		);
	}
	for (let page = 1; page <= pages; page += 1) {
		const stream = [
			"0.15 0.25 0.30 rg 0 0 600 780 re f",
			"0.95 0.90 0.78 rg BT /F1 44 Tf 50 625 Td (Pageium) Tj ET",
			`BT /F1 24 Tf 50 565 Td (Reading sample ${page}) Tj ET`,
			`%${"p".repeat(pagePadding)}`,
		].join("\n");
		objects.push(
			`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		);
	}
	return pdfObjects(objects);
}

export function faxScan(): Buffer {
	const ink = "q 64 0 0 64 0 0 cm /Scan Do Q";
	const image =
		"26a0786ffffffffc82e37fffffffffffffffffffffffffffffff8ffffffff0010010>";
	return pdfObjects([
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 64 64] /Resources << /XObject << /Scan 5 0 R >> >> /Contents 4 0 R >>",
		`<< /Length ${ink.length} >>\nstream\n${ink}\nendstream`,
		`<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter [/ASCIIHexDecode /CCITTFaxDecode] /DecodeParms [null << /K -1 /Columns 64 /Rows 64 /BlackIs1 true >>] /Length ${image.length} >>\nstream\n${image}\nendstream`,
	]);
}

export function ruledScan(): Buffer {
	const width = 2400;
	const height = 3200;
	const pixels = Buffer.alloc((width * height) / 8);
	for (let row = 0; row < height; row++) {
		pixels.fill(
			row < height / 2 ? 0x33 : 0xcc,
			(row * width) / 8,
			((row + 1) * width) / 8,
		);
	}
	const compressed = `${deflateSync(pixels).toString("hex")}>`;
	const paint = "q 600 0 0 800 0 0 cm /Scan Do Q";
	return pdfObjects([
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Scan 6 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /CropBox [20 100 580 700] /Rotate 90 /Resources << /XObject << /Scan 6 0 R >> >> /Contents 5 0 R >>",
		`<< /Length ${paint.length} >>\nstream\n${paint}\nendstream`,
		`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter [/ASCIIHexDecode /FlateDecode] /Length ${compressed.length} >>\nstream\n${compressed}\nendstream`,
	]);
}

export function annotatedBook(): Buffer {
	const stream = (content: string) =>
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
	const image = "q 600 0 0 780 0 0 cm /Scan Do Q";
	const resources =
		"/Resources << /Font << /F1 6 0 R /JP 7 0 R >> /XObject << /Scan 18 0 R >> >>";
	const page = (contents: number, extra = "") =>
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 780] ${resources} /Contents ${contents} 0 R ${extra} >>`;
	return pdfObjects([
		"<< /Type /Catalog /Pages 2 0 R /Outlines 14 0 R /Names << /Dests 17 0 R >> >>",
		"<< /Type /Pages /Count 3 /Kids [3 0 R 4 0 R 5 0 R] >>",
		page(9, "/Annots [12 0 R 13 0 R 20 0 R]"),
		page(10, "/CropBox [40 80 560 740] /Rotate 90 /Annots [19 0 R]"),
		page(11),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		"<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UTF16-H /DescendantFonts [8 0 R] >>",
		"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> >>",
		stream(
			"BT /JP 24 Tf 50 580 Td <65E5672C> Tj 0 -32 Td <8A9E> Tj ET\nBT /F1 18 Tf 45 305 Td (Footnote) Tj 0 -55 Td (Reference) Tj ET",
		),
		stream(
			`${image}\nBT 3 Tr /F1 22 Tf 330 610 Td (OCR passage) Tj ET\nBT 3 Tr /JP 20 Tf 190 300 Td <65E5672C8A9E> Tj ET`,
		),
		stream(image),
		"<< /Type /Annot /Subtype /Link /Rect [45 300 175 326] /Contents (Footnote) /Dest (note) >>",
		"<< /Type /Annot /Subtype /Link /Rect [45 245 215 270] /Contents (Reference) /A << /S /URI /URI (https://example.org/reference) >> >>",
		"<< /Type /Outlines /First 15 0 R /Last 15 0 R /Count 2 >>",
		"<< /Title (Chapter) /Parent 14 0 R /Dest [3 0 R /Fit] /First 16 0 R /Last 16 0 R /Count 1 >>",
		"<< /Title (Notes) /Parent 15 0 R /Dest [4 0 R /XYZ 400 610 6] >>",
		"<< /Names [(note) [4 0 R /XYZ 400 610 6]] >>",
		"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 3 >>\nstream\nDD>\nendstream",
		"<< /Type /Annot /Subtype /Link /Rect [120 180 165 208] /Contents (Sources) /A << /S /URI /URI (http://example.org/sources) >> >>",
		"<< /Type /Annot /Subtype /Link /Rect [45 190 170 218] /Contents (Email) /A << /S /URI /URI (mailto:editor@example.org) >> >>",
	]);
}

function pdfObjects(objects: string[]): Buffer {
	let pdf = "%PDF-1.7\n";
	const offsets = ["0000000000 65535 f "];
	for (const [index, object] of objects.entries()) {
		offsets.push(
			`${Buffer.byteLength(pdf).toString().padStart(10, "0")} 00000 n `,
		);
		pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	pdf +=
		"xref\n0 " +
		offsets.length +
		"\n" +
		offsets.join("\n") +
		"\ntrailer\n<< /Size " +
		offsets.length +
		" /Root 1 0 R >>\nstartxref\n" +
		Buffer.byteLength(pdf) +
		"\n%%EOF\n";
	return Buffer.from(pdf, "ascii");
}

export async function firstBookId(
	request: APIRequestContext,
	url: string,
): Promise<string> {
	let id = "";
	await expect
		.poll(async () => {
			const body: { status: string; books?: { id: string }[] } = await (
				await request.get(`${url}/api/library`)
			).json();
			id = body.status === "ready" ? (body.books?.[0]?.id ?? "") : "";
			return id;
		})
		.toMatch(/^[a-f0-9]{64}$/);
	return id;
}

export async function withLibrary<T>(
	books: readonly string[],
	use: (url: string, booksPath: string) => Promise<T>,
	pdf: Buffer = fixturePdf(),
): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "pageium-browser-"));
	try {
		const shelf = join(root, "books");
		await mkdir(shelf);
		await Promise.all(
			books.map((title) =>
				writeFile(
					join(shelf, `${title}.pdf`),
					title === "Broken PDF" ? "missing PDF header" : pdf,
				),
			),
		);
		const child = spawn(
			executable,
			[
				"--books",
				shelf,
				"--state",
				join(root, "state"),
				"--web",
				web,
				"--listen",
				"127.0.0.1:0",
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		const exit = new Promise<void>((resolve) =>
			child.once("close", () => resolve()),
		);
		try {
			const url = await new Promise<string>((resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("Timed out starting Pageium")),
					6_000,
				);
				child.once("error", (error) => {
					clearTimeout(timeout);
					reject(error);
				});
				child.once("exit", (code) => {
					clearTimeout(timeout);
					reject(new Error(`Pageium exited: ${code}`));
				});
				let logs = "";
				child.stderr.on("data", (data: Buffer) => {
					logs += data.toString();
					const match = /listen=(127\.0\.0\.1:\d+)/.exec(logs)?.[1];
					if (match) {
						clearTimeout(timeout);
						resolve(`http://${match}`);
					}
				});
			});
			return await use(url, shelf);
		} finally {
			child.kill();
			await exit;
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
