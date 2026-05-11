// MusicDownWeb — orchestrator. Everything that used to live in the arq
// worker (resolve → match → download → tag) runs here in the user's tab.
//
// Render strategy mirrors MusicDown's: build the job shell ONCE, then mutate
// individual nodes per state transition. Don't rewrite track list HTML on
// every update — that retriggers the staggered entrance animation and turns
// 40+ events per album into a flicker storm.
//
// Job state shape (all in-memory, lost on refresh):
//   {
//     status: "queued"|"resolving"|"downloading"|"done"|"failed",
//     provider, kind, title, source_url, error,
//     tracks: [{
//       title, artist, album, duration_ms, artwork_url, source_url,
//       status: "pending"|"matching"|"downloading"|"tagging"|"done"|"skipped"|"failed",
//       youtube_video_id, match_score, error,
//       file_name, file_size,
//       _blob,            // Uint8Array of tagged audio, for ZIP/single download
//     }],
//   }

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const escapeHtml = (s) => (s ?? "").toString().replace(/[&<>"']/g, c => (
    { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]
  ));

  const CONFIG = window.MDW_CONFIG ?? { WORKER_URL: "", CONCURRENCY: 3, MATCH_THRESHOLD: 0.75 };

  // ---------- copy ----------
  const TRACK_STATUS_GLYPH = {
    pending: "·", matching: "…", downloading: "↓", tagging: "✎",
    done: "●", skipped: "—", failed: "✕",
  };
  const TRACK_STATUS_LABEL = {
    pending: "queued", matching: "searching YouTube", downloading: "downloading",
    tagging: "writing tags", done: "ready", skipped: "no match", failed: "failed",
  };
  const JOB_STATUS_LABEL = {
    queued: "queued", resolving: "resolving", downloading: "downloading",
    done: "ready", failed: "failed",
  };

  function friendlyError(raw) {
    if (!raw) return "Something went wrong.";
    const r = raw.toLowerCase();
    if (r.includes("requires authentication") || r.includes("personalized") || r.includes("daily mix") || r.includes("discover weekly"))
      return "This is a personalized Spotify Mix (Daily Mix, Discover Weekly, etc.) — those need a Spotify account to view. Only public shared playlists work here.";
    if (r.includes("no confident") || r.includes("no match"))
      return "Couldn't find this on YouTube.";
    if (r.includes("video unavailable"))
      return "YouTube took down this video.";
    if (r.includes("sign in to confirm") || r.includes("not a bot") || r.includes("confirm you"))
      return "YouTube is blocking this server's IP as a bot. (Common on cloud hosts like Render — needs yt-dlp cookies or self-hosting.)";
    if (r.includes("429") || r.includes("too many requests"))
      return "YouTube rate-limited this server. Try again in a few minutes.";
    if (r.includes("403") || r.includes("forbidden"))
      return "YouTube refused this request — usually IP-based bot detection on cloud hosts.";
    if (r.includes("googlevideo") || r.includes("cipher"))
      return "YouTube blocked the download. Try again in a minute.";
    if (r.includes("not a recognised") || r.includes("not a recognized"))
      return "That doesn't look like a Spotify or Apple Music link we can handle.";
    if (r.includes("404") || r.includes("not found"))
      return "Spotify or Apple Music returned 'not found' for this URL.";
    if (r.includes("only spotify or apple"))
      return "Only Spotify and Apple Music links are supported.";
    return raw.split("\n")[0].slice(0, 140);
  }

  const fmtBytes = (n) => {
    if (n == null) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };
  const fmtDuration = (ms) => {
    if (!ms) return "";
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
  };

  function setTitle(state) {
    if (!state) { document.title = "MusicDownWeb"; return; }
    const total = state.tracks.length;
    const done = state.tracks.filter(t => t.status === "done").length;
    if (state.status === "queued" || state.status === "resolving")
      document.title = "MusicDownWeb — Resolving…";
    else if (state.status === "failed")
      document.title = "MusicDownWeb — Failed";
    else if (state.status === "done" && total)
      document.title = `MusicDownWeb — ${done}/${total} ✓`;
    else if (total)
      document.title = `MusicDownWeb — ${done}/${total}`;
    else
      document.title = "MusicDownWeb";
  }

  // ---------- file naming ----------
  const SAFE_RE = /[<>:"/\\|?*\x00-\x1f]/g;
  function safeName(s, maxLen = 80) {
    let out = String(s ?? "").replace(SAFE_RE, "_").trim().replace(/[.\s]+$/, "");
    if (!out) out = "Untitled";
    return out.slice(0, maxLen);
  }
  function trackFileName(track, position) {
    const idx = String(position).padStart(2, "0");
    return `${idx} - ${safeName(track.artist)} - ${safeName(track.title)}.m4a`;
  }
  function zipFileName(title) {
    return `${safeName(title, 60) || "musicdownweb"}.zip`;
  }

  // ---------- worker URL ----------
  function workerUrl(path) {
    const base = (CONFIG.WORKER_URL || "").replace(/\/+$/, "");
    return base + path;
  }

  // ---------- render: build once, mutate after ----------
  let ui = null;
  let lastValues = {};
  let state = null;

  function showJobScaffold() {
    $("#empty").hidden = true;
    $("#what-works").hidden = true;
    $("#job").hidden = false;
  }

  function buildJobShell(jobId) {
    $("#job").innerHTML = `
      <div class="cover-area">
        <div class="cover skeleton"><img alt="" hidden></div>
        <div class="album-meta">
          <div class="kind-label">loading</div>
          <h1 class="album-title">Resolving…</h1>
          <div class="album-sub"></div>
          <div class="status-counter" role="status" aria-live="polite">
            <span class="status-pill queued">queued</span>
            <span class="counter"></span>
          </div>
          <div class="progress-bar" role="progressbar"
               aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"
               aria-label="Download progress">
            <div class="fill"></div>
          </div>
        </div>
      </div>
      <div class="actions" hidden>
        <button class="zip-btn" type="button" aria-label="Download all completed tracks as a zip">
          <span class="glyph" aria-hidden="true">▣</span>
          <span>Download ZIP</span>
        </button>
        <span class="summary"></span>
      </div>
      <ol class="tracklist" role="list"></ol>
    `;
    const root = $("#job");
    ui = {
      jobId,
      root,
      cover: $(".cover", root),
      coverImg: $(".cover img", root),
      kindLabel: $(".kind-label", root),
      albumTitle: $(".album-title", root),
      albumSub: $(".album-sub", root),
      statusPill: $(".status-pill", root),
      counter: $(".counter", root),
      progressBar: $(".progress-bar", root),
      progressFill: $(".progress-bar .fill", root),
      actions: $(".actions", root),
      zipBtn: $(".zip-btn", root),
      summary: $(".summary", root),
      tracklist: $(".tracklist", root),
      rows: new Map(),
    };
    lastValues = {};
    ui.zipBtn.addEventListener("click", onZipClick);
  }

  function setText(el, key, value) {
    if (lastValues[key] === value) return;
    lastValues[key] = value;
    el.textContent = value;
  }

  function renderJobError(error) {
    $("#empty").hidden = true;
    $("#what-works").hidden = true;
    $("#job").hidden = false;
    $("#job").innerHTML = `
      <div class="error-panel" role="alert">
        ${escapeHtml(friendlyError(error))}
      </div>
    `;
    ui = null;
    lastValues = {};
    setTitle({ status: "failed", tracks: [] });
  }

  function render() {
    if (!state) return;
    if (state.status === "failed" && (state.tracks?.length ?? 0) === 0) {
      renderJobError(state.error);
      return;
    }
    showJobScaffold();
    if (!ui) buildJobShell("local");

    const tracks = state.tracks;
    const total = tracks.length;
    const done = tracks.filter(t => t.status === "done").length;
    const skipped = tracks.filter(t => t.status === "skipped").length;
    const failed = tracks.filter(t => t.status === "failed").length;
    const finished = done + skipped + failed;
    const pct = total ? Math.round((finished / total) * 100) : 0;

    // Cover
    const heroArt = tracks.find(t => t.artwork_url)?.artwork_url;
    if (heroArt && lastValues.cover !== heroArt) {
      ui.coverImg.src = heroArt;
      ui.coverImg.alt = state.title || "Cover art";
      ui.coverImg.hidden = false;
      ui.cover.classList.remove("skeleton");
      lastValues.cover = heroArt;
    }

    // Header text
    const kindText = state.provider && state.kind
      ? `${state.provider} · ${state.kind}`
      : "loading";
    setText(ui.kindLabel, "kindLabel", kindText);

    const isResolving =
      !state.title &&
      (state.status === "queued" || state.status === "resolving" || total === 0);
    const titleText = isResolving ? "Resolving…" : (state.title || "Untitled");
    setText(ui.albumTitle, "title", titleText);

    setText(ui.albumSub, "sub", total ? `${total} track${total === 1 ? "" : "s"}` : "");

    // Status pill
    const pillKey = `pill:${state.status}`;
    if (lastValues.pillKey !== pillKey) {
      ui.statusPill.className = `status-pill ${state.status}`;
      ui.statusPill.textContent = JOB_STATUS_LABEL[state.status] || state.status;
      lastValues.pillKey = pillKey;
    }

    setText(ui.counter, "counter", total ? `${done}/${total} ready` : "");

    if (lastValues.pct !== pct) {
      ui.progressBar.setAttribute("aria-valuenow", String(pct));
      ui.progressFill.style.width = `${pct}%`;
      lastValues.pct = pct;
    }

    // ZIP actions
    const showZip = done >= 1;
    if (showZip) {
      if (ui.actions.hidden) ui.actions.hidden = false;
      ui.zipBtn.disabled = state.status !== "done";
      const totalBytes = tracks
        .filter(t => t.status === "done")
        .reduce((s, t) => s + (t.file_size || 0), 0);
      const summaryText =
        `${done} of ${total} ready · ${fmtBytes(totalBytes)}` +
        (skipped + failed ? ` · ${skipped + failed} not available` : "");
      setText(ui.summary, "summary", summaryText);
    }

    // Track rows
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      let row = ui.rows.get(i);
      if (!row) {
        row = createTrackRow(t, i);
        ui.rows.set(i, row);
        ui.tracklist.appendChild(row);
      } else {
        updateTrackRow(row, t);
      }
    }

    setTitle(state);
  }

  function createTrackRow(t, idx) {
    const li = document.createElement("li");
    li.dataset.idx = String(idx);
    li.style.setProperty("--idx", String(Math.min(idx, 18)));
    li.innerHTML = `
      <span class="tnum" aria-hidden="true">${(idx + 1).toString().padStart(2, "0")}</span>
      <span class="ttitle">${escapeHtml(t.title)} <span class="tartist">— ${escapeHtml(t.artist)}</span></span>
      <span class="tdur" aria-hidden="true">${fmtDuration(t.duration_ms)}</span>
      <span class="tstatus pending" aria-label="queued">·</span>
      <span class="dl-slot" aria-hidden="true"></span>
      <div class="tnote" hidden></div>
      <div class="row-prog"><div class="fill"></div></div>
    `;
    li._last = {};
    updateTrackRow(li, t);
    return li;
  }

  function updateTrackRow(li, t) {
    const last = li._last;
    const status = t.status;
    const tstatus = li.querySelector(".tstatus");

    if (last.status !== status) {
      tstatus.className = `tstatus ${status}`;
      tstatus.textContent = TRACK_STATUS_GLYPH[status] || "·";
      tstatus.setAttribute("aria-label", TRACK_STATUS_LABEL[status] || status);
      const active = status === "matching" || status === "downloading" || status === "tagging";
      li.classList.toggle("is-active", active);
      last.status = status;
    }

    // Per-row progress (downloading)
    if (status === "downloading" && t._progress != null) {
      const fill = li.querySelector(".row-prog .fill");
      const pct = Math.min(1, Math.max(0, t._progress)) * 100;
      if (last.rowPct !== pct) {
        fill.style.width = pct + "%";
        last.rowPct = pct;
      }
    } else if (last.rowPct != null && (status === "done" || status === "tagging")) {
      const fill = li.querySelector(".row-prog .fill");
      fill.style.width = "100%";
      last.rowPct = 100;
    }

    // Single-track download button (replaces slot once)
    if (status === "done" && t._blob && !last.dlAdded) {
      const slot = li.querySelector(".dl-slot, .dl-link");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dl-link";
      btn.title = "Download single track";
      btn.setAttribute("aria-label", `Download ${t.title} — ${t.artist}`);
      btn.textContent = "↧";
      btn.addEventListener("click", () => saveBlob(t._blob, t.file_name, "audio/mp4"));
      slot.replaceWith(btn);
      last.dlAdded = true;
    }

    // Note row
    const note = li.querySelector(".tnote");
    let noteHTML = "";
    let noteClass = "tnote";
    if (status === "skipped" || status === "failed") {
      noteClass = `tnote ${status}`;
      noteHTML = escapeHtml(friendlyError(t.error) || TRACK_STATUS_LABEL[status]);
    } else if (status === "done" && t.match_score != null && t.match_score < 0.95) {
      const pct = Math.round(t.match_score * 100);
      noteHTML = `<span class="score">match confidence: ${pct}%</span>`
        + (t.file_size ? `<span class="tsize">· ${fmtBytes(t.file_size)}</span>` : "");
    } else if (status === "done" && t.file_size) {
      noteHTML = `<span class="tsize">${fmtBytes(t.file_size)}</span>`;
    }
    if (noteHTML) {
      if (last.noteHTML !== noteHTML || last.noteClass !== noteClass) {
        note.className = noteClass;
        note.innerHTML = noteHTML;
        note.hidden = false;
        last.noteHTML = noteHTML;
        last.noteClass = noteClass;
      }
    } else if (!note.hidden) {
      note.hidden = true;
    }
  }

  // ---------- save helpers ----------
  function saveBlob(bytes, filename, mime) {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function onZipClick() {
    if (!state || !state.tracks) return;
    const done = state.tracks.filter(t => t.status === "done" && t._blob);
    if (done.length === 0) return;
    if (typeof JSZip === "undefined") {
      alert("ZIP library failed to load — try saving tracks individually.");
      return;
    }
    const zip = new JSZip();
    for (const t of done) {
      zip.file(t.file_name, t._blob, { binary: true });
    }
    // List skipped/failed for honesty
    const missed = state.tracks
      .filter(t => t.status === "skipped" || t.status === "failed")
      .map(t => `${t.title} — ${t.artist}    [${t.status}${t.error ? ": " + t.error : ""}]`);
    if (missed.length) zip.file("_unmatched.txt", missed.join("\n") + "\n");

    ui.zipBtn.disabled = true;
    try {
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      saveBlob(blob, zipFileName(state.title || "musicdownweb"), "application/zip");
    } finally {
      ui.zipBtn.disabled = false;
    }
  }

  // ---------- pipeline ----------

  async function fetchJson(path, body) {
    const r = await fetch(workerUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      let msg = txt;
      try { msg = JSON.parse(txt).error ?? txt; } catch {}
      throw new Error(msg || `HTTP ${r.status}`);
    }
    return r.json();
  }

  async function fetchAudioStreamed(videoId, onProgress) {
    const r = await fetch(workerUrl(`/audio/${encodeURIComponent(videoId)}`));
    if (!r.ok) {
      // Surface the worker's error body so the user sees the real cause
      // (e.g. "yt-dlp exited 1: Sign in to confirm you're not a bot").
      const txt = await r.text().catch(() => "");
      let msg = txt;
      try { msg = JSON.parse(txt).error ?? txt; } catch {}
      throw new Error(`audio fetch ${r.status}: ${(msg || "no body").slice(0, 300)}`);
    }
    const totalHeader = r.headers.get("Content-Length");
    const total = totalHeader ? parseInt(totalHeader, 10) : null;
    if (!r.body) {
      // Fallback if streaming is unavailable.
      const buf = new Uint8Array(await r.arrayBuffer());
      if (onProgress) onProgress(1, buf.byteLength);
      return buf;
    }
    const reader = r.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (onProgress) onProgress(total ? received / total : Math.min(0.95, received / (4 * 1024 * 1024)), received);
    }
    // Concat
    const out = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  }

  async function fetchCoverArt(url) {
    if (!url) return null;
    try {
      const r = await fetch(url, { mode: "cors", credentials: "omit" });
      if (!r.ok) return null;
      const mime = r.headers.get("Content-Type") || "image/jpeg";
      const bytes = new Uint8Array(await r.arrayBuffer());
      return { bytes, mime };
    } catch {
      // CORS or network failure — proceed without cover. Tag writer is fine with no cover.
      return null;
    }
  }

  function bumpRender() {
    // Coalesce renders to one per microtask to avoid thrash when many
    // sub-status changes happen in a tight loop.
    if (bumpRender._scheduled) return;
    bumpRender._scheduled = true;
    queueMicrotask(() => {
      bumpRender._scheduled = false;
      render();
    });
  }

  async function processTrack(track, position) {
    track.status = "matching";
    bumpRender();

    let candidates;
    try {
      const r = await fetchJson("/match", {
        title: track.title,
        artist: track.artist,
        duration_ms: track.duration_ms,
      });
      candidates = r.candidates ?? [];
    } catch (e) {
      track.status = "failed";
      track.error = `match: ${e.message}`;
      bumpRender();
      return;
    }

    const best = window.MDW_Match.pickBest(track, candidates, CONFIG.MATCH_THRESHOLD);
    if (!best) {
      track.status = "skipped";
      track.error = "no confident YouTube match";
      bumpRender();
      return;
    }
    track.youtube_video_id = best.video_id;
    track.match_score = best.score;
    track.status = "downloading";
    track._progress = 0;
    bumpRender();

    let audioBytes;
    try {
      audioBytes = await fetchAudioStreamed(best.video_id, (frac, received) => {
        track._progress = frac;
        track.file_size = received;
        bumpRender();
      });
    } catch (e) {
      track.status = "failed";
      track.error = `download: ${e.message}`;
      bumpRender();
      return;
    }

    track.status = "tagging";
    bumpRender();

    let cover = null;
    if (track.artwork_url) cover = await fetchCoverArt(track.artwork_url);

    let tagged;
    try {
      const tags = {
        title: track.title,
        artist: track.artist,
        album: track.album || undefined,
        albumArtist: track.artist || undefined,
        trackNumber: position,
        totalTracks: state.tracks.length,
        discNumber: track.disc_number || undefined,
        cover: cover ?? undefined,
      };
      tagged = window.MDW_Tag.writeTags(audioBytes, tags);
    } catch (e) {
      // Tagging failure isn't fatal — surface the untagged file so the user
      // can still keep the audio.
      console.warn("tag write failed", e);
      tagged = audioBytes;
    }

    track._blob = tagged;
    track.file_name = trackFileName(track, position);
    track.file_size = tagged.byteLength;
    track.status = "done";
    bumpRender();
  }

  // ---------- semaphore ----------
  function semaphore(n) {
    let active = 0;
    const queue = [];
    function next() {
      while (active < n && queue.length) {
        const { fn, resolve, reject } = queue.shift();
        active++;
        Promise.resolve()
          .then(fn)
          .then(v => { active--; resolve(v); next(); })
          .catch(e => { active--; reject(e); next(); });
      }
    }
    return (fn) => new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  }

  // ---------- main entry ----------
  async function submitUrl(url) {
    state = {
      status: "resolving", source_url: url, provider: null, kind: null,
      title: null, error: null, tracks: [],
    };
    ui = null;
    lastValues = {};
    showJobScaffold();
    buildJobShell("local");
    render();

    let resolved;
    try {
      resolved = await fetchJson("/resolve", { url });
    } catch (e) {
      state.status = "failed";
      state.error = e.message;
      render();
      return;
    }

    state.provider = resolved.provider;
    state.kind = resolved.kind;
    state.title = resolved.title;
    state.tracks = (resolved.tracks ?? []).map(t => ({
      title: t.title, artist: t.artist, album: t.album,
      duration_ms: t.duration_ms, source_url: t.source_url,
      artwork_url: t.artwork_url, disc_number: t.disc_number,
      status: "pending",
      youtube_video_id: null, match_score: null,
      file_name: null, file_size: null,
      error: null, _blob: null, _progress: null,
    }));
    state.status = "downloading";
    render();

    const limit = semaphore(CONFIG.CONCURRENCY ?? 3);
    await Promise.all(state.tracks.map((t, i) => limit(() => processTrack(t, i + 1))));

    state.status = "done";
    render();
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("#form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const url = $("#url").value.trim();
      if (!url) return;
      submitUrl(url);
      $("#url").value = "";
      $("#url").blur();
    });
    const prefill = new URLSearchParams(location.search).get("url");
    if (prefill) submitUrl(prefill);
  });
})();
