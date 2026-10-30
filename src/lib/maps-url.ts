import { MAX_SAFE_URL_CHARS, toSafeHttpUrl } from "./safe-url";

const MAPS_SEARCH = "https://www.google.com/maps/search/?api=1&query=";

/**
 * A Google Maps search link that P-Dot builds from a place's name and area.
 * The model never supplies the URL. Null when the link would be too long.
 */
export function mapsSearchUrl(place: { name: string; area?: string; city?: string }): string | null {
  const query = [place.name, place.area, place.city]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");
  if (!query) return null;
  let url: string;
  try {
    url = MAPS_SEARCH + encodeURIComponent(query);
  } catch {
    // A lone surrogate makes encodeURIComponent throw. No link then, and the card still shows.
    return null;
  }
  if (url.length > MAX_SAFE_URL_CHARS) return null;
  return toSafeHttpUrl(url);
}
