-- Model routing: which model answered each assistant reply, and why.
-- See docs/decisions/0007-model-routing.md.
--
-- Additive only: four nullable columns. Old rows and user messages keep NULL.
-- The code that is live before this change does not read or write them, and
-- the existing row-level security policies (select and insert own rows) cover
-- the new columns. Updates stay revoked. No user content goes in these columns:
-- a model ID, a tier name, a reason code and a flag.

alter table public.messages
  add column model text
    check (model is null or (char_length(model) between 1 and 200 and model ~ '^[A-Za-z0-9._:/-]+$')),
  add column model_tier text
    check (model_tier is null or model_tier in ('fast', 'standard', 'heavy', 'vision')),
  add column route_reason text
    check (route_reason is null or route_reason ~ '^[a-z_]{1,40}$'),
  add column model_fallback boolean;

-- Only assistant replies carry a route.
alter table public.messages
  add constraint messages_route_assistant_only
    check (role = 'assistant' or (model is null and model_tier is null and route_reason is null and model_fallback is null));
