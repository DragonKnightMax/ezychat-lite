# Workbook: Open PDFs and photos inside the app

Branch: `claude/focused-cray-09aygy` · Every agent updates its stage with
`node scripts/build-summary.mjs record <stage> <status> "<detail>"` and commits it with the work.

| Stage | Status | Detail | Commit | Updated |
| --- | --- | --- | --- | --- |
| Design | skip | No HTML mock (reuses the image-preview frame); owner asked to merge 2026-11-03 after the screenshots | ce48bae | 2026-11-03 |
| Dev | done | lib/pdf.ts (pdf.js 6.4.299, lazy), inbox/PdfViewer.tsx, MediaView open + download, en/ms/zh-CN | ce48bae | 2026-11-03 |
| Unit tests | done | npm test all pass; pdf 7, PdfViewer 6, MessageCopy, web-client-contract | ce48bae | 2026-11-03 |
| E2E | done | npm run e2e: 144 passed, 27 skipped, 0 failed; pdf-viewer.spec.ts desktop + mobile | ce48bae | 2026-11-03 |
| Dev Build | todo | Windows desktop app: open a real customer PDF (and a CJK PDF) from a linked number; not run in this cloud session |  | 2026-11-03 |
| Screen review | done | Viewer + bubble at 1280/360, light/dark; viewer made opaque after review | ce48bae | 2026-11-03 |

## Log

- 2026-11-03 Dev: done — pdf.js viewer, image-file preview, translations
- 2026-11-03 Unit tests: done — new and touched files only
- 2026-11-03 E2E: done — pdf-viewer.spec.ts desktop + mobile
- 2026-11-03 Screen review: done — 1280/360 light/dark, background made opaque
- 2026-11-03 E2E: done — npm run e2e: 144 passed, 27 skipped, 0 failed; pdf-viewer.spec.ts desktop + mobile (ce48bae)
- 2026-11-03 Screen review: done — Viewer + bubble at 1280/360, light/dark; viewer made opaque after review (ce48bae)
- 2026-11-03 Design: skip — No HTML mock (reuses the image-preview frame); owner asked to merge 2026-11-03 after the screenshots (ce48bae)
- 2026-11-03 Dev: done — lib/pdf.ts (pdf.js 6.4.299, lazy), inbox/PdfViewer.tsx, MediaView open + download, en/ms/zh-CN (ce48bae)
- 2026-11-03 Unit tests: done — npm test all pass; pdf 7, PdfViewer 6, MessageCopy, web-client-contract (ce48bae)
