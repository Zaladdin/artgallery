// Browser credentials: access is controlled by Supabase RLS, not by this key.
export const supabaseUrl = 'https://mwfygbsbgbjyrjjwvefd.supabase.co';
export const supabasePublishableKey = 'sb_publishable_I4UhxGzBFjHpfKBDN1fqww_DESYdyjP';

export function usesCloudGallery(url = new URL(location.href)) {
  return url.origin === 'https://zaladdin.github.io' ||
    (['localhost', '127.0.0.1'].includes(url.hostname) && url.searchParams.get('backend') === 'supabase');
}

export function isCloudMediaUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === supabaseUrl && !url.username && !url.password && !url.hash &&
      /^\/storage\/v1\/object\/sign\/gallery-images\/[a-z0-9][a-z0-9-]{0,79}\/[0-9a-f-]{36}\/(?:full|scene|thumb)\.jpg$/.test(url.pathname) &&
      [...url.searchParams.keys()].length === 1 && /^[a-zA-Z0-9._-]+$/.test(url.searchParams.get('token') || '');
  } catch { return false; }
}
