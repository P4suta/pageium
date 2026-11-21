# Verification

Run the fast checks and browser scenarios from the project directory.

```sh
mise x -- just build
mise x -- just check
mise x -- just browser
mise x -- just audit
```

The Rust tests exercise file identity, library scans, reading positions, static asset negotiation, and HTTP byte ranges.
The process test starts the executable, requests its health endpoint, and checks graceful termination.

The library scans its books folder at startup and on explicit scan requests.
The Rust tests check that overlapping requests share a scan and that a failed scan preserves the last catalog.
[Scan request semantics](https://www.rfc-editor.org/rfc/rfc9110.html#name-post)

The browser scenarios use synthetic PDFs with Chromium and WebKit.
They exercise resuming a book, narrow layouts, partial reads of large PDFs, corrupt PDFs, and leaving the reader during module loading.
They check that scrolling loads batches of up to 48 books and that distant batches release their cards.
They exercise search, visible focus after returning, and a rapid seek followed by leaving the reader during a delayed bookmark write.
[Intersection Observer](https://www.w3.org/TR/intersection-observer/#intersection-observer-interface), [HTML search controls](https://html.spec.whatwg.org/multipage/input.html#text-(type=text)-state-and-search-state-(type=search)), [Unobscured focus](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html)

The rescan scenario checks that the library reports scan progress and failure, retains keyboard focus and the search query, and accepts a retry.
[Status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)

The cover test checks full-frame sizing, constant zoom during hover, and the reduced-motion preference.
The rescan test checks for a cached cover before the first browser visit.
The scan test checks black and white pixels on both the cover and the reading page of a fax-compressed PDF.
The color scan test samples red and blue patches on pages with `DCTDecode` and `JPXDecode` images.
The print test checks the ink in a JBIG2 image and distinguishes three Japanese glyphs in a PDF using a predefined character map and an unembedded font.
The reader tests delay the PDF module to check a rotated and cropped saved page.
They exercise password entry and recovery from a failed document request.
[CSS cover sizing](https://www.w3.org/TR/css-images-3/#the-object-fit), [Animation from interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)

The page-turn tests sample the prepared canvas on twelve successive frames at double pixel density.
They check the preview window during a slow scroll and after a reversal.
They hold a preview response and a PDF byte range independently while jumping to a distant page.
[PDF.js rendering queue](https://github.com/mozilla/pdf.js/blob/master/web/pdf_rendering_queue.js)

To repeat a page turn with a PDF from a live library, open the reader through a loopback proxy that forwards only `GET` and `HEAD` requests.
The proxy can acknowledge reading-position writes locally, including keepalive requests when the browser closes.
Compare the saved positions before and after the replay.

The detail tests check fine lines after zooming and panning, physical pixel density after a mobile pinch, and the canvas size limit.
They also sample the paper on successive animation frames while zoom and pan change with page previews unavailable.
The zoom control test checks intermediate sizes, a stable reading point, and immediate resizing when the reader prefers reduced motion.
The desktop trackpad tests check an off-center point through 8× magnification in both fit modes.
They measure paper size during each frame and check that a pause during a pinch keeps the painted canvas.
They scroll the reader during the pause and check that the paper point stays under the pointer.
They reverse at the limit, scroll horizontally, and navigate near the end of an 816-page book.
The control reports magnification relative to the fitted page.
[HTML output](https://html.spec.whatwg.org/multipage/form-elements.html#the-output-element)

On macOS, the WebKit test uses the system WebKit framework and Xcode command-line tools to magnify a saved page.
It sends AppKit magnification events through the web view and checks the reading point and paper pixels.
It samples the displayed pixels and checks detail alignment while zooming out.
[WebKit magnification](https://developer.apple.com/documentation/webkit/wkwebview/setmagnification(_:centeredat:)), [Visual viewport](https://drafts.csswg.org/cssom-view/#the-visualviewport-interface)

The folder scenarios exercise nested directories, empty folders, browser history, recursive search, and returning from the reader.
The HTTP tests check the boundary between sibling folders, pagination across folders and books, and the catalog revision after an empty directory disappears.
[Breadcrumb navigation](https://www.w3.org/WAI/ARIA/apg/patterns/breadcrumb/)

The press test checks inset shadows on a book card, the Fit width toggle, and the Rescan library button.
It checks the cover dimensions while the card moves.
With reduced motion, an inset shadow indicates a press.
[Activation pseudo-class](https://www.w3.org/TR/selectors-4/#the-active-pseudo), [Inset shadows](https://www.w3.org/TR/css-backgrounds-3/#the-box-shadow)

The reader theme tests compare search and contents with the shelf and the Fit width button in light and dark appearances.
They check the panel surfaces, the inset search field, and the outline around a search match.
[Use of color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html), [Non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)

The first-search scenarios count matches while a distant PDF byte range is unavailable and check highlights across Japanese line breaks and invisible text from optical character recognition.
They replace a prepared PDF and check that the server removes its obsolete text.
The password scenario checks that the cache excludes books that require a password.
The copy-restriction scenario checks that the server returns match positions and keeps the prepared text private.
[PDF.js find controller](https://github.com/mozilla/pdf.js/blob/v6.5.438/web/pdf_find_controller.js)

The wheel tests approach page starts from both directions and check that the fitted reader snaps into place.
They check free scrolling inside tall pages, while magnified, and with reduced motion.
Returning to the fitted scale preserves the reading point until the next vertical scroll.
The scroll tests reverse direction across pages at double size and release a delayed landscape preview for a preceding page.
They check the visible position during the scroll and after the page dimensions settle.
[Proximity snapping](https://www.w3.org/TR/css-scroll-snap-1/#scroll-snap-strictness), [Tall snap areas](https://www.w3.org/TR/css-scroll-snap-1/#snap-overflow), [Scroll positions](https://drafts.csswg.org/cssom-view/#scrolling)

The reader fits a full page to the available width and height while preserving its aspect ratio.
The reader fills the viewport and displays its controls in an overlay.
The Fit width toggle expands pages to the width of the reading area.
[Container-relative dimensions](https://www.w3.org/TR/css-contain-3/#container-lengths), [Disclosure controls](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/), [Toggle buttons](https://www.w3.org/WAI/ARIA/apg/patterns/button/)

The reader controls appear when the mouse pointer enters the expanded header area or the 24 CSS pixels below it.
The header starts to close when the mouse pointer leaves the reveal area or the viewport.
Keyboard focus within the header keeps it open.
Escape starts closing the header while the pointer stays in place.
[Content on hover or focus](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html)

The header slides through the top edge of the viewport when opening and closing.
If the pointer reenters the reveal area during closing, the slide reverses from its current position.
[Interrupted CSS transitions](https://www.w3.org/TR/css-transitions-1/#reversing)

The reader animates the header when the browser reports `prefers-reduced-motion: no-preference`.
[Animation from interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)

The reader disables the header controls when closing begins.
[Inert controls](https://html.spec.whatwg.org/multipage/interaction.html#inert-subtrees)

A tap on the reading area toggles the controls, and Tab brings the Reader controls button into view.
[Pointer input and keyboard access](https://www.w3.org/TR/pointerevents3/#introduction)

The Chromium scenarios use Chrome's new headless mode to exercise PDF canvas rendering.
[Playwright Chromium headless modes](https://playwright.dev/docs/browsers#chromium-new-headless-mode)

The mobile Lighthouse audit checks a 40 KiB transfer budget for an empty shelf, accessibility, browser practices, and console errors.
The populated shelf audit checks that the browser fetches only the preview images for its books and keeps the total transfer below 100 KiB.

Run the proof and mutation campaigns through the bounded verification image.

```sh
mise x -- just proofs
mise x -- just mutants
```

The three Kani harnesses check the production byte-range resolver for every combination of its unsigned 64-bit numeric inputs.
The harnesses compare each result with a wider integer model and check that admitted and rejected inputs are reachable.
The HTTP integration tests exercise header parsing and response delivery.
[HTTP range semantics](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests), [Kani proof harnesses](https://model-checking.github.io/kani/reference/attributes.html)

The mutation campaign runs the Rust test suite on each server mutation.
The report separates mutations that tests catch from compiler rejections and inconclusive runs.
[Cargo Mutants](https://mutants.rs/)
