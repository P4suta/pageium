export function element<Tag extends keyof HTMLElementTagNameMap>(
	tag: Tag,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[Tag] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

type Icon = "book" | "folder" | "arrow-left" | "scan" | "alert" | "search";

export function icon(name: Icon): HTMLSpanElement {
	const node = element("span", `icon icon--${name}`);
	node.setAttribute("aria-hidden", "true");
	return node;
}

export function message(
	title: string,
	detail: string,
	symbol?: Icon,
): HTMLElement {
	const box = element("section", "message");
	box.setAttribute("role", "status");
	if (symbol) box.append(icon(symbol));
	box.append(
		element("h2", "message-title", title),
		element("p", "message-detail", detail),
	);
	return box;
}
