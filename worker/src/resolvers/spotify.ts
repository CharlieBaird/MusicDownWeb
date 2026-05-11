// Spotify resolver — no credentials, no SpotAPI, no pathfinder GraphQL.
//
// We parse Spotify's public embed pages (open.spotify.com/embed/<kind>/<id>),
// which ship the metadata we need inside a <script id="__NEXT_DATA__"> JSON
// blob. No auth, no TOTP, no sp_dc cookie.
//
// Trade-off vs. SpotAPI's pathfinder (used by the sibling MusicDown project):
// playlists with > ~100 tracks may be returned by the embed endpoint already
// paginated. The embed page gives us as much as it has rendered; if a
// playlist comes back short, we surface a clear note and the user can split
// the playlist or use the album URL instead. Most albums and tracks are
// always complete via embed.
//
// ISRC is not exposed by embed (same as pathfinder under no-creds). Match
// downstream by (title, artist, duration).

import { emptyTrack, type ResolvedSource, type Track } from "../types.js";
import { ResolverError } from "./apple.js";

const PATTERNS: Record<"track" | "album" | "playlist", RegExp> = {
  track:    /open\.spotify\.com\/(?:intl-\w+\/)?track\/([A-Za-z0-9]+)/,
  album:    /open\.spotify\.com\/(?:intl-\w+\/)?album\/([A-Za-z0-9]+)/,
  playlist: /open\.spotify\.com\/(?:intl-\w+\/)?playlist\/([A-Za-z0-9]+)/,
};

const NEXT_DATA_RE = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function detect(url: string): { kind: "track" | "album" | "playlist"; id: string } {
  for (const kind of ["track", "album", "playlist"] as const) {
    const m = PATTERNS[kind].exec(url);
    if (m) return { kind, id: m[1]! };
  }
  throw new ResolverError(`Not a recognised Spotify URL: ${url}`);
}

async function fetchEmbed(kind: string, id: string): Promise<any> {
  const url = `https://open.spotify.com/embed/${kind}/${id}`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html,*/*", "Accept-Language": "en-US,en;q=0.9" },
    redirect: "follow",
  });
  if (r.status === 404) throw new ResolverError(`Spotify ${kind} not found (404): ${url}`);
  if (!r.ok) throw new ResolverError(`Spotify embed: ${r.status} fetching ${url}`);
  const html = await r.text();
  const m = NEXT_DATA_RE.exec(html);
  if (!m) throw new ResolverError(`Spotify embed: no __NEXT_DATA__ block — page shape changed`);
  try {
    return JSON.parse(m[1]!.trim());
  } catch (e) {
    throw new ResolverError(`Spotify embed: __NEXT_DATA__ parse failed: ${(e as Error).message}`);
  }
}

function entity(next: any): any {
  // Personalized content (Daily Mix, Discover Weekly, Made For You, the
  // various algorithmic Mix-Of-X playlists) is gated behind an authenticated
  // session. The embed endpoint refuses to render it: HTTP 200, but the
  // NEXT_DATA blob has `pageProps.status === 404` and no `state`. The `pt=`
  // share token is recognised but doesn't unlock the page either. Detect
  // and surface a user-actionable message rather than the generic shape
  // error — the frontend's friendlyError() picks up "personalized" / "mix"
  // and explains the situation.
  const pp = next?.props?.pageProps;
  if (pp?.status === 404 || (pp && !pp.state)) {
    throw new ResolverError(
      "Spotify: this playlist requires authentication — looks like a personalized Mix (Daily Mix, Discover Weekly, etc.). Only public, shared playlists work without an account.",
    );
  }
  const e = pp?.state?.data?.entity;
  if (!e) throw new ResolverError("Spotify embed: pageProps.state.data.entity missing");
  return e;
}

// Cover-art container shapes seen on the embed page:
//   coverArt:       { sources: [{ url, width, height }, ...] }   (playlists, sometimes albums)
//   visualIdentity: { image:   [{ url, maxWidth, maxHeight }, ...] }
// Pick the largest source by whichever size key is populated.
function largestCover(container: any): string | null {
  if (!container) return null;
  const list: any[] | undefined = container.sources ?? container.image;
  if (!Array.isArray(list) || list.length === 0) return null;
  const sized = list.filter((i: any) => i?.url);
  if (sized.length === 0) return null;
  sized.sort((a: any, b: any) =>
    (b.width ?? b.maxWidth ?? 0) - (a.width ?? a.maxWidth ?? 0),
  );
  return sized[0].url;
}

function pickArt(entity: any): string | null {
  // coverArt is the canonical key when present; visualIdentity is the fallback.
  return largestCover(entity?.coverArt) ?? largestCover(entity?.visualIdentity);
}

// Spotify's embed HTML literally contains `Â ` (mojibake of a
// non-breaking space) inside JSON-escaped subtitles. Normalise both that
// pair and the bare NBSP into a regular space so downstream matching is
// not thrown off.
function cleanText(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/Â /g, " ")
    .replace(/ /g, " ")
    .trim();
}

// Track entries inside `trackList` use `subtitle` for the artist string
// (comma-separated for multi-artist). Older shapes had an `artists` array;
// honour that first if present.
function artistFromTrackEntry(t: any, fallback: string | null): string {
  if (Array.isArray(t?.artists) && t.artists.length) {
    const names = t.artists.map((a: any) => a?.name).filter(Boolean).map(cleanText);
    if (names.length) return names.join(", ");
  }
  const sub = cleanText(t?.subtitle);
  if (sub) return sub;
  return fallback ?? "Unknown";
}

function trackIdFromUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const parts = String(uri).split(":");
  return parts[parts.length - 1] ?? null;
}

function resolveTrack(url: string, next: any): ResolvedSource {
  const e = entity(next);
  const albumName: string | null = cleanText(e?.album?.name) || null;
  const art = pickArt(e?.album) ?? pickArt(e);
  // The track entity itself uses the same `subtitle`/`artists` shape — fall
  // back to the entity-level `subtitle` if no per-track artist info exists.
  const artist = artistFromTrackEntry(e, cleanText(e?.subtitle) || null);
  const trackId = trackIdFromUri(e?.uri);
  const track: Track = {
    ...emptyTrack(),
    title: cleanText(e?.name ?? e?.title),
    artist,
    album: albumName,
    duration_ms: typeof e?.duration === "number" ? e.duration : null,
    track_number: typeof e?.trackNumber === "number" ? e.trackNumber : null,
    disc_number: typeof e?.discNumber === "number" ? e.discNumber : null,
    release_date: typeof e?.releaseDate?.isoString === "string"
      ? e.releaseDate.isoString.slice(0, 10) : null,
    artwork_url: art,
    source_url: trackId ? `https://open.spotify.com/track/${trackId}` : null,
  };
  return {
    kind: "track",
    title: track.title || "Track",
    tracks: [track],
    source_url: url,
    last_modified: null,
    provider: "spotify",
  };
}

function resolveAlbum(url: string, next: any): ResolvedSource {
  const e = entity(next);
  const albumName: string = cleanText(e?.title ?? e?.name) || "Album";
  const art = pickArt(e);
  // The album-level `subtitle` is the album artist; serves as fallback for
  // any track whose subtitle is empty (rare but possible on compilations).
  const albumArtist = cleanText(e?.subtitle) || null;
  const items: any[] = e?.trackList ?? [];
  const tracks: Track[] = items.map((t, i) => {
    const trackId = trackIdFromUri(t?.uri);
    return {
      ...emptyTrack(),
      title: cleanText(t?.title ?? t?.name),
      artist: artistFromTrackEntry(t, albumArtist),
      album: albumName,
      duration_ms: typeof t?.duration === "number" ? t.duration : null,
      track_number: typeof t?.trackNumber === "number" ? t.trackNumber : i + 1,
      artwork_url: art,
      source_url: trackId ? `https://open.spotify.com/track/${trackId}` : null,
    };
  });
  return {
    kind: "album",
    title: albumName,
    tracks,
    source_url: url,
    last_modified: null,
    provider: "spotify",
  };
}

function resolvePlaylist(url: string, next: any): ResolvedSource {
  const e = entity(next);
  const title: string = cleanText(e?.title ?? e?.name) || "Playlist";
  // Playlist trackList entries do NOT carry per-track album/cover. Use the
  // playlist's own coverArt as the cover for every track (mosaic art is
  // what the Spotify web app shows too).
  const fallbackArt = pickArt(e);
  const items: any[] = e?.trackList ?? [];
  const tracks: Track[] = items.map((t, i) => {
    const trackId = trackIdFromUri(t?.uri);
    return {
      ...emptyTrack(),
      title: cleanText(t?.title ?? t?.name),
      artist: artistFromTrackEntry(t, null),
      album: cleanText(t?.album?.name) || null,
      duration_ms: typeof t?.duration === "number" ? t.duration : null,
      track_number: i + 1,
      artwork_url: pickArt(t?.album) ?? fallbackArt,
      source_url: trackId ? `https://open.spotify.com/track/${trackId}` : null,
    };
  });
  return {
    kind: "playlist",
    title,
    tracks,
    source_url: url,
    last_modified: null,
    provider: "spotify",
  };
}

export async function resolveSpotify(url: string): Promise<ResolvedSource> {
  const { kind, id } = detect(url);
  const next = await fetchEmbed(kind, id);
  if (kind === "track") return resolveTrack(url, next);
  if (kind === "album") return resolveAlbum(url, next);
  return resolvePlaylist(url, next);
}

export function isSpotifyUrl(url: string): boolean {
  return /open\.spotify\.com/i.test(url);
}
