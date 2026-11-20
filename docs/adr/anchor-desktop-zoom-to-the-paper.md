---
date: 2026-11-20
status: proposed
---

# Anchor desktop zoom to the paper

## Context

Browser magnification and reader scrolling can move different viewports during a trackpad gesture.
A long book can exhaust the browser's layout coordinate range when every page grows.

## Decision

Use one reader scale for desktop pinches and zoom controls.
Keep the paper point under the pointer during a pinch.
Transform nearby painted pages during a gesture and commit their sizes on release.
Let a vertical scroll settle at a nearby page start at the fitted scale.
Keep magnified pages free to pan and honor reduced motion.
Fit width sets the base page size.
Magnify nearby pages and preserve the reading point when the group changes.
Keep native touchscreen zoom and [viewport detail rendering](preview-pages-before-rendering-visible-detail.md).
[Safari gesture events](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/HandlingEvents/HandlingEvents.html), [Transform rendering](https://www.w3.org/TR/css-transforms-1/#transform-rendering), [Scroll snap strictness](https://www.w3.org/TR/css-scroll-snap-1/#scroll-snap-strictness)

## Alternatives

Native desktop magnification preserves browser gestures but leaves the reader's horizontal scroll range unchanged.

## Consequences

Distant pages occupy their fitted height until approached.
Revisit the range if navigation loses the reading point in mixed-size books.

## Confirmation

Check reversals at the limit, horizontal edges, both fit modes, and distant pages in a long book.
