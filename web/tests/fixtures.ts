import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("../dist", import.meta.url));
const executable = fileURLToPath(
	new URL("../../target/debug/pageium", import.meta.url),
);

export function fixturePdf({
	pages = 8,
	pagePadding = 24_000,
}: {
	pages?: number;
	pagePadding?: number;
} = {}): Buffer {
	const kids = Array.from({ length: pages }, (_, index) => `${4 + index} 0 R`);
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Count ${pages} /Kids [${kids.join(" ")}] >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	for (let page = 1; page <= pages; page += 1) {
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 780] /Resources << /Font << /F1 3 0 R >> >> /Contents ${3 + pages + page} 0 R >>`,
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

export async function withLibrary<T>(
	books: readonly string[],
	use: (url: string) => Promise<T>,
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
			return await use(url);
		} finally {
			child.kill();
			await exit;
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
