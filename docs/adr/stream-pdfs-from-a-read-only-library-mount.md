---
date: 2026-11-19
status: proposed
---

# Stream PDFs from a read-only library mount

## Context

Pageium runs on a Raspberry Pi and reads scanned PDFs from a Synology network-attached storage (NAS) device.
The library can exceed the Pi's local storage.

## Decision

Use a read-only Server Message Block (SMB) mount and give Pageium a directory within it.
The server indexes file metadata and streams the requested byte ranges.
PDF.js renders pages and covers on the browsing device.
SQLite stores the reading position on the Pi.
[Mount options](https://manpages.debian.org/trixie/cifs-utils/mount.cifs.8.en.html), [HTTP ranges](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests), [PDF.js loading options](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html#~DocumentInitParameters)

## Alternatives

Synchronizing the PDFs onto the Pi would preserve browsing through a NAS outage and consume local storage proportional to the library.
An integrated SMB client would simplify mounting and make Pageium handle credentials and reconnection.

## Consequences

Books depend on SMB availability and the client needs capacity to render a scan.
Revisit the decision if reading during NAS outages becomes necessary or representative scans are too heavy for the browsing device.

## Confirmation

Check range responses, mount failure, and progress across a restart with fixtures.
Open a book from the configured mount on the Pi.
