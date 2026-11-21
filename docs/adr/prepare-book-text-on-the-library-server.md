---
date: 2026-11-21
status: accepted
---

# Prepare book text on the library server

## Context

Readers wait for sequential PDF page reads when first searching a scanned book on a fresh device.

## Decision

After a scan, read one book at a time with the reader's PDF.js version and store compressed page text by file and extractor revision.
Fetch the text on the first query and use the PDF.js find controller for normalization, match offsets, and navigation.
Keep visible text geometry in the reader and use [on-demand extraction](search-the-open-pdf-on-demand.md) while preparation is unavailable.
[PDF.js find controller](https://github.com/mozilla/pdf.js/blob/v6.5.438/web/pdf_find_controller.js)

## Alternatives

Device-local caching saves server work but requires every new device to read each book once.
A server-side term index could search the whole library, but mapping results to highlighted PDF text would require another normalization contract.

## Consequences

Preparation consumes server time and local disk space.
Apply the [copy-permission decision](return-match-positions-for-copy-restricted-books.md) and discard obsolete file revisions.
Revisit query execution if matching prepared text becomes the main source of latency.

## Confirmation

Time the first complete match count on a fresh client before and after preparation using the same book.
Check Japanese and invisible text highlights, partial PDF reads, replacement, restart, and fallback.
