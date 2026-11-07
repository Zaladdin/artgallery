-- Run once after the gallery migration. Leaves any existing cloud draft unchanged.
begin;
with dimensions (number, width_px, height_px) as (
  values (1,2048,1531),(2,1334,2048),(3,1726,2048),(4,1732,2048),(5,1536,2048),
         (6,1510,2048),(7,2048,1536),(8,2048,1693),(9,2048,1622),(10,2048,1536)
), artwork as (
  select number, lpad(number::text, 2, '0') as label, width_px, height_px from dimensions
), payload as (
  select jsonb_build_object(
    'slug','ayten-sheydayeva','name','Айтен Шейдаева','years','','biography','',
    'aliases',jsonb_build_array('Айтен','Шейдаева','Ayten Sheydayeva'),
    'room',jsonb_build_object('wallColor','#e9e4da','frameColor','#171716'),
    'works',jsonb_agg(jsonb_build_object(
      'id','ayten-' || label, 'title','Картина ' || label, 'sourceFormat','JPG',
      'widthPx',width_px,'heightPx',height_px,'visible',true,'rightsConfirmed',false,
      'imageSrc','./assets/ayten/ayten-' || label || '.jpg',
      'sceneImageSrc','./assets/ayten/scene-' || label || '.jpg',
      'thumbnailSrc','./assets/ayten/thumb-' || label || '.jpg'
    ) order by number)
  ) as exhibition from artwork
), inserted as (
  insert into public.gallery_drafts (slug,draft)
  select 'ayten-sheydayeva',exhibition from payload
  on conflict (slug) do nothing
  returning slug,draft
)
insert into public.gallery_publications (slug,exhibition)
select slug,draft from inserted on conflict (slug) do nothing;
commit;
