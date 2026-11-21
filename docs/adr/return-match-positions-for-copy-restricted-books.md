---
date: 2026-11-21
status: accepted
---

# Return match positions for copy-restricted books

## Context

Many books open without a password and restrict copying.
Skipping every encrypted file leaves those readers waiting for a full PDF scan.

## Decision

Prepare text locally for books that open without credentials.
Check the PDF.js copy permission before serving [prepared page text](prepare-book-text-on-the-library-server.md).
For copy-restricted books, run the same PDF.js matcher on the server and return only page numbers, offsets, and lengths.
[PDF.js permissions](https://github.com/mozilla/pdf.js/blob/v6.5.438/src/shared/util.js), [PDF.js find controller](https://github.com/mozilla/pdf.js/blob/v6.5.438/web/pdf_find_controller.js)

## Alternatives

Searching the original on the device preserves navigation but repeats text extraction on each new device.

## Consequences

Each new query in a restricted book takes one server round trip.
Keep password-required books outside the cache.
Revisit worker capacity if concurrent searches spend most of their time in the queue.

## Confirmation

Compare match counts and highlights across both paths.
Check that a restricted fixture exposes positions, a password-required fixture exposes no text, and a fresh device finds matches without reading distant PDF ranges.
