// Frontend config. Point WORKER_URL at your deployed Cloudflare Worker
// or leave empty to call the same origin (works when serving via
// the Node entrypoint on a Pi: `npm run serve-node`).
window.MDW_CONFIG = {
  // Empty string = same-origin. Otherwise full origin, e.g.:
  //   "https://musicdownweb.yourname.workers.dev"
  WORKER_URL: "",

  // Parallel tracks. 3 mirrors MusicDown's MAX_CONCURRENT_DOWNLOADS default.
  // Each track holds ~3-5 MB in memory until ZIP. Raise on a beefy machine.
  CONCURRENCY: 3,

  // Minimum confidence to accept a YouTube candidate as "ours".
  // Mirrors MusicDown/app/settings.py:youtube_search_threshold (0.75).
  MATCH_THRESHOLD: 0.75,
};
