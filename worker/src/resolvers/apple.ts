// Apple Music resolver — no developer token, no amp-api, no JWT.
// Port of MusicDown/app/resolvers/apple.py.
//
// Strategy: parse the <script id="serialized-server-data"> JSON blob that
// Apple ships with every page. It carries the full track list for albums
// and playlists. The amp-api JWT scrape no longer works — Apple moved to
// dynamic runtime token issuance — so don't try to reintroduce it.

import { emptyTrack, type ResolvedSource, type Track } from "../types.js";

const URL_RE = new RegExp(
  String.raw`music\.apple\.com/(?<storefront>\w{2})/` +
  String.raw`(?<kind>song|album|playlist)/[^/]+/(?<id>(?:pl\.)?[\w.\-]+)` +
  String.raw`(?:\?[^#]*\bi=(?<track_id>\d+))?`,
  "i",
);

const SSR_RE = /<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function expandArtwork(url: string | null | undefined, size = 1000, fmt = "jpg"): string | null {
  if (!url) return null;
  return url.replace("{w}", String(size)).replace("{h}", String(size)).replace("{f}", fmt);
}

async function fetchSsr(url: string): Promise<unknown> {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html,*/*" },
    redirect: "follow",
  });
  if (r.status === 404) throw new ResolverError(`Apple Music URL not found (404): ${url}`);
  if (!r.ok) throw new ResolverError(`Apple Music: ${r.status} fetching ${url}`);
  const text = await r.text();
  const m = SSR_RE.exec(text);
  if (!m) throw new ResolverError(`Apple Music: no serialized-server-data block in ${url} — page shape changed`);
  try {
    return JSON.parse(m[1]!.trim());
  } catch (e) {
    throw new ResolverError(`Apple Music: SSR blob JSON parse failed: ${(e as Error).message}`);
  }
}

function pageSections(blob: any): any[] {
  const sections = blob?.data?.[0]?.data?.sections;
  if (!Array.isArray(sections)) {
    throw new ResolverError("Apple Music: unexpected SSR blob shape (no data[0].data.sections)");
  }
  return sections;
}

function findSection(sections: any[], itemKind: string, idPrefix?: string): any | null {
  for (const sec of sections) {
    if (sec?.itemKind !== itemKind) continue;
    if (idPrefix && !String(sec.id ?? "").startsWith(idPrefix)) continue;
    return sec;
  }
  return null;
}

function trackFromLockup(
  item: any,
  position: number,
  fallbackAlbum: string | null,
  fallbackArtwork: string | null,
): Track {
  const cd = item?.contentDescriptor ?? {};
  const trackId = cd?.identifiers?.storeAdamID ?? null;
  const sourceUrl: string | null = cd?.url ?? null;
  const itemArt: string | null = item?.artwork?.dictionary?.url ?? null;
  const artwork = expandArtwork(itemArt) ?? fallbackArtwork;

  // For playlists, each track may live on a different album — tertiaryLinks[0].title
  // carries that album name. For albums the lockup omits it; we use the header.
  let albumName: string | null = fallbackAlbum;
  const tertiary = item?.tertiaryLinks;
  if (Array.isArray(tertiary) && tertiary[0]?.title) albumName = tertiary[0].title;

  return {
    ...emptyTrack(),
    title: item?.title ?? "",
    artist: item?.artistName ?? "Unknown",
    album: albumName,
    duration_ms: typeof item?.duration === "number" ? item.duration : null,
    track_number: typeof item?.trackNumber === "number" ? item.trackNumber : position,
    disc_number: typeof item?.discNumber === "number" ? item.discNumber : null,
    artwork_url: artwork,
    source_url: sourceUrl,
  };
}

function resolveAlbumOrPlaylist(url: string, blob: any, kind: "album" | "playlist"): ResolvedSource {
  const sections = pageSections(blob);
  const header = findSection(sections, "containerDetailHeaderLockup");
  const tracksSec = findSection(sections, "trackLockup");
  if (!header || !tracksSec) {
    throw new ResolverError(
      `Apple Music: required sections not found (header=${!!header}, tracks=${!!tracksSec})`,
    );
  }
  const headerItem = (header.items ?? [{}])[0] ?? {};
  const title: string = headerItem.title ?? (kind === "album" ? "Album" : "Playlist");
  const headerArt: string | null = headerItem?.artwork?.dictionary?.url ?? null;
  const fallbackArtwork = expandArtwork(headerArt);
  const fallbackAlbum = kind === "album" ? title : null;

  const items: any[] = tracksSec.items ?? [];
  const tracks = items.map((it, i) => trackFromLockup(it, i + 1, fallbackAlbum, fallbackArtwork));
  return {
    kind,
    title,
    tracks,
    source_url: url,
    last_modified: null,
    provider: "apple",
  };
}

// `/song/<slug>/<id>` pages render with a different SSR shape — `songDetailHeader`
// instead of `containerDetailHeaderLockup` + `trackLockup`. The header
// surfaces the canonical share URL (`/album/<slug>/<albumId>?i=<trackId>`),
// so we extract that and recurse into the album path which already works.
function canonicalUrlFromSongPage(blob: any): string | null {
  const sections = pageSections(blob);
  const header = findSection(sections, "songDetailHeader");
  if (!header) return null;
  const item = (header.items ?? [{}])[0] ?? {};
  const fromContentDescriptor: string | null =
    item?.playAction?.items?.[0]?.contentDescriptor?.url ?? null;
  if (fromContentDescriptor) return fromContentDescriptor;
  const fromActionMetrics: string | null =
    item?.playAction?.actionMetrics?.data?.[0]?.fields?.actionUrl ?? null;
  return fromActionMetrics;
}

function resolveSong(url: string, blob: any, trackId: string): ResolvedSource {
  const sections = pageSections(blob);
  const tracksSec = findSection(sections, "trackLockup");
  const header = findSection(sections, "containerDetailHeaderLockup");
  if (!tracksSec) throw new ResolverError("Apple Music: song page has no trackLockup section");

  const items: any[] = tracksSec.items ?? [];
  let match: { pos: number; item: any } | null = null;
  for (let i = 0; i < items.length; i++) {
    const cd = items[i]?.contentDescriptor ?? {};
    if (cd?.identifiers?.storeAdamID === trackId) {
      match = { pos: i + 1, item: items[i] };
      break;
    }
  }
  if (!match) throw new ResolverError(`Apple Music: track id ${trackId} not found in album page tracks`);

  const headerItem = (header?.items ?? [{}])[0] ?? {};
  const fallbackAlbum: string | null = headerItem.title ?? null;
  const fallbackArtwork = expandArtwork(headerItem?.artwork?.dictionary?.url ?? null);
  const track = trackFromLockup(match.item, match.pos, fallbackAlbum, fallbackArtwork);
  return {
    kind: "track",
    title: track.title || "Track",
    tracks: [track],
    source_url: url,
    last_modified: null,
    provider: "apple",
  };
}

export class ResolverError extends Error {}

export async function resolveApple(url: string): Promise<ResolvedSource> {
  const m = URL_RE.exec(url);
  if (!m || !m.groups) throw new ResolverError(`Not a recognised Apple Music URL: ${url}`);

  const kind = m.groups.kind!.toLowerCase();
  const trackIdParam = m.groups.track_id;

  // Apple's /song/<slug>/<id> URL form 404s from the web. Treat `?i=` as the
  // canonical song lookup.
  if (trackIdParam) {
    const blob = await fetchSsr(url);
    return resolveSong(url, blob, trackIdParam);
  }
  if (kind === "song") {
    // `/song/` pages render but with a different SSR shape that has the
    // header only. Pull the canonical `/album/.../?i=<trackId>` URL out of
    // the header and re-resolve via the album path (full metadata +
    // duration come from the album's `trackLockup` rows).
    const songBlob = await fetchSsr(url);
    const canonical = canonicalUrlFromSongPage(songBlob);
    if (!canonical) {
      throw new ResolverError(
        `Apple Music /song/ ${url}: songDetailHeader present but no canonical album URL found`,
      );
    }
    const canonicalMatch = URL_RE.exec(canonical);
    const canonicalTrackId = canonicalMatch?.groups?.track_id ?? null;
    if (!canonicalTrackId) {
      throw new ResolverError(
        `Apple Music /song/ ${url}: extracted canonical URL ${canonical} missing ?i=<trackId>`,
      );
    }
    const albumBlob = await fetchSsr(canonical);
    return resolveSong(canonical, albumBlob, canonicalTrackId);
  }
  const blob = await fetchSsr(url);
  return resolveAlbumOrPlaylist(url, blob, kind as "album" | "playlist");
}

export function isAppleUrl(url: string): boolean {
  return /music\.apple\.com/i.test(url);
}
