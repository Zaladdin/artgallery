-- Gallery Cloud: apply once in the project's SQL Editor as the project owner.
-- No data import and no public buckets. Grant the owner role separately after
-- creating the owner's Auth user. Roll back the client to static mode if needed;
-- do not drop these tables or buckets on a project containing exhibitions.
begin;

create table public.gallery_admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create table public.gallery_drafts (
  slug text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  draft jsonb not null check (
    jsonb_typeof(draft) = 'object'
    and draft->>'slug' is not distinct from slug
    and octet_length(draft::text) <= 1048576
    and case when jsonb_typeof(draft->'works') = 'array'
             then jsonb_array_length(draft->'works') <= 100 else false end
  ),
  revision integer not null default 1 check (revision > 0)
);

create table public.gallery_publications (
  slug text primary key references public.gallery_drafts (slug),
  exhibition jsonb not null
);

alter table public.gallery_admins enable row level security;
alter table public.gallery_drafts enable row level security;
alter table public.gallery_publications enable row level security;

revoke all on public.gallery_admins, public.gallery_drafts, public.gallery_publications from public, anon, authenticated;
grant select, insert, update on public.gallery_drafts to authenticated;
grant select on public.gallery_publications to anon, authenticated;

create function public.gallery_is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.gallery_admins where user_id = (select auth.uid()));
$$;
revoke all on function public.gallery_is_admin() from public, anon, authenticated;
grant execute on function public.gallery_is_admin() to authenticated;

create policy gallery_drafts_owner_read on public.gallery_drafts for select to authenticated
  using ((select public.gallery_is_admin()));
create policy gallery_drafts_owner_insert on public.gallery_drafts for insert to authenticated
  with check ((select public.gallery_is_admin()));
create policy gallery_drafts_owner_update on public.gallery_drafts for update to authenticated
  using ((select public.gallery_is_admin())) with check ((select public.gallery_is_admin()));
create policy gallery_public_read on public.gallery_publications for select to anon, authenticated
  using (true);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('gallery-images', 'gallery-images', false, 8388608, array['image/jpeg']),
  ('gallery-originals', 'gallery-originals', false, 26214400, array['image/jpeg','image/png','image/heic','image/heif']);

-- Uploads are immutable; writes can neither overwrite a published object nor
-- change its MIME type. Failed staging files may be removed before being saved.
create policy gallery_owner_upload on storage.objects for insert to authenticated with check (
  (select public.gallery_is_admin()) and (
    (bucket_id = 'gallery-images' and name ~ '^[a-z0-9][a-z0-9-]{0,79}/[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}/(full|scene|thumb)\.jpg$') or
    (bucket_id = 'gallery-originals' and name ~ '^[a-z0-9][a-z0-9-]{0,79}/[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}/original$')
  )
);
create policy gallery_owner_media_read on storage.objects for select to authenticated using (
  bucket_id in ('gallery-images', 'gallery-originals') and (select public.gallery_is_admin())
);
create policy gallery_public_media_read on storage.objects for select to anon, authenticated using (
  bucket_id = 'gallery-images'
  and name ~ '^[a-z0-9][a-z0-9-]{0,79}/[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}/(full|scene|thumb)\.jpg$'
  and exists (
    select 1 from public.gallery_publications as published
    where published.slug = split_part(objects.name, '/', 1)
      and published.exhibition->'works' @> jsonb_build_array(jsonb_build_object('id', split_part(objects.name, '/', 2)))
  )
);
create policy gallery_owner_cleanup_staging on storage.objects for delete to authenticated using (
  bucket_id in ('gallery-images', 'gallery-originals') and (select public.gallery_is_admin())
  and not exists (
    select 1 from public.gallery_drafts as saved
    where saved.slug = split_part(objects.name, '/', 1)
      and saved.draft->'works' @> jsonb_build_array(jsonb_build_object('id', split_part(objects.name, '/', 2)))
  )
  and not exists (
    select 1 from public.gallery_publications as published
    where published.slug = split_part(objects.name, '/', 1)
      and published.exhibition->'works' @> jsonb_build_array(jsonb_build_object('id', split_part(objects.name, '/', 2)))
  )
);

create function public.gallery_publish(p_slug text, p_revision integer, p_publish boolean)
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  saved public.gallery_drafts%rowtype;
  work jsonb;
  work_id text;
  work_number text;
  published_work jsonb;
  works jsonb := '[]'::jsonb;
  ids text[] := array[]::text[];
  asset_root text;
  next_revision integer;
begin
  if not public.gallery_is_admin() then
    raise exception 'Admin access is required' using errcode = '42501';
  end if;
  if p_publish is null then
    raise exception 'Publication state is required' using errcode = '22023';
  end if;
  select * into saved from public.gallery_drafts where slug = p_slug for update;
  if not found then
    raise exception 'Exhibition not found' using errcode = 'PT404';
  end if;
  if saved.revision is distinct from p_revision then
    raise exception 'Exhibition has changed; refresh the editor' using errcode = 'PT409';
  end if;

  if p_publish then
    if jsonb_typeof(saved.draft->'name') is distinct from 'string'
       or char_length(btrim(saved.draft->>'name')) not between 1 and 200 then
      raise exception 'Artist name is required' using errcode = '22023';
    end if;
    for work in select value from jsonb_array_elements(saved.draft->'works') loop
      if work->'visible' = 'false'::jsonb then continue; end if;
      if work->'rightsConfirmed' is distinct from 'true'::jsonb then
        raise exception 'Confirm publishing rights for all visible works' using errcode = '22023';
      end if;
      work_id := work->>'id';
      if work_id is null or work_id = any(ids)
         or jsonb_typeof(work->'title') is distinct from 'string'
         or char_length(btrim(work->>'title')) not between 1 and 200 then
        raise exception 'Invalid or duplicate artwork' using errcode = '22023';
      end if;
      if jsonb_typeof(work->'widthPx') is distinct from 'number'
         or jsonb_typeof(work->'heightPx') is distinct from 'number' then
        raise exception 'Artwork dimensions are required' using errcode = '22023';
      end if;
      if (work->>'widthPx')::numeric not between 1 and 50000
         or (work->>'heightPx')::numeric not between 1 and 50000 then
        raise exception 'Invalid artwork dimensions' using errcode = '22023';
      end if;
      ids := array_append(ids, work_id);
      -- Rebuild the snapshot from allowlisted display metadata. Never copy
      -- upload names, original URLs, signed URLs or arbitrary client metadata.
      published_work := jsonb_strip_nulls(jsonb_build_object(
        'id', work_id, 'title', left(work->>'title', 200),
        'description', left(work->>'description', 10000),
        'year', left(work->>'year', 40), 'medium', left(work->>'medium', 200),
        'widthPx', work->'widthPx', 'heightPx', work->'heightPx',
        'widthCm', case when jsonb_typeof(work->'widthCm') = 'number' then work->'widthCm' end,
        'heightCm', case when jsonb_typeof(work->'heightCm') = 'number' then work->'heightCm' end,
        'visible', true, 'rightsConfirmed', true
      ));
      if p_slug = 'ayten-sheydayeva' and work_id ~ '^ayten-(0[1-9]|10)$' then
        work_number := right(work_id, 2);
        published_work := published_work || jsonb_build_object(
          'imageSrc', './assets/ayten/ayten-' || work_number || '.jpg',
          'sceneImageSrc', './assets/ayten/scene-' || work_number || '.jpg',
          'thumbnailSrc', './assets/ayten/thumb-' || work_number || '.jpg'
        );
      else
        if work_id !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then
          raise exception 'Invalid uploaded artwork ID' using errcode = '22023';
        end if;
        asset_root := p_slug || '/' || work_id || '/';
        if (select count(*) from storage.objects where bucket_id = 'gallery-images'
            and name in (asset_root || 'full.jpg', asset_root || 'scene.jpg', asset_root || 'thumb.jpg')) <> 3 then
          raise exception 'Upload all prepared images before publishing' using errcode = '22023';
        end if;
      end if;
      works := works || jsonb_build_array(published_work);
    end loop;
    if jsonb_array_length(works) = 0 then
      raise exception 'At least one visible artwork is required' using errcode = '22023';
    end if;
    insert into public.gallery_publications (slug, exhibition)
    values (p_slug, jsonb_build_object(
      'slug', p_slug, 'name', btrim(saved.draft->>'name'),
      'years', coalesce(left(saved.draft->>'years', 80), ''),
      'biography', coalesce(left(saved.draft->>'biography', 20000), ''),
      'aliases', case when jsonb_typeof(saved.draft->'aliases') = 'array' then coalesce((
        select jsonb_agg(left(alias, 200))
        from (select value #>> '{}' as alias from jsonb_array_elements(saved.draft->'aliases')
              where jsonb_typeof(value) = 'string' limit 20) as aliases
      ), '[]'::jsonb) else '[]'::jsonb end,
      'room', jsonb_strip_nulls(jsonb_build_object(
        'wallColor', case when saved.draft->'room'->>'wallColor' ~ '^#[a-fA-F0-9]{6}$' then saved.draft->'room'->>'wallColor' end,
        'frameColor', case when saved.draft->'room'->>'frameColor' ~ '^#[a-fA-F0-9]{6}$' then saved.draft->'room'->>'frameColor' end
      )),
      'works', works
    )) on conflict (slug) do update set exhibition = excluded.exhibition;
  else
    delete from public.gallery_publications where slug = p_slug;
  end if;

  update public.gallery_drafts set revision = revision + 1 where slug = p_slug returning revision into next_revision;
  return next_revision;
end;
$$;

revoke all on function public.gallery_publish(text, integer, boolean) from public, anon, authenticated;
grant execute on function public.gallery_publish(text, integer, boolean) to authenticated;

commit;
