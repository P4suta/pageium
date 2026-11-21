---
date: 2026-11-21
status: superseded
---

# Search the open book on demand

## Context

Scans can contain invisible text, and opening a long book should require only nearby pages.

## Decision

Keep the [preview-first reader](preview-pages-before-rendering-visible-detail.md) and overlay selectable text and links on visible pages.
Start PDF.js text extraction across the book with the first search query and release the search data when the book closes.
Read the outline when requested and use PDF page coordinates for outline and annotation destinations.
[PDF.js display API](https://mozilla.github.io/pdf.js/api/draft/api.js.html), [PDF.js find controller](https://github.com/mozilla/pdf.js/blob/master/web/pdf_find_controller.js)

Readers can open and dismiss search and contents with the keyboard.
Match counts appear beside the search field while keyboard focus stays in place.
[Keyboard access](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html), [disclosure controls](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/), [status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)

## Alternatives

A server index could answer repeat searches without rereading the PDF, but would require extracting and storing text for books that nobody searches.

## Consequences

A first search can fetch every page of the open PDF.
[Server-prepared book text](prepare-book-text-on-the-library-server.md) supersedes on-demand extraction for prepared books.

## Confirmation

Check partial reads before searching, split Japanese text, selection of invisible text, and navigation on rotated pages in Chromium and WebKit.
