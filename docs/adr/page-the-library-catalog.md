---
date: 2026-11-19
status: proposed
---

# Page the library catalog

## Context

Large shelves need bounded transfers and card counts during browsing.

## Decision

The browser requests up to 48 books at a time and loads the next batch as the shelf approaches the viewport.
It keeps nearby and focused cards mounted and reserves the space of batches outside that range.
Search matches titles and folder names on the server.
A book lookup returns its metadata and saved position by identifier.
Keep the unpaged library endpoint behavior for existing callers.

## Alternatives

Client-side virtualization alone preserves continuous scrolling and keeps the cost of transferring the full catalog.
Pagination controls provide direct jumps and interrupt scrolling between batches.

## Consequences

Each active shelf retains the order and the position used before opening a book.
Later requests keep the first batch's pinned book and check the catalog revision before appending.
Revisit the catalog representation if scanning or filtering a representative library becomes the dominant delay.

## Confirmation

Verify automatic loading, search, retained focus, and return from a long book.
Compare shelf loading with 5,000 PDF files and resume reading in a multi-thousand-page scan.
