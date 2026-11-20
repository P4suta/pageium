---
date: 2026-11-20
status: proposed
---

# Browse the mounted folder hierarchy

## Context

The books mount already organizes PDFs into directories, but the shelf displays all titles together.

## Decision

Index directories and PDFs in the same scan and use the configured books directory as the library root.
List immediate children, including empty folders, and search descendants of the open folder.
Use catalog identifiers for folder links and show folder names in a linked breadcrumb.
Keep the flat catalog available to existing API clients.
[Breadcrumb pattern](https://www.w3.org/WAI/ARIA/apg/patterns/breadcrumb/)

## Alternatives

App-managed collections could place a book under two subjects but would require organizing the same library twice.
Grouping PDFs by their parent paths would omit empty directories.

## Consequences

A rescan picks up changes made in the filesystem.
Moving a directory changes its link, and moving a PDF changes the identifier used for its reading position.
Revisit collections if readers need a book to appear in more than one place.

## Confirmation

Browse nested, empty, and renamed folders, search within one branch, and return from a PDF on both browser engines.
