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
[CSS cover sizing](https://www.w3.org/TR/css-images-3/#the-object-fit), [Animation from interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)

The press test checks inset shadows on a book card, the Fit width toggle, and the Rescan library button.
It checks the cover dimensions while the card moves.
With reduced motion, an inset shadow indicates a press.
[Activation pseudo-class](https://www.w3.org/TR/selectors-4/#the-active-pseudo), [Inset shadows](https://www.w3.org/TR/css-backgrounds-3/#the-box-shadow)

The reader test uses wheel gestures to check alignment near a page start and scrolling within a page taller than the reading area.
The reader enables proximity snapping with the browser's normal motion preference.
[CSS Scroll Snap](https://www.w3.org/TR/css-scroll-snap-1/#scroll-snap-strictness), [Tall pages](https://www.w3.org/TR/css-scroll-snap-1/#snap-overflow)

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
The populated shelf audit checks that the browser fetches the PDF worker within a 550 KiB transfer budget.

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
