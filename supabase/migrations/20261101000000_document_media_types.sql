-- Documents can come from more file types (decision 0019). The body is still
-- text that the browser or the image text route reads out of the file, so
-- only the media_type check changes. RLS, grants and the other checks stay.
--
-- Expand only: every existing row ('text/plain' or 'text/markdown') passes the
-- new check. Apply this before the code that sends the new types is deployed.

alter table public.documents drop constraint documents_media_type_check;

alter table public.documents
  add constraint documents_media_type_check check (
    media_type in (
      'text/plain',
      'text/markdown',
      'text/csv',
      'text/tab-separated-values',
      'application/json',
      'text/html',
      'application/xml',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif'
    )
  ) not valid;

alter table public.documents validate constraint documents_media_type_check;
