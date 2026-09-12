-- Preserve the Admin contract: lowercase Spanish, vowel accents ignored, ñ kept.
-- No rows rewritten and no catalog/history foreign keys changed.
CREATE COLLATION IF NOT EXISTS public.exom_search_locale (provider = icu, locale = 'es', deterministic = true);
CREATE FUNCTION public.exom_normalize_search(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT normalize(regexp_replace(normalize(lower(value COLLATE public.exom_search_locale), NFD),
    U&'([aeiou])[\0300-\036f]+', '\1', 'g'), NFC)
$$;
