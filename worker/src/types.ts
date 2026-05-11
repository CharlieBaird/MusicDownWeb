// Shared types between the Worker (resolver output) and the frontend.
// Mirror MusicDown/app/resolvers/base.py so the same mental model carries over.

export type SourceKind = "track" | "album" | "playlist";
export type Provider = "spotify" | "apple";

export interface Track {
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  track_number: number | null;
  disc_number: number | null;
  release_date: string | null;
  artwork_url: string | null;
  source_url: string | null;
}

export interface ResolvedSource {
  kind: SourceKind;
  title: string;
  tracks: Track[];
  source_url: string;
  last_modified: string | null;
  provider: Provider;
}

export interface YouTubeCandidate {
  video_id: string;
  title: string;
  artists: string[];
  album: string | null;
  duration_seconds: number | null;
}

export interface AudioStreamInfo {
  url: string;
  mime: string;
  bitrate: number | null;
  approx_size_bytes: number | null;
}

export function emptyTrack(): Track {
  return {
    title: "",
    artist: "Unknown",
    album: null,
    duration_ms: null,
    track_number: null,
    disc_number: null,
    release_date: null,
    artwork_url: null,
    source_url: null,
  };
}
