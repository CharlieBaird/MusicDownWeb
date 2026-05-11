// Port of MusicDown/app/matcher.py — score (title, artist, duration) against
// YouTube Music candidates, reject duration outliers, penalise noise words.
// Pure JS, no external fuzzy-matching lib (rapidfuzz has no peer-quality
// browser port; the token_set_ratio replacement below is good enough at
// this scale).

(function () {
  const NOISE_WORDS = [
    "karaoke", "instrumental", "tribute", "cover", "live", "acoustic",
    "sped up", "nightcore", "8d audio", "slowed", "extended", "rework",
    "remix", "edit", "mix", "version",
  ];
  const DURATION_HARD_REJECT_PCT = 0.15;

  // --- string similarity ---

  function tokenSet(s) {
    return new Set(
      String(s ?? "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(Boolean),
    );
  }

  // rapidfuzz `token_set_ratio` is built on the Levenshtein ratio of three
  // normalised forms (intersection, intersect+diff1, intersect+diff2).
  // We approximate with Jaccard on tokens + Levenshtein on the residue.
  // Empirically close enough on song titles, which are short.
  function tokenSetRatio(a, b) {
    const A = tokenSet(a), B = tokenSet(b);
    if (A.size === 0 && B.size === 0) return 1;
    if (A.size === 0 || B.size === 0) return 0;
    const inter = new Set([...A].filter(x => B.has(x)));
    const diffA = [...A].filter(x => !B.has(x)).sort().join(" ");
    const diffB = [...B].filter(x => !A.has(x)).sort().join(" ");
    const interStr = [...inter].sort().join(" ");
    const t1 = interStr;
    const t2 = (interStr + " " + diffA).trim();
    const t3 = (interStr + " " + diffB).trim();
    return Math.max(ratio(t1, t2), ratio(t1, t3), ratio(t2, t3));
  }

  function ratio(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    const dist = levenshtein(a, b);
    return 1 - dist / Math.max(a.length, b.length);
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (a.length > b.length) [a, b] = [b, a];
    const m = a.length, n = b.length;
    if (m === 0) return n;
    let prev = new Array(m + 1);
    let curr = new Array(m + 1);
    for (let i = 0; i <= m; i++) prev[i] = i;
    for (let j = 1; j <= n; j++) {
      curr[0] = j;
      for (let i = 1; i <= m; i++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        curr[i] = Math.min(
          curr[i - 1] + 1,       // insert
          prev[i] + 1,           // delete
          prev[i - 1] + cost,    // substitute
        );
      }
      [prev, curr] = [curr, prev];
    }
    return prev[m];
  }

  // --- scoring ---

  function score(track, cand) {
    const srcTitle  = (track.title  || "").toLowerCase();
    const srcArtist = (track.artist || "").toLowerCase();
    const srcAlbum  = (track.album  || "").toLowerCase();
    const srcDur    = track.duration_ms ? track.duration_ms / 1000 : null;

    const candTitle  = (cand.title || "").toLowerCase();
    const candArtist = (cand.artists || []).join(", ").toLowerCase();
    const candAlbum  = (cand.album || "").toLowerCase();
    const candDur    = cand.duration_seconds ?? null;

    // Hard duration reject.
    if (srcDur && candDur) {
      if (Math.abs(srcDur - candDur) / srcDur > DURATION_HARD_REJECT_PCT) return 0;
    }

    const titleSim  = tokenSetRatio(srcTitle, candTitle);
    const artistSim = tokenSetRatio(srcArtist, candArtist);

    let durSim;
    if (srcDur && candDur) {
      const diffPct = Math.abs(srcDur - candDur) / srcDur;
      durSim = Math.max(0, 1 - diffPct * 5);
    } else {
      durSim = 0.7;
    }

    let albumBonus = 0;
    if (srcAlbum && candAlbum && ratio(srcAlbum, candAlbum) > 0.8) albumBonus = 0.10;

    let bad = 0;
    for (const w of NOISE_WORDS) {
      if (candTitle.includes(w) && !srcTitle.includes(w)) bad++;
    }
    const noisePenalty = bad * 0.18;

    const base = titleSim * 0.45 + artistSim * 0.35 + durSim * 0.20;
    return Math.max(0, Math.min(1, base + albumBonus - noisePenalty));
  }

  function pickBest(track, candidates, threshold) {
    if (!candidates || candidates.length === 0) return null;
    const scored = candidates
      .filter(c => c.video_id)
      .map(c => ({ cand: c, score: score(track, c) }));
    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 0) return null;
    const best = scored[0];
    if (best.score < threshold) return null;
    return { ...best.cand, score: best.score };
  }

  window.MDW_Match = { pickBest, score };
})();
