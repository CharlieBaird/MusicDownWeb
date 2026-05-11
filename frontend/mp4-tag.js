// MP4 atom tagger — writes iTunes-style metadata into an existing m4a file
// in pure browser JS. Replaces (or creates) /moov/udta/meta/ilst with the
// supplied tags and adjusts /moov/trak[]/mdia/minf/stbl/stco|co64 chunk
// offsets when the moov size delta shifts mdat.
//
// Why not ffmpeg.wasm: 30+ MB blob to load before the first byte writes,
// and we don't need to re-mux — YouTube already hands us a valid m4a
// container, we just need to slot tags in.
//
// Reference: ISO/IEC 14496-12 + Apple's iTunes metadata format. The
// canonical atom path is /moov/udta/meta/ilst. `meta` is special — it
// carries 4 extra bytes (version+flags) before its children. `ilst`
// children are tag atoms like `©nam` whose payload is a single `data`
// sub-atom containing a type flag and the value.

(function () {
  const TEXT_FLAG = 0x00000001;
  const JPEG_FLAG = 0x0000000D;
  const PNG_FLAG  = 0x0000000E;
  const INT_FLAG  = 0x00000000;
  const enc = new TextEncoder();

  // ---------- low-level write helpers ----------

  function u32(view, off, v) { view.setUint32(off, v >>> 0, false); } // big-endian
  function u16(view, off, v) { view.setUint16(off, v & 0xFFFF, false); }
  function fourcc(view, off, s) {
    for (let i = 0; i < 4; i++) view.setUint8(off + i, s.charCodeAt(i));
  }
  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.byteLength;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.byteLength; }
    return out;
  }

  function atomBytes(type, payload) {
    const buf = new Uint8Array(8 + payload.byteLength);
    const dv = new DataView(buf.buffer);
    u32(dv, 0, 8 + payload.byteLength);
    fourcc(dv, 4, type);
    buf.set(payload, 8);
    return buf;
  }

  function dataAtom(flag, value) {
    // data atom: [size(4)][type "data"(4)][flag(4)][reserved(4)][value]
    const buf = new Uint8Array(16 + value.byteLength);
    const dv = new DataView(buf.buffer);
    u32(dv, 0, 16 + value.byteLength);
    fourcc(dv, 4, "data");
    u32(dv, 8, flag);
    u32(dv, 12, 0);
    buf.set(value, 16);
    return buf;
  }

  function textTag(type, text) {
    return atomBytes(type, dataAtom(TEXT_FLAG, enc.encode(text)));
  }

  function numberPairTag(type, n, total) {
    // For trkn / disk: 8-byte payload [reserved(2)=0][n(2)][total(2)][reserved(2)=0]
    const payload = new Uint8Array(8);
    const dv = new DataView(payload.buffer);
    u16(dv, 0, 0);
    u16(dv, 2, n & 0xFFFF);
    u16(dv, 4, (total ?? 0) & 0xFFFF);
    u16(dv, 6, 0);
    return atomBytes(type, dataAtom(INT_FLAG, payload));
  }

  function coverTag(bytes, mime) {
    const flag = /png/i.test(mime) ? PNG_FLAG : JPEG_FLAG;
    return atomBytes("covr", dataAtom(flag, new Uint8Array(bytes)));
  }

  function buildIlst(tags) {
    const parts = [];
    if (tags.title)        parts.push(textTag("©nam", tags.title));
    if (tags.artist)       parts.push(textTag("©ART", tags.artist));
    if (tags.album)        parts.push(textTag("©alb", tags.album));
    if (tags.albumArtist)  parts.push(textTag("aART",       tags.albumArtist));
    if (tags.year)         parts.push(textTag("©day", String(tags.year)));
    if (tags.trackNumber)  parts.push(numberPairTag("trkn", tags.trackNumber, tags.totalTracks));
    if (tags.discNumber)   parts.push(numberPairTag("disk", tags.discNumber, tags.totalDiscs));
    if (tags.cover && tags.cover.bytes)
      parts.push(coverTag(tags.cover.bytes, tags.cover.mime ?? "image/jpeg"));
    return atomBytes("ilst", concat(parts));
  }

  function buildHdlr() {
    // hdlr inside meta: handler_type = "mdir", component_name = "appl"
    const payload = new Uint8Array(4 + 4 + 4 + 4 * 3 + 5);
    const dv = new DataView(payload.buffer);
    // version+flags = 0
    u32(dv, 0, 0);
    // predefined = 0
    u32(dv, 4, 0);
    // handler_type = 'mdir'
    fourcc(dv, 8, "mdir");
    // reserved (3 * 4 bytes) = 0
    // name = 'appl' + null
    payload.set(enc.encode("appl"), 4 + 4 + 4 + 12);
    return atomBytes("hdlr", payload);
  }

  function buildMeta(ilst) {
    // meta payload: [version(1)+flags(3) = 0] [hdlr] [ilst]
    const hdr = new Uint8Array(4); // version+flags = 0
    const inner = concat([hdr, buildHdlr(), ilst]);
    return atomBytes("meta", inner);
  }

  function buildUdta(meta) {
    return atomBytes("udta", meta);
  }

  // ---------- parsing ----------

  function readU32(buf, off) {
    return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
  }
  function readType(buf, off) {
    return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
  }

  // Returns list of {type, start, end, headerSize, payloadStart, hasLarge}
  // for top-level atoms in [start, end).
  function listAtoms(buf, start, end) {
    const list = [];
    let off = start;
    while (off + 8 <= end) {
      let size = readU32(buf, off);
      const type = readType(buf, off + 4);
      let headerSize = 8;
      if (size === 1) {
        // 64-bit extended size
        const hi = readU32(buf, off + 8);
        const lo = readU32(buf, off + 12);
        size = hi * 0x100000000 + lo;
        headerSize = 16;
      } else if (size === 0) {
        size = end - off; // extends to end of parent
      }
      if (size < headerSize || off + size > end) break;
      list.push({
        type,
        start: off,
        end: off + size,
        headerSize,
        payloadStart: off + headerSize,
      });
      off += size;
    }
    return list;
  }

  // Find a chain of nested atoms by type. Returns the deepest matched atom.
  // E.g. findPath(buf, root, ["moov", "udta", "meta", "ilst"]) returns the
  // ilst atom record or null.
  function findChild(buf, parent, type, payloadOffsetAdjust = 0) {
    const children = listAtoms(buf, parent.payloadStart + payloadOffsetAdjust, parent.end);
    return children.find(c => c.type === type) ?? null;
  }

  // ---------- chunk-offset patching ----------

  // Walk moov for stco/co64 atoms and adjust each offset by `delta`.
  // Returns a new Uint8Array containing the patched moov.
  function patchOffsets(moovBuf, delta) {
    if (delta === 0) return moovBuf;
    // moovBuf starts at the moov atom header (size+type+children)
    const out = new Uint8Array(moovBuf); // clone, mutable
    const dv = new DataView(out.buffer);
    const moov = { type: "moov", start: 0, end: out.length, headerSize: 8, payloadStart: 8 };
    visitAndPatch(out, dv, moov);
    return out;

    function visitAndPatch(buf, dv, parent) {
      const containerTypes = new Set([
        "moov", "trak", "mdia", "minf", "stbl", "edts", "mvex", "udta",
      ]);
      const kids = listAtoms(buf, parent.payloadStart, parent.end);
      for (const k of kids) {
        if (k.type === "stco") {
          // [version+flags(4)][entry_count(4)][offset * count(4 each)]
          const entryCount = readU32(buf, k.payloadStart + 4);
          let off = k.payloadStart + 8;
          for (let i = 0; i < entryCount; i++) {
            const v = readU32(buf, off);
            const v2 = (v + delta) >>> 0;
            dv.setUint32(off, v2, false);
            off += 4;
          }
        } else if (k.type === "co64") {
          const entryCount = readU32(buf, k.payloadStart + 4);
          let off = k.payloadStart + 8;
          for (let i = 0; i < entryCount; i++) {
            const hi = readU32(buf, off);
            const lo = readU32(buf, off + 4);
            const v = hi * 0x100000000 + lo;
            const v2 = v + delta;
            dv.setUint32(off, Math.floor(v2 / 0x100000000), false);
            dv.setUint32(off + 4, v2 >>> 0, false);
            off += 8;
          }
        } else if (containerTypes.has(k.type)) {
          visitAndPatch(buf, dv, k);
        }
      }
    }
  }

  // ---------- main writer ----------

  // Tags shape:
  //   { title, artist, album, albumArtist, year, trackNumber, totalTracks,
  //     discNumber, totalDiscs, cover: { bytes, mime } }
  function writeTags(originalBytes, tags) {
    const buf = originalBytes instanceof Uint8Array
      ? originalBytes
      : new Uint8Array(originalBytes);

    const top = listAtoms(buf, 0, buf.length);
    const moov = top.find(a => a.type === "moov");
    if (!moov) throw new Error("MP4 has no moov atom — cannot tag");
    const mdatStart = (() => {
      const m = top.find(a => a.type === "mdat");
      return m ? m.start : null;
    })();

    // Build the new udta we want to inject.
    const newUdta = buildUdta(buildMeta(buildIlst(tags)));

    // Locate existing udta (if any) within moov.
    const existingUdta = findChild(buf, moov, "udta");

    let newMoovBody;
    if (existingUdta) {
      // Replace existing udta in place.
      const before = buf.subarray(moov.payloadStart, existingUdta.start);
      const after  = buf.subarray(existingUdta.end, moov.end);
      newMoovBody = concat([before, newUdta, after]);
    } else {
      // Append a fresh udta to moov.
      const body = buf.subarray(moov.payloadStart, moov.end);
      newMoovBody = concat([body, newUdta]);
    }

    // Re-wrap moov with corrected size header.
    const newMoovSize = 8 + newMoovBody.byteLength;
    const newMoov = new Uint8Array(newMoovSize);
    const ndv = new DataView(newMoov.buffer);
    u32(ndv, 0, newMoovSize);
    fourcc(ndv, 4, "moov");
    newMoov.set(newMoovBody, 8);

    const delta = newMoovSize - (moov.end - moov.start);

    // If mdat appears after moov in the file, its absolute offsets just
    // shifted. Patch stco/co64 inside moov by the same delta.
    let patchedMoov = newMoov;
    if (mdatStart != null && mdatStart > moov.start) {
      patchedMoov = patchOffsets(newMoov, delta);
    }

    // Assemble: everything before moov, patched moov, everything after.
    const pre  = buf.subarray(0, moov.start);
    const post = buf.subarray(moov.end);
    return concat([pre, patchedMoov, post]);
  }

  window.MDW_Tag = { writeTags };
})();
