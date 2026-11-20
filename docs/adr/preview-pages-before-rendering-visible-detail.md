---
date: 2026-11-20
status: proposed
---

# Preview pages before rendering visible detail

## Context

Opening and turning pages can repeat PDF decoding.

## Decision

Extend [PDF streaming](stream-pdfs-from-a-read-only-library-mount.md) with previews keyed by book version and page.
Prepare recent covers during scans and preview the saved page on opening.
Keep whole pages beneath detail rendered at display density after motion settles.
[Poppler page rendering](https://manpages.debian.org/trixie/poppler-utils/pdftoppm.1.en.html), [PDF.js detail view](https://github.com/mozilla/pdf.js/blob/master/web/pdf_page_detail_view.js), [Visual viewport](https://drafts.csswg.org/cssom-view/#visualViewport)

Render visible pages first.
During pauses or sustained reading on one page, render each adjacent original within 4,194,304 pixels, starting in the reading direction.
Decode previews serially up to four pages ahead and two behind.
Release distant pages.
[PDF.js rendering queue](https://github.com/mozilla/pdf.js/blob/master/web/pdf_rendering_queue.js)

## Alternatives

Rendering entire scans at full resolution consumes hundreds of megabytes per page.

## Consequences

The Pi serializes conversions and bounds the preview cache.
Revisit the window if page turns still expose loading.

## Confirmation

Check cold and repeat visits, restored pages, fine lines, native macOS zoom, page turns, and jumps during pending requests.
