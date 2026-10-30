# 0019: More document types: text, code, CSV, PDF, Word and images

- Status: Proposed (2026-10-30).
- Related: [0009 documents](0009-memory-documents-actions.md), [0006 spend guard](0006-global-spend-guard.md), [0007 model routing](0007-model-routing.md), [0015 trial](0015-judge-demo-mode.md).
- Code: `src/lib/document-types.ts`, `src/features/documents/file.ts`, `src/features/documents/extract.ts`, `src/app/api/documents/image-text/route.ts`, `src/server/assistant/image-text.ts`, `supabase/migrations/20261101000000_document_media_types.sql`.

## Problem

The owner asked that Documents accept all kinds of text, image and CSV files, but not videos. Before this change, Documents accepted only `.txt` and `.md`.

## Decision

- **The body stays text.** P-Dot reads the text out of the file at upload. Search, chunks, embeddings and RLS do not change. P-Dot does not keep the file.
- **Text files are read in the browser** with `file.text()`: CSV, TSV, JSON, XML, YAML, log, `.ics`, `.vcf`, `.rtf` (as raw text) and common code files. HTML is read the same way, then P-Dot removes scripts, styles, comments and tags. The text is stored and searched, never shown as HTML.
- **PDF and Word (.docx) are read in the browser** with `pdfjs-dist` (Apache-2.0) and `mammoth` (BSD-2-Clause). Both load only when such a file is chosen. The PDF parser runs on the page, with no worker file. A PDF with no text gets "This PDF has no text we can read. Try an image of the page instead."
- **Images** (PNG, JPEG, WebP, GIF): the browser makes a JPEG copy with the long side at most 1,600 px and sends it once to `POST /api/documents/image-text`. That route calls the vision tier one time. It asks for the exact text in the image, then a short description, and gives back that text. The user then adds it as a document with the original image type. P-Dot does not keep the image, and the UI says so.
- **The image call has the same guards as chat.** It needs a signed-in user (a trial user too) and a same-origin request. The body has a 4 MB limit and must be a JPEG data URL with the JPEG signature. It uses the per-user request quota, then one spend hold for each attempt, with this user's caps (trial caps for a trial) and the global caps. Each image counts as 16,384 input tokens in the worst-case hold (`TOKENS_PER_IMAGE`); the settle uses the real usage. The log has only metadata: no image and no text. The model output is untrusted text, as all document text is.
- **Refused:** video and audio files, by extension and by the browser's type ("Videos and audio files are not supported."). Unknown types get a message that lists what is supported. Old Word `.doc` files get a message to save them as `.docx`.
- **Limits:** text files keep the 512 KB file limit. PDF, Word and image files can be up to 10 MB. The extracted text keeps the 100,000-character limit.
- **Database:** a new migration widens the `documents.media_type` check to the 13 types. It is expand only: every existing row passes. Apply it before the code is deployed, because the old check refuses the new types.

## Checklist

- Trust boundary: the server checks the session, the origin, the body size, the media type list and the image signature. The browser checks are for the user only.
- Cost: one vision call for each image, under the quota and every spend cap. No model call for other types beyond the existing embeddings.
- Privacy: no image is stored or logged. Text is never logged.
- Failure: a refused or failed image read saves nothing. The user can try again.
- Rollback: the code can go back without the migration; the wider check accepts the old types.

## Limits

- Scanned PDFs are refused, not sent to the vision model. The user can add an image of the page.
- A PDF is read page by page on the main thread; a very large PDF can make the page slow for some seconds.
- The image read costs a model call before the user presses Add. If the user then cancels, that call is still counted.
- `.rtf` is kept as raw text with its control words.
- The quality of the image text depends on the vision model; no live evaluation has been run.
