(() => {
"use strict";

// Backend API hosted on Render
const API_BASE = "https://verfy-5znt.onrender.com";

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

/* If the session cookie expires mid-use, any /api/* call will start
   returning 401 — send the user back to the login page instead of
   leaving them staring at a library that silently stopped loading. */
(() => {
  const _fetch = window.fetch.bind(window);

window.fetch = async (...args) => {
  // Send API requests to the FastAPI backend on Render
  if (typeof args[0] === "string" && args[0].startsWith("/api/")) {
    args[0] = apiUrl(args[0]);
  }

  // Send session cookies with cross-origin API requests
  if (typeof args[1] === "object" && args[1] !== null) {
    args[1].credentials = "include";
  } else {
    args[1] = { credentials: "include" };
  }

  const res = await _fetch(...args);

  const url =
    typeof args[0] === "string"
      ? args[0]
      : (args[0] && args[0].url) || "";

  return res;
};
})();

/* ============================================================
   STATE
   ============================================================ */
const state = {
  tracks: [],            // {id,title,artist,album,year,art,duration,favorite,file,fingerprint}
  playlists: [],         // {id,name,trackIds:[]}
  view: "library",       // library | playlists | artists | favorites | queue | playlist:<id> | artist:<name>
  listMode: "grid",
  search: "",
  queue: [],             // array of track ids, the play order
  queueIndex: -1,
  shuffle: false,
  repeat: "off",         // off | all | one
  volume: 0.7,
  muted: false,
};

let audioEl = new Audio();
audioEl.preload = "metadata";
let audioCtx = null, analyser = null, sourceNode = null, freqData = null;
let rafViz = null;

/* ============================================================
   SYSTEM MEDIA CONTROLS
   ============================================================
   Android's notification / lock-screen media card is driven by the browser's
   Media Session API.  Keep it tied to the same audio element that powers the
   in-app player so notification actions and UI actions can never get out of
   sync.  Browsers that do not support Media Session simply ignore this.
   ============================================================ */
const mediaSession = navigator.mediaSession || null;

function mediaArtworkFor(track){
  if(!track || !track.art) return [];
  // MediaMetadata resolves relative URLs in most browsers, but an absolute
  // URL is required by a few Android WebView/browser versions.
  let src = track.art;
  try{ src = new URL(track.art, window.location.href).href; }catch(_){}
  return [96, 128, 192, 256, 384, 512].map(size => ({
    src, sizes: `${size}x${size}`, type: "image/jpeg"
  }));
}

function updateMediaSessionMetadata(){
  if(!mediaSession || !window.MediaMetadata) return;
  const track = currentTrack();
  if(!track) return;
  try{
    mediaSession.metadata = new MediaMetadata({
      title: track.title || "Unknown title",
      artist: artistCreditsLabel(track) || "Unknown artist",
      album: track.album || "",
      artwork: mediaArtworkFor(track),
    });
  }catch(err){
    // Metadata is an enhancement; invalid embedded artwork must never stop
    // playback (notably on older Android browsers).
    console.warn("Could not set system media metadata", err);
  }
}

function updateMediaSessionPosition(){
  if(!mediaSession || !mediaSession.setPositionState) return;
  const duration = audioEl.duration;
  const position = audioEl.currentTime;
  if(!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
  try{
    mediaSession.setPositionState({
      duration,
      position: Math.max(0, Math.min(position, duration)),
      playbackRate: audioEl.playbackRate || 1,
    });
  }catch(_){}
}

const AURA_PALETTE = [
  ["#8b7fff","#54e8d4"], ["#ff8fb1","#8b7fff"], ["#54e8d4","#3aa0ff"],
  ["#ffb86b","#ff6b9d"], ["#6bd6ff","#8b7fff"], ["#c084fc","#54e8d4"],
];

/* ============================================================
   UTIL
   ============================================================ */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36);

function fmtTime(s){
  if(!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s/60), sec = Math.floor(s%60);
  return m + ":" + String(sec).padStart(2,"0");
}
function fmtLongDuration(s){
  if(!Number.isFinite(s) || s < 0) return "0 min";
  const totalMinutes = Math.round(s / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if(hours === 0) return `${minutes} min`;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}
function hashStr(str){
  let h = 0;
  for(let i=0;i<str.length;i++){ h = (Math.imul(31,h) + str.charCodeAt(i))|0; }
  return Math.abs(h);
}
function toast(msg){
  const el = document.createElement("div");
  el.className = "toast"; el.textContent = msg;
  $("#toastWrap").appendChild(el);
  setTimeout(()=>{ el.style.transition="opacity .3s"; el.style.opacity="0"; setTimeout(()=>el.remove(),300); }, 2600);
}

/* ---------- procedural aura artwork (signature visual) ---------- */
function generateAura(seed, size=300){
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  const h = hashStr(seed);
  const palette = AURA_PALETTE[h % AURA_PALETTE.length];
  const angle = (h % 360) * Math.PI/180;
  const cx = size/2 + Math.cos(angle)*size*0.15;
  const cy = size/2 + Math.sin(angle)*size*0.15;

  ctx.fillStyle = "#12151e";
  ctx.fillRect(0,0,size,size);

  const g1 = ctx.createRadialGradient(cx,cy,0,cx,cy,size*0.75);
  g1.addColorStop(0, palette[0]);
  g1.addColorStop(0.5, palette[1]+"55");
  g1.addColorStop(1, "#0c0e1400");
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = g1;
  ctx.fillRect(0,0,size,size);

  const cx2 = size - cx, cy2 = size - cy;
  const g2 = ctx.createRadialGradient(cx2,cy2,0,cx2,cy2,size*0.6);
  g2.addColorStop(0, palette[1]);
  g2.addColorStop(1, "#0c0e1400");
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = g2;
  ctx.fillRect(0,0,size,size);

  // soft concentric rings
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  for(let r = size*0.12; r < size*0.55; r += size*0.12){
    ctx.beginPath();
    ctx.arc(cx, cy, r, (h%628)/100, (h%628)/100 + Math.PI*1.3);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return canvas.toDataURL("image/jpeg", 0.85);
}

/* ============================================================
   TEMPORARY LYRIC-SYNC DEBUG LOGGING
   Traces the pipeline end to end: SYLT/USLT parsing decisions,
   playback time, matched lyric line, and every seek. Flip
   LYRICS_SYNC_DEBUG to false (or run it from devtools) to silence.
   Safe to delete once sync is confirmed solid in the field.
   ============================================================ */
let LYRICS_SYNC_DEBUG = false;
let _lyricsLastLoggedIdx = null;
let lyricsSyncClockRaf = null;
const LyricsDebug = {
  log(...args){ if(LYRICS_SYNC_DEBUG) console.log("%c[lyrics-sync]", "color:#54e8d4;font-weight:600;", ...args); },
  warn(...args){ if(LYRICS_SYNC_DEBUG) console.warn("[lyrics-sync]", ...args); },
};

/* ============================================================
   ID3 METADATA PARSER (v2.2 / v2.3 / v2.4, common frames)
   ============================================================ */
function syncsafe(bytes, offset){
  return ((bytes[offset]&0x7f)<<21) | ((bytes[offset+1]&0x7f)<<14) | ((bytes[offset+2]&0x7f)<<7) | (bytes[offset+3]&0x7f);
}
function beInt(bytes, offset, len){
  let v = 0;
  for(let i=0;i<len;i++) v = (v<<8) | bytes[offset+i];
  return v >>> 0;
}
function decodeText(bytes, encByte){
  try{
    if(encByte === 0) return new TextDecoder("latin1").decode(bytes).replace(/\0+$/,"");
    if(encByte === 1) return new TextDecoder("utf-16").decode(bytes).replace(/\0+$/,"");
    if(encByte === 2) return new TextDecoder("utf-16be").decode(bytes).replace(/\0+$/,"");
    return new TextDecoder("utf-8").decode(bytes).replace(/\0+$/,"");
  }catch(e){ return ""; }
}
function findNullTerm(bytes, start, wide){
  for(let i=start;i<bytes.length-(wide?1:0);i+= (wide?2:1)){
    if(wide){ if(bytes[i]===0 && bytes[i+1]===0) return i; }
    else{ if(bytes[i]===0) return i; }
  }
  return bytes.length;
}

/* ---- lyric frame parsers (SYLT = synchronized, USLT = plain) ---- */
/*
   ROOT CAUSE (fixed here): SYLT timestamps can be stored in one of two units,
   selected by a byte in the frame itself (`time stamp format`):
     1 = MPEG frame count   2 = absolute milliseconds
   The previous parser treated format-1 timestamps as "frame count * 26ms",
   assuming every file is a standard 44.1kHz MPEG1/Layer III stream (where a
   frame really is ~26.1ms). Any file encoded at a different sample rate or
   MPEG version/layer (32kHz, 48kHz, 22.05kHz, MPEG2, ...) has a genuinely
   different frame duration, so that constant silently produced the wrong
   millisecond value for every single line — which is exactly why lyrics
   appeared to "jump ahead" from the very first line rather than drifting in
   gradually. Fixed by computing the real frame duration from the file's own
   first MPEG audio frame header instead of assuming a fixed number.
*/
function decodeMpegFrameHeader(bytes, offset){
  if(bytes[offset] !== 0xFF || (bytes[offset+1] & 0xE0) !== 0xE0) return null;
  const verId = (bytes[offset+1] >> 3) & 0x03;   // 0=MPEG2.5, 1=reserved, 2=MPEG2, 3=MPEG1
  const layerId = (bytes[offset+1] >> 1) & 0x03; // 0=reserved, 1=Layer III, 2=Layer II, 3=Layer I
  const srIndex = (bytes[offset+2] >> 2) & 0x03;
  if(verId === 1 || layerId === 0 || srIndex === 3) return null; // reserved combinations
  const SAMPLE_RATES = { 3:[44100,48000,32000], 2:[22050,24000,16000], 0:[11025,12000,8000] };
  const sampleRate = SAMPLE_RATES[verId][srIndex];
  if(!sampleRate) return null;
  let samplesPerFrame;
  if(layerId === 3) samplesPerFrame = 384;                 // Layer I
  else if(layerId === 2) samplesPerFrame = 1152;            // Layer II
  else samplesPerFrame = (verId === 3) ? 1152 : 576;        // Layer III: MPEG1=1152, MPEG2/2.5=576
  return { sampleRate, samplesPerFrame, msPerFrame: samplesPerFrame / sampleRate * 1000 };
}
// Scans a window of the actual audio stream (right after the ID3v2 tag) for the
// first valid MPEG frame sync, and returns the true ms-per-frame for THIS file.
// Only called for the rare SYLT files that use frame-count timestamps, so it
// has no cost for the common absolute-millisecond case or for playback itself.
async function detectMpegFrameDurationMs(file, streamStartOffset){
  try{
    const windowSize = Math.min(16384, Math.max(0, file.size - streamStartOffset));
    if(windowSize < 4) return null;
    const buf = await file.slice(streamStartOffset, streamStartOffset + windowSize).arrayBuffer();
    const bytes = new Uint8Array(buf);
    for(let i=0; i<bytes.length-4; i++){
      const hdr = decodeMpegFrameHeader(bytes, i);
      if(hdr) return hdr;
    }
  }catch(e){ LyricsDebug.warn("frame-duration detection failed:", e.message); }
  return null;
}

function parseSyltFrame(frame, msPerUnit){
  try{
    const enc = frame[0];
    const wide = enc===1 || enc===2;
    let idx = 6; // encoding(1) + language(3) + timestamp format(1) + content type(1)
    const descEnd = findNullTerm(frame, idx, wide);
    idx = descEnd + (wide?2:1);
    const lines = [];
    let dropped = 0;
    while(idx < frame.length){
      const textEnd = findNullTerm(frame, idx, wide);
      if(textEnd >= frame.length) break;
      const text = decodeText(frame.subarray(idx, textEnd), enc);
      idx = textEnd + (wide?2:1);
      if(idx + 4 > frame.length) break;
      const timestamp = beInt(frame, idx, 4);
      idx += 4;
      const time = timestamp * msPerUnit;
      if(Number.isFinite(time)) lines.push({ time, text });
      else dropped++;
    }
    if(dropped) LyricsDebug.warn(`SYLT: dropped ${dropped} entr${dropped===1?"y":"ies"} with invalid timestamps`);
    return lines.length ? lines : null;
  }catch(e){ LyricsDebug.warn("SYLT parse threw:", e.message); return null; }
}
function parseUsltFrame(frame){
  try{
    const enc = frame[0];
    const wide = enc===1 || enc===2;
    let idx = 4; // encoding byte + 3-byte language code
    const descEnd = findNullTerm(frame, idx, wide);
    idx = descEnd + (wide?2:1);
    const text = decodeText(frame.subarray(idx), enc);
    return text && text.trim() ? text : null;
  }catch(e){ LyricsDebug.warn("USLT parse threw:", e.message); return null; }
}

async function parseID3(file){
  const meta = { title:null, artist:null, album:null, year:null, picture:null, sylt:null, uslt:null };
  try{
    const headBuf = await file.slice(0,10).arrayBuffer();
    const head = new Uint8Array(headBuf);
    if(!(head[0]===0x49 && head[1]===0x44 && head[2]===0x33)) return meta; // "ID3"
    const majorVer = head[3];
    const tagSize = syncsafe(head, 6);
    if(tagSize <= 0) return meta;
    const bodyBuf = await file.slice(10, 10+tagSize).arrayBuffer();
    const body = new Uint8Array(bodyBuf);
    let pos = 0;

    while(pos < body.length - 4){
      let frameId, frameSize, headerLen;
      if(majorVer === 2){
        frameId = String.fromCharCode(body[pos],body[pos+1],body[pos+2]);
        if(frameId === "\0\0\0") break;
        frameSize = beInt(body,pos+3,3);
        headerLen = 6;
      } else {
        frameId = String.fromCharCode(body[pos],body[pos+1],body[pos+2],body[pos+3]);
        if(frameId === "\0\0\0\0") break;
        frameSize = majorVer===4 ? syncsafe(body,pos+4) : beInt(body,pos+4,4);
        headerLen = 10;
      }
      const dataStart = pos + headerLen;
      const dataEnd = dataStart + frameSize;
      if(frameSize <= 0 || dataEnd > body.length) break;
      const frame = body.subarray(dataStart, dataEnd);

      if(["TIT2","TT2"].includes(frameId)) meta.title = decodeText(frame.subarray(1), frame[0]);
      else if(["TPE1","TP1"].includes(frameId)) meta.artist = decodeText(frame.subarray(1), frame[0]);
      else if(["TALB","TAL"].includes(frameId)) meta.album = decodeText(frame.subarray(1), frame[0]);
      else if(["TYER","TDRC","TYE"].includes(frameId)) meta.year = decodeText(frame.subarray(1), frame[0]).slice(0,4);
      else if(["APIC","PIC"].includes(frameId) && !meta.picture){
        try{
          const enc = frame[0];
          let idx = 1, mime = "image/jpeg";
          if(frameId === "APIC"){
            const mimeEnd = findNullTerm(frame, idx, false);
            mime = decodeText(frame.subarray(idx, mimeEnd), 0) || "image/jpeg";
            idx = mimeEnd + 1;
            idx += 1; // picture type byte
            const wide = enc===1 || enc===2;
            const descEnd = findNullTerm(frame, idx, wide);
            idx = descEnd + (wide?2:1);
          } else {
            const fmt = String.fromCharCode(frame[idx],frame[idx+1],frame[idx+2]);
            mime = fmt.toUpperCase()==="PNG" ? "image/png" : "image/jpeg";
            idx += 3 + 1;
            const wide = enc===1 || enc===2;
            const descEnd = findNullTerm(frame, idx, wide);
            idx = descEnd + (wide?2:1);
          }
          const imgBytes = frame.subarray(idx);
          if(imgBytes.length > 100){
            const blob = new Blob([imgBytes], {type:mime});
            meta.picture = URL.createObjectURL(blob);
          }
        }catch(e){ /* ignore malformed picture frame */ }
      }
      else if(["SYLT","SLT"].includes(frameId) && !meta.sylt){
        const tsFormat = frame[4]; // 1 = MPEG frame count, 2 = absolute milliseconds
        let msPerUnit = 1;
        if(tsFormat === 1){
          const hdr = await detectMpegFrameDurationMs(file, 10 + tagSize);
          if(hdr){
            msPerUnit = hdr.msPerFrame;
            LyricsDebug.log(`${file.name}: SYLT uses MPEG-frame timestamps; detected ${hdr.sampleRate}Hz stream → ${hdr.msPerFrame.toFixed(3)}ms/frame`);
          } else {
            msPerUnit = 26.122; // MPEG1/Layer III @ 44.1kHz frame duration — last-resort fallback only
            LyricsDebug.warn(`${file.name}: SYLT uses MPEG-frame timestamps but no valid audio frame header was found; falling back to a 44.1kHz estimate (times may drift)`);
          }
        }
        const lines = parseSyltFrame(frame, msPerUnit);
        if(lines){
          lines.sort((a,b)=>a.time-b.time);
          meta.sylt = lines;
          LyricsDebug.log(`${file.name}: SYLT parsed — ${lines.length} lines, first="${lines[0].text}" @${(lines[0].time/1000).toFixed(2)}s, last @${(lines[lines.length-1].time/1000).toFixed(2)}s`);
        }
      }
      else if(["USLT","ULT"].includes(frameId) && !meta.uslt){
        const text = parseUsltFrame(frame);
        if(text) meta.uslt = text;
      }
      pos = dataEnd;
    }
  }catch(e){ /* not a readable/ID3 file — fall back to filename */ }
  return meta;
}

function titleFromFilename(name){
  return name.replace(/\.[^.]+$/,"").replace(/^\d+[\s._-]*/,"").replace(/[_]+/g," ").trim() || "Untitled";
}

/* ============================================================
   LYRICS ENGINE — modular and source-agnostic.
   Every source normalizes into one of two shapes:
     synced: { source, lines:[{ time (ms), text }] }   — sorted ascending
     plain:  { source, text }
   or null when nothing usable was found. The UI only ever reads
   this normalized shape, so adding a new source never touches
   the rendering code below.
   ============================================================ */
const LyricsEngine = (() => {
  // Embedded ID3 tags, already extracted during import (SYLT preferred over USLT).
  function fromID3(meta){
    if(!meta) return null;
    if(meta.sylt && meta.sylt.length) return { source:"sylt", lines: meta.sylt };
    if(meta.uslt) return { source:"uslt", text: meta.uslt };
    return null;
  }
  // Future: a standalone .lrc file's contents, in the same synced shape.
  // Pure function — ready to wire up to a file picker or drag-and-drop later.
  function fromLRC(lrcText){
    if(!lrcText) return null;
    const stamp = /\[(\d{1,2}):(\d{2}(?:[.:]\d{1,3})?)\]/g;
    const lines = [];
    lrcText.split(/\r?\n/).forEach(raw => {
      const matches = [...raw.matchAll(stamp)];
      if(matches.length === 0) return;
      const text = raw.replace(stamp,"").trim();
      matches.forEach(m => {
        const time = (parseInt(m[1],10)*60 + parseFloat(m[2].replace(":","."))) * 1000;
        lines.push({ time, text });
      });
    });
    if(lines.length === 0) return null;
    lines.sort((a,b)=>a.time-b.time);
    return { source:"lrc", lines };
  }
  // Online lookup — LRCLIB (https://lrclib.net), a free, keyless, CORS-enabled
  // public database purpose-built for synced (LRC) lyrics. Called straight from
  // the browser: this app has no server of its own, so a backend that could
  // hold a private API key isn't an option here, and LRCLIB needs none anyway.
  // Strategy: try the exact-match endpoint first (fast, precise when we know
  // the track's duration), then fall back to fuzzy search and pick whichever
  // candidate's duration is closest to ours.
  const LRCLIB_BASE = "https://lrclib.net/api";
  function lrclibResultToLyrics(data){
    if(!data || data.instrumental) return null;
    if(data.syncedLyrics && data.syncedLyrics.trim()){
      const parsed = fromLRC(data.syncedLyrics);
      if(parsed) return { source:"online-synced", lines: parsed.lines };
    }
    if(data.plainLyrics && data.plainLyrics.trim()){
      return { source:"online-plain", text: data.plainLyrics };
    }
    return null;
  }
  async function fromOnline(track){
    if(!track || !track.title){ LyricsDebug.log("online: skipped, no title to search with"); return null; }
    if(!track.artist || track.artist === "Unknown artist"){
      LyricsDebug.log(`online: skipped for "${track.title}" — artist is unknown, a search would be unreliable`);
      return null;
    }
    const durationSec = Math.round(track.duration || 0);
    const baseParams = { track_name: track.title, artist_name: track.artist };
    if(track.album && track.album !== "Unknown album") baseParams.album_name = track.album;

    // 1) exact match (only meaningful once we know the track's duration)
    if(durationSec > 0){
      try{
        const url = `${LRCLIB_BASE}/get?` + new URLSearchParams({ ...baseParams, duration:durationSec });
        LyricsDebug.log("online: exact-match query →", url);
        const res = await fetch(url);
        LyricsDebug.log("online: exact-match response status", res.status);
        if(res.ok){
          const data = await res.json();
          const parsed = lrclibResultToLyrics(data);
          LyricsDebug.log("online: exact-match parsed result →", parsed ? `${parsed.source}, ${parsed.lines?parsed.lines.length+" lines":parsed.text.length+" chars"}` : "none usable");
          if(parsed) return parsed;
        }
      }catch(e){ LyricsDebug.warn("online: exact-match request failed —", e.message); }
    }

    // 2) fuzzy search fallback
    try{
      const url = `${LRCLIB_BASE}/search?` + new URLSearchParams(baseParams);
      LyricsDebug.log("online: search query →", url);
      const res = await fetch(url);
      LyricsDebug.log("online: search response status", res.status);
      if(!res.ok) return null;
      const results = await res.json();
      LyricsDebug.log(`online: search returned ${Array.isArray(results)?results.length:0} candidate(s)`);
      if(!Array.isArray(results) || results.length === 0) return null;
      const best = durationSec > 0
        ? results.reduce((a,b) => Math.abs((a.duration||0)-durationSec) <= Math.abs((b.duration||0)-durationSec) ? a : b)
        : results[0];
      const parsed = lrclibResultToLyrics(best);
      LyricsDebug.log("online: best candidate", `"${best.trackName}" by ${best.artistName}`, "→", parsed ? parsed.source : "no usable lyrics (instrumental or empty)");
      return parsed;
    }catch(e){ LyricsDebug.warn("online: search request failed —", e.message); return null; }
  }
  // Resolution order a caller should use: embedded synced/plain first (instant,
  // free, already on disk), then local .lrc, then online, cheapest and most
  // reliable sources first.
  async function resolve(track, idMeta){
    let result = fromID3(idMeta);
    if(!result) result = await fromOnline(track);
    return result || null;
  }
  return { fromID3, fromLRC, fromOnline, resolve };
})();

/* ============================================================
   ARTIST PHOTOS — resolved on demand, just like online lyrics.
   Album art remains visible immediately; a verified portrait replaces it only
   when the local server finds an exact artist-name match in its public catalog.
   ============================================================ */
const ArtistPhotoEngine = (() => {
  const resolved = new Map(); // artist name -> URL or null (a confirmed miss)
  const pending = new Set();
  const queue = [];
  let activeRequests = 0;
  const MAX_CONCURRENT_REQUESTS = 4;

  function apply(name, url){
    if(!url) return;
    document.querySelectorAll("[data-artist-photo]").forEach(img => {
      if(img.dataset.artistPhoto !== name) return;
      const fallback = img.src;
      img.addEventListener("error", () => { img.src = fallback; }, {once:true});
      img.src = url;
    });
  }

  async function lookup(name){
    try{
      const res = await fetch("/api/artists/photo?" + new URLSearchParams({name}));
      const data = res.ok ? await res.json() : null;
      const url = data && typeof data.url === "string" ? data.url : null;
      resolved.set(name, url);
      apply(name, url);
    }catch(_){
      // Offline or unavailable catalogs leave the existing album art in place.
      resolved.set(name, null);
    }finally{
      pending.delete(name);
    }
  }

  function pump(){
    while(activeRequests < MAX_CONCURRENT_REQUESTS && queue.length){
      const name = queue.shift();
      activeRequests++;
      lookup(name).finally(() => { activeRequests--; pump(); });
    }
  }

  function resolve(name){
    if(!name) return;
    if(resolved.has(name)){
      apply(name, resolved.get(name));
      return;
    }
    if(pending.has(name)) return;
    pending.add(name);
    queue.push(name);
    pump();
  }

  function resolveAll(artists){ artists.forEach(artist => resolve(artist.name)); }
  return { resolve, resolveAll };
})();

const ArtistProfileEngine = (() => {
  const resolved = new Map();
  const pending = new Set();

  function displayCount(value){
    const number = Number(value);
    return Number.isFinite(number) ? new Intl.NumberFormat().format(number) : value;
  }

  function safeExternalUrl(value){
    if(typeof value !== "string") return null;
    try{
      const url = new URL(value);
      return url.protocol === "https:" ? url.href : null;
    }catch(_){
      return null;
    }
  }

  function apply(name, profile){
    document.querySelectorAll("[data-artist-profile]").forEach(section => {
      if(section.dataset.artistProfile !== name) return;
      section.setAttribute("aria-busy", "false");
      const bio = section.querySelector("[data-artist-bio]");
      const tags = section.querySelector("[data-artist-tags]");
      const website = section.querySelector("[data-artist-website]");
      const source = section.querySelector("[data-artist-source]");
      bio.textContent = profile?.bio || "No artist biography is available from the public catalog.";

      const facts = [
        ["Genre", profile?.genre], ["Style", profile?.style], ["Mood", profile?.mood],
        ["Formed", profile?.formed_year], ["Followers", profile?.followers && displayCount(profile.followers)],
        ["Popularity", profile?.popularity && `${profile.popularity}/100`], ["Label", profile?.label],
      ].filter(([, value]) => value);
      tags.replaceChildren(...facts.map(([label, value]) => {
        const tag = document.createElement("span");
        tag.className = "artist-tag";
        tag.textContent = `${label}: ${value}`;
        return tag;
      }));
      tags.hidden = facts.length === 0;
      const sourceUrl = safeExternalUrl(profile?.source_url || profile?.website);
      source.replaceChildren();
      if(profile?.source){
        source.append(`Information for ${profile.lookup_name || name} from `);
        if(sourceUrl){
          const sourceLink = document.createElement("a");
          sourceLink.href = sourceUrl;
          sourceLink.target = "_blank";
          sourceLink.rel = "noopener noreferrer";
          sourceLink.textContent = profile.source;
          source.append(sourceLink);
        }else{
          source.append(profile.source);
        }
        source.hidden = false;
      }else{
        source.textContent = "Artist information unavailable";
        source.hidden = true;
      }

      const websiteUrl = safeExternalUrl(profile?.website);
      if(websiteUrl){
        website.href = websiteUrl;
        website.firstChild.textContent = profile.website_label || "Source page";
        website.hidden = false;
      }else{
        website.firstChild.textContent = "Source page";
        website.hidden = true;
      }
    });
  }

  async function resolve(name){
    if(!name) return;
    if(resolved.has(name)){ apply(name, resolved.get(name)); return; }
    if(pending.has(name)) return;
    pending.add(name);
    try{
      const res = await fetch("/api/artists/profile?" + new URLSearchParams({name}));
      const data = res.ok ? await res.json() : null;
      const profile = data && data.profile && typeof data.profile === "object" ? data.profile : null;
      resolved.set(name, profile);
      apply(name, profile);
    }catch(_){
      resolved.set(name, null);
      apply(name, null);
    }finally{
      pending.delete(name);
    }
  }
  return { resolve };
})();

/* ============================================================
   PERSISTENCE — IndexedDB keeps device-only player settings. Favorites,
   playlists, tracks, lyrics, covers, and audio are PostgreSQL-backed.
   ============================================================ */
const AuralisDB = (() => {
  const DB_NAME = "auralis-db", DB_VERSION = 1;
  const STORE_KV = "kv", STORE_HANDLES = "handles";
  let dbPromise = null;
  function open(){
    if(dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if(!("indexedDB" in window)){ reject(new Error("IndexedDB unsupported")); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
        if(!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function store(name, mode){ const db = await open(); return db.transaction(name, mode).objectStore(name); }
  async function get(key, storeName = STORE_KV){
    try{
      const s = await store(storeName, "readonly");
      return await new Promise((resolve,reject)=>{
        const r = s.get(key);
        r.onsuccess = () => resolve(r.result === undefined ? null : r.result);
        r.onerror = () => reject(r.error);
      });
    }catch(e){ return null; }
  }
  async function set(key, value, storeName = STORE_KV){
    try{
      const s = await store(storeName, "readwrite");
      await new Promise((resolve,reject)=>{
        const r = s.put(value, key);
        r.onsuccess = () => resolve(); r.onerror = () => reject(r.error);
      });
      return true;
    }catch(e){ return false; }
  }
  async function del(key, storeName = STORE_KV){
    try{
      const s = await store(storeName, "readwrite");
      await new Promise((resolve,reject)=>{
        const r = s.delete(key);
        r.onsuccess = () => resolve(); r.onerror = () => reject(r.error);
      });
    }catch(e){}
  }
  return { get, set, del, STORE_KV, STORE_HANDLES };
})();

//where section is saved
async function saveSettings(){
  await AuralisDB.set("auralis:settings", JSON.stringify({
    volume: state.volume, muted: state.muted, shuffle: state.shuffle,
    repeat: state.repeat, listMode: state.listMode
  }));
}
async function saveLibraryMeta(){
  const favorites = state.tracks.filter(t=>t.favorite).map(t=>t.id);
  const playlists = state.playlists.map(p => ({
    id:p.id, name:p.name,
    trackIds: [...p.trackIds]
  }));
  try{
    const res = await fetch("/api/library/state", {
      method:"PUT", credentials:"same-origin",
      headers:{"Content-Type":"application/json", "X-CSRF-Token":await ensureCsrfToken()},
      body:JSON.stringify({favorites, playlists})
    });
    if(!res.ok) throw new Error("Could not save library state");
  }catch(error){ console.warn("Could not sync library state", error); }
}
async function loadPersisted(){
  try{
    const s = await AuralisDB.get("auralis:settings");
    if(s){
      const v = JSON.parse(s);
      state.volume = v.volume ?? 0.7; state.muted = !!v.muted;
      state.shuffle = !!v.shuffle; state.repeat = v.repeat || "off";
      state.listMode = v.listMode || "grid";
    }
  }catch(e){}
  window._persistedLibrary = null;
  try{
    const l = await AuralisDB.get("auralis:library");
    if(l) window._persistedLibrary = JSON.parse(l);
  }catch(e){}
}

function relinkPersistedLibrary(){
  const persisted = window._persistedLibrary;
  if(!persisted) return;
  const byId = new Map(state.tracks.map(t=>[t.id,t]));
  (persisted.favorites||[]).forEach(key => {
    const t = byId.get(key);
    if(t) t.favorite = true;
  });
  (persisted.playlists||[]).forEach(p => {
    let existing = state.playlists.find(pl=>pl.id===p.id);
    if(!existing){ existing = {id:p.id, name:p.name, trackIds:[]}; state.playlists.push(existing); }
    const keys = p.trackIds || p.fingerprints || [];
    keys.forEach(key => {
      const t = byId.get(key);
      if(t && !existing.trackIds.includes(t.id)) existing.trackIds.push(t.id);
    });
  });
}

/* ============================================================
   SERVER LIBRARY — songs are saved under data/uploads on disk
   ============================================================ */
function trackFromServer(payload){
  const customLyrics = payload.custom_lyrics || null;
  return {
    id: payload.id,
    title: payload.title || "Unknown title",
    artist: payload.artist || "Unknown artist",
    album: payload.album || "Unknown album",
    year: "",
    duration: payload.duration || 0,
    art: payload.cover_url || generateAura((payload.artist||"")+"|"+(payload.album||"")+"|"+(payload.title||"")),
    streamUrl: payload.stream_url,
    favorite: false,
    dateAdded: Date.now(),
    lyrics: customLyrics ? (LyricsEngine.fromLRC(customLyrics) || { source:"custom", text:customLyrics }) : null,
    customLyrics,
    lyricsResolved: !!customLyrics,
    lyricsLoading: false,
    fingerprint: payload.id,
  };
}

let serverLibraryRequest = null;
let serverLibraryLoaded = false;

async function loadServerLibrary(force = false){
  if(!force && serverLibraryLoaded){ return state.tracks.length; }
  if(!force && serverLibraryRequest){ return serverLibraryRequest; }

  serverLibraryRequest = (async () => {
    try{
      const res = await fetch("/api/tracks");
      if(!res.ok) throw new Error("bad status "+res.status);
      const data = await res.json();
      state.tracks = (data.tracks || []).map(trackFromServer);
      const legacy = window._persistedLibrary;
      const stateRes = await fetch("/api/library/state");
      if(stateRes.ok){
        const remote = await stateRes.json();
        if(!(remote.favorites||[]).length && !(remote.playlists||[]).length && legacy &&
           ((legacy.favorites||[]).length || (legacy.playlists||[]).length)){
          relinkPersistedLibrary();
          await saveLibraryMeta();
        } else {
          window._persistedLibrary = remote;
          relinkPersistedLibrary();
        }
      } else relinkPersistedLibrary();
      serverLibraryLoaded = true;
      return state.tracks.length;
    }catch(e){
      console.warn("Could not load server library", e);
      return 0;
    } finally {
      serverLibraryRequest = null;
    }
  })();

  return serverLibraryRequest;
}

/* ============================================================
   CSRF — fetched once per page load, sent on any state-changing
   /api/* call (upload, delete, password change).
   ============================================================ */
let csrfToken = $("meta[name='csrf-token']")?.content || null;
async function ensureCsrfToken(forceRefresh=false){
  if(csrfToken && !forceRefresh) return csrfToken;
  try{
    const res = await fetch("/api/csrf");
    if(res.ok){
      csrfToken = (await res.json()).csrf_token;
      return csrfToken;
    }
  }catch(_){}
  return null;
}

async function uploadFileToServer(file){
  const body = new FormData();
  body.append("file", file, file.name);
  const res = await fetch("/api/library/upload", {
    method: "POST",
    headers: { "X-CSRF-Token": await ensureCsrfToken() },
    body,
  });
  if(!res.ok){
    let detail = "Upload failed";
    try{ const err = await res.json(); detail = err.detail || detail; }catch(_){}
    throw new Error(detail);
  }
  return trackFromServer(await res.json());
}

async function deleteTrackOnServer(trackId){
  try{
    const res = await fetch(`/api/tracks/${encodeURIComponent(trackId)}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": await ensureCsrfToken() },
    });
    return res.ok;
  }catch(e){
    return false;
  }
}

async function saveTrackLyrics(track, lyrics){
  const save = async (refreshCsrf=false) => {
    const token = await ensureCsrfToken(refreshCsrf);
    return fetch(`/api/tracks/${encodeURIComponent(track.id)}/lyrics`, {
      method: "PUT",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token || "" },
      body: JSON.stringify({ lyrics }),
    });
  };
  let res = await save();
  // A tab can retain a token after the server-side session has rotated. Retry
  // once with a new token; do not turn a genuine authorization failure into a
  // lyric lookup miss.
  if(res.status === 403){
    res = await save(true);
  }
  if(res.status === 404){
    // A library migration can change the browser's cached fingerprint while
    // the title, artist, and audio remain the same. Rebind once, then retry.
    const libraryRes = await fetch("/api/tracks");
    if(libraryRes.ok){
      const data = await libraryRes.json();
      const match = (data.tracks || []).find(candidate =>
        candidate.title === track.title &&
        candidate.artist === track.artist &&
        Math.abs((candidate.duration || 0) - (track.duration || 0)) < 1
      );
      if(match){
        const oldId = track.id;
        Object.assign(track, trackFromServer(match));
        state.queue = state.queue.map(id => id === oldId ? track.id : id);
        res = await save();
      }
    }
  }
  if(!res.ok){
    let detail = res.status === 401 ? "Your session expired. Please sign in again." : "Could not save lyrics";
    try{ detail = (await res.json()).detail || detail; }catch(_){ }
    throw new Error(detail);
  }
  return await res.json();
}

const FS_SUPPORTED = "showDirectoryPicker" in window;
const AUDIO_EXT_RE = /\.(mp3|m4a|mp4|wav|flac|ogg|oga|aac|opus|weba)$/i;

async function collectAudioFiles(dirHandle, out = []){
  for await (const [name, handle] of dirHandle.entries()){
    if(handle.kind === "file"){
      if(AUDIO_EXT_RE.test(name)){
        try{ out.push(await handle.getFile()); }catch(e){}
      }
    } else if(handle.kind === "directory"){
      await collectAudioFiles(handle, out);
    }
  }
  return out;
}

async function connectMusicFolder(){
  if(FS_SUPPORTED){
    let dirHandle;
    try{
      dirHandle = await window.showDirectoryPicker({ id: "auralis-music", mode: "read" });
    }catch(e){ return; }
    toast(`Scanning “${dirHandle.name}”…`);
    const files = await collectAudioFiles(dirHandle);
    await importFiles(files);
    return;
  }
  $("#folderInput").click();
}

async function importFiles(fileList){
  const files = Array.from(fileList).filter(f => /audio\//.test(f.type) || AUDIO_EXT_RE.test(f.name));
  if(files.length === 0){ toast("No audio files found in that selection."); return; }
  toast(`Saving ${files.length} track${files.length>1?"s":""}…`);

  let added = 0, failed = 0;
  for(const file of files){
    try{
      const track = await uploadFileToServer(file);
      if(state.tracks.some(t=>t.id === track.id)) continue;
      state.tracks.push(track);
      added++;
    }catch(e){
      failed++;
      console.warn("Upload failed for", file.name, e);
    }
  }
  relinkPersistedLibrary();
  saveLibraryMeta();
  if(added) toast(`Saved ${added} track${added!==1?"s":""} to your library.`);
  else if(failed) toast("Couldn't save those files. Is Auralis running?");
  else toast("Those tracks were already in your library.");
  render();
}

/* ============================================================
   PLAYBACK ENGINE
   ============================================================ */
function ensureAudioGraph(){
  if(audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  sourceNode = audioCtx.createMediaElementSource(audioEl);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 128;
  freqData = new Uint8Array(analyser.frequencyBinCount);
  sourceNode.connect(analyser);
  analyser.connect(audioCtx.destination);
}

function currentTrack(){
  if(state.queueIndex < 0 || state.queueIndex >= state.queue.length) return null;
  const id = state.queue[state.queueIndex];
  return state.tracks.find(t => t.id === id) || null;
}

function buildQueueFrom(list, startId){
  state.queue = list.map(t=>t.id);
  state.queueIndex = Math.max(0, state.queue.indexOf(startId));
}

// Moves the track at fromIndex to sit at toIndex, keeping queueIndex pointed
// at whichever track it was pointed at before the move (not just the same
// numeric slot) so a reorder never silently changes what's "now playing".
function reorderQueue(fromIndex, toIndex){
  if(fromIndex === toIndex) return;
  const [moved] = state.queue.splice(fromIndex, 1);
  let insertAt = toIndex;
  if(fromIndex < toIndex) insertAt--;
  state.queue.splice(insertAt, 0, moved);
  if(state.queueIndex === fromIndex) state.queueIndex = insertAt;
  else if(fromIndex < state.queueIndex && insertAt >= state.queueIndex) state.queueIndex--;
  else if(fromIndex > state.queueIndex && insertAt <= state.queueIndex) state.queueIndex++;
}

function playTrackFromList(list, trackId){
  buildQueueFrom(list, trackId);
  playCurrent();
}

let currentBlobUrl = null;
function playCurrent(){
  const t = currentTrack();
  if(!t) return;
  ensureAudioGraph();
  if(audioCtx.state === "suspended") audioCtx.resume();
  if(currentBlobUrl){ URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
  if(t.streamUrl){
    audioEl.src = t.streamUrl;
  } else if(t.file){
    currentBlobUrl = URL.createObjectURL(t.file);
    audioEl.src = currentBlobUrl;
  } else {
    toast("This track has no playable source.");
    return;
  }
  audioEl.volume = state.muted ? 0 : state.volume;
  updateMediaSessionMetadata();
  audioEl.play().catch(()=>{});
  updateNowPlayingUI();
  renderQueuePanel();
  renderLibraryHighlight();
}

function togglePlay(){
  if(!currentTrack()){
    // nothing loaded yet: play first track of current view
    const list = getVisibleTracks();
    if(list.length){ playTrackFromList(list, list[0].id); }
    return;
  }
  if(audioEl.paused){
    ensureAudioGraph();
    if(audioCtx.state==="suspended") audioCtx.resume();
    // "Add to queue" on an empty queue sets queueIndex without ever assigning
    // audioEl.src — resume would call play() on an empty element and fail.
    if(!audioEl.getAttribute("src")){ playCurrent(); return; }
    audioEl.play().catch(()=>{});
  }
  else audioEl.pause();
}

function playNext(auto=false){
  if(state.queue.length === 0) return;
  if(state.repeat === "one" && auto){ audioEl.currentTime = 0; audioEl.play(); return; }
  if(state.shuffle){
    let next;
    if(state.queue.length === 1) next = 0;
    else { do { next = Math.floor(Math.random()*state.queue.length); } while(next === state.queueIndex); }
    state.queueIndex = next;
  } else {
    state.queueIndex++;
    if(state.queueIndex >= state.queue.length){
      if(state.repeat === "all") state.queueIndex = 0;
      else { state.queueIndex = state.queue.length-1; audioEl.pause(); return; }
    }
  }
  playCurrent();
}
function playPrev(){
  if(state.queue.length === 0) return;
  if(audioEl.currentTime > 3){ audioEl.currentTime = 0; return; }
  state.queueIndex = Math.max(0, state.queueIndex - 1);
  playCurrent();
}

function installMediaSessionHandlers(){
  if(!mediaSession) return;
  const handlers = {
    play: () => togglePlay(),
    pause: () => audioEl.pause(),
    previoustrack: () => playPrev(),
    nexttrack: () => playNext(false),
    seekbackward: (details) => {
      const offset = Number(details.seekOffset) || 10;
      audioEl.currentTime = Math.max(0, (audioEl.currentTime || 0) - offset);
    },
    seekforward: (details) => {
      const offset = Number(details.seekOffset) || 10;
      if(Number.isFinite(audioEl.duration)){
        audioEl.currentTime = Math.min(audioEl.duration, (audioEl.currentTime || 0) + offset);
      }
    },
    seekto: (details) => {
      if(Number.isFinite(details.seekTime)){
        const duration = audioEl.duration;
        audioEl.currentTime = Number.isFinite(duration)
          ? Math.max(0, Math.min(duration, details.seekTime))
          : Math.max(0, details.seekTime);
      }
    },
  };
  Object.entries(handlers).forEach(([action, handler]) => {
    try{ mediaSession.setActionHandler(action, handler); }catch(_){}
  });
}

installMediaSessionHandlers();

audioEl.addEventListener("ended", () => playNext(true));
audioEl.addEventListener("play", () => {
  syncPlayIcons(true);
  try{ if(mediaSession) mediaSession.playbackState = "playing"; }catch(_){}
  updateMediaSessionPosition();
});
audioEl.addEventListener("pause", () => {
  syncPlayIcons(false);
  try{ if(mediaSession) mediaSession.playbackState = "paused"; }catch(_){}
  updateMediaSessionPosition();
});
audioEl.addEventListener("timeupdate", () => {
  updateSeekUI();
  updateMediaSessionPosition();
  if($("#lyricsOverlay").classList.contains("open")) updateLyricsHighlight();
});
audioEl.addEventListener("seeked", () => {
  LyricsDebug.log(`seeked → t=${audioEl.currentTime.toFixed(2)}s, recalculating active line`);
  updateMediaSessionPosition();
  if($("#lyricsOverlay").classList.contains("open")) updateLyricsHighlight(true);
});
audioEl.addEventListener("loadedmetadata", () => {
  updateSeekUI();
  updateMediaSessionPosition();
});

function syncPlayIcons(playing){
  const pathPlay = 'M9 6.8v10.4L18.2 12z';
  const pathPause = 'M8 6.5h3.2v11H8zM12.8 6.5H16v11h-3.2z';
  $("#iconPlay").innerHTML = `<path d="${playing?pathPause:pathPlay}"/>`;
  $("#miniIconPlay").innerHTML = `<path d="${playing?pathPause:pathPlay}"/>`;
}

function updateSeekUI(){
  const dur = audioEl.duration || 0;
  const cur = audioEl.currentTime || 0;
  const pct = dur ? (cur/dur*100) : 0;
  $("#timeCur").textContent = fmtTime(cur);
  $("#timeDur").textContent = fmtTime(dur);
  $("#seekFill").style.width = pct+"%";
  $("#seekThumb").style.left = pct+"%";
  $("#miniCur").textContent = fmtTime(cur);
  $("#miniDur").textContent = fmtTime(dur);
  $("#miniSeekFill").style.width = pct+"%";
  $("#miniSeekThumb").style.left = pct+"%";
}

function updateNowPlayingUI(){
  const t = currentTrack();
  const bar = $("#nowbar");
  if(!t){ bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  $("#nowArt").src = t.art; $("#miniArt").src = t.art;
  $("#nowTitle").textContent = t.title; $("#miniTitle").textContent = t.title;
  const credits = artistCreditsLabel(t);
  $("#nowArtist").innerHTML = artistLinksMarkup(t);
  $("#nowArtist").classList.remove("artist-link");
  $("#nowArtist").title = credits;
  $("#miniArtist").textContent = credits;
  document.title = `${t.title} — ${credits} · Vervfy`;
  $("#nowFav").classList.toggle("on", !!t.favorite);
  updateVolUI();
  if($("#lyricsOverlay").classList.contains("open")) renderLyricsStage();
}

function renderLibraryHighlight(){
  const t = currentTrack();
  $$(".card").forEach(c => c.classList.toggle("playing", t && c.dataset.id===t.id));
  $$(".row").forEach(r => r.classList.toggle("playing", t && r.dataset.id===t.id));
}

/* ---------- lyrics view ---------- */
function lyricsEmptyMarkup(title, sub){
  return `<div class="lyrics-empty">
    <div class="empty-orb"></div>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(sub)}</p>
  </div>`;
}
function renderLyricsStage(){
  if(lyricsSyncClockRaf){
    cancelAnimationFrame(lyricsSyncClockRaf);
    lyricsSyncClockRaf = null;
  }
  const stage = $("#lyricsStage");
  const bg = $("#lyricsBg");
  const t = currentTrack();
  if(!t){
    bg.style.backgroundImage = "";
    stage.innerHTML = lyricsEmptyMarkup("Nothing playing", "Play a track to see its lyrics here.");
    return;
  }
  bg.style.backgroundImage = `url("${t.art}")`;
  const sourceLabel = { sylt:"Synced lyrics", lrc:"Synced · LRC", uslt:"Lyrics", custom:"Pasted lyrics", "custom-synced":"Synced · pasted", "online-synced":"Synced · LRCLIB", "online-plain":"Lyrics · LRCLIB" };
  const sideMarkup = `
    <div class="lyrics-side">
      <div class="lyrics-art"><img src="${t.art}" alt=""></div>
      <div class="lyrics-meta"><div class="t">${escapeHtml(t.title)}</div><div class="a">${escapeHtml(t.artist)}</div></div>
      ${t.lyrics ? `<div class="lyrics-source">${sourceLabel[t.lyrics.source] || "Lyrics"}</div>` : ""}
    </div>`;

  if(t.lyrics && t.lyrics.lines && t.lyrics.lines.length){
    const linesHtml = t.lyrics.lines.map((ln,i) =>
      `<div class="lyrics-line" data-time="${ln.time}" data-i="${i}">${escapeHtml(ln.text) || "&nbsp;"}</div>`
    ).join("");
    const resyncButton = t.customLyrics
      ? `<button class="btn lyrics-resync-btn" id="btnResyncLyrics">Re-sync to audio</button>`
      : "";
    stage.innerHTML = sideMarkup + `<div class="lyrics-viewport"><div class="lyrics-track" id="lyricsTrack">${linesHtml}</div></div>${resyncButton}`;
    // defensive: confirm lines are truly ascending — the highlight scan below
    // assumes this and only re-sorts here if something upstream ever regresses.
    const linesRef = t.lyrics.lines;
    for(let i=1;i<linesRef.length;i++){
      if(linesRef[i].time < linesRef[i-1].time){
        LyricsDebug.warn(`${t.title}: lyric lines were not ascending (index ${i-1}=${linesRef[i-1].time}ms > index ${i}=${linesRef[i].time}ms) — re-sorting`);
        linesRef.sort((a,b)=>a.time-b.time);
        break;
      }
    }
    _lyricsLastLoggedIdx = null; // new track/lines: force the next highlight update to log
    $$(".lyrics-line").forEach(el => {
      el.addEventListener("click", () => {
        const time = parseFloat(el.dataset.time)/1000;
        LyricsDebug.log(`click-to-seek → line "${el.textContent}" @ ${time.toFixed(2)}s`);
        if(isFinite(time)) audioEl.currentTime = time;
      });
    });
    $("#btnResyncLyrics")?.addEventListener("click", () => openLyricsSyncEditor(t));
    updateLyricsHighlight(true);
  } else if(t.lyrics && t.lyrics.text){
    const paragraphs = t.lyrics.text.split(/\n{2,}/).map(p => `<p>${escapeHtml(p)}</p>`).join("");
    stage.innerHTML = sideMarkup + `<div class="lyrics-plain">${paragraphs}<button class="btn btn-primary lyrics-sync-btn" id="btnSyncLyrics">Sync to audio</button></div>`;
    $("#btnSyncLyrics").addEventListener("click", () => openLyricsSyncEditor(t));
  } else if(!t.lyricsResolved){
    // Nothing cached yet. Prefer lyrics embedded in the saved file's ID3 tags
    // (instant, offline, already on disk), then fall back to LRCLIB.
    stage.innerHTML = sideMarkup + lyricsEmptyMarkup("Searching for lyrics…", "Checking this file and LRCLIB for a match.");
    stage.querySelector(".empty-orb")?.classList.add("lyrics-loading-orb");
    if(!t.lyricsLoading){
      t.lyricsLoading = true;
      const requestedTrackId = t.id;
      LyricsDebug.log(`state: lyrics lookup started for "${t.title}" by ${t.artist}`);
      (async () => {
        // `customLyrics` comes from this account's library record. It is
        // deliberately checked before any tag or network lookup so a saved
        // manual entry can never be replaced by LRCLIB's "not found" result.
        let result = t.customLyrics
          ? (LyricsEngine.fromLRC(t.customLyrics) || { source:"custom", text:t.customLyrics })
          : null;
        try{
          const headRes = result ? null : await fetch(`/api/tracks/${encodeURIComponent(t.id)}/tag-head`);
          if(headRes?.ok){
            const blob = await headRes.blob();
            const file = new File([blob], `${t.title || "track"}.mp3`, { type: "audio/mpeg" });
            const meta = await parseID3(file);
            result = LyricsEngine.fromID3(meta);
            if(result) LyricsDebug.log(`state: embedded ID3 lyrics found → ${result.source}`);
          }
        }catch(e){
          LyricsDebug.warn("state: embedded ID3 lyrics read failed —", e.message);
        }
        if(!result){
          result = await LyricsEngine.fromOnline(t);
        }
        return result;
      })().then(result => {
        // A manual lyric save wins over an older lookup that was still pending.
        if(t.customLyrics){
          t.lyricsLoading = false;
          return;
        }
        t.lyrics = result;
        t.lyricsResolved = true;
        t.lyricsLoading = false;
        LyricsDebug.log(`state: lyrics lookup finished for "${t.title}" →`, result ? result.source : "nothing found");
        const stillRelevant = currentTrack()?.id === requestedTrackId && $("#lyricsOverlay").classList.contains("open");
        LyricsDebug.log(`render: ${stillRelevant ? "re-rendering (still viewing this track)" : "skipping re-render (user moved on)"}`);
        if(stillRelevant) renderLyricsStage();
      }).catch(e => {
        t.lyricsResolved = true;
        t.lyricsLoading = false;
        LyricsDebug.warn("state: lyrics lookup threw —", e.message);
      });
    }
  } else {
    stage.innerHTML = sideMarkup + lyricsEmptyMarkup(
      "No lyrics available",
      "Vervfy checked this file's tags and LRCLIB's database, but couldn't find any lyrics for this track."
    ) + `<button class="btn btn-primary lyrics-paste-btn" id="btnPasteLyrics">Paste lyrics</button>`;
    $("#btnPasteLyrics").addEventListener("click", () => openLyricsEditor(t));
  }
}
function timedLyricsToLrc(lines){
  return lines.map(line => {
    const totalSeconds = Math.max(0, line.time) / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = (totalSeconds % 60).toFixed(2).padStart(5, "0");
    return `[${String(minutes).padStart(2, "0")}:${seconds}]${line.text}`;
  }).join("\n");
}
function openLyricsSyncEditor(track){
  const timedLines = track.lyrics?.lines;
  const text = track.lyrics?.text || track.customLyrics || "";
  const lines = timedLines?.length
    ? timedLines.map(line => line.text.trim()).filter(Boolean)
    : text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if(!lines.length){ toast("Paste lyrics before syncing them."); return; }

  // Plain lyric text contains no timing information.  Do not invent evenly
  // spaced timestamps: it looks synced, but every verse is wrong.  Instead,
  // record the audio clock when the listener taps each line.
  const stamps = new Array(lines.length).fill(null);
  const stage = $("#lyricsStage");
  const renderRows = () => lines.map((line, index) => {
    const stamp = stamps[index];
    return `<button type="button" class="lyrics-sync-line${stamp !== null ? " stamped" : ""}" data-line-index="${index}">
      <span class="lyrics-sync-line-time">${stamp === null ? "Tap at this line" : fmtTime(stamp / 1000)}</span>
      <span>${escapeHtml(line)}</span>
    </button>`;
  }).join("");
  stage.innerHTML = `
    <div class="lyrics-sync-editor">
      <div class="lyrics-editor-heading">
        <h3>Sync lyrics to audio</h3>
        <p>Start the song, then tap each line when it is sung. You can tap a line again to correct it.</p>
      </div>
      <div class="lyrics-sync-clock">Playback: <strong id="lyricsSyncTime">${fmtTime(audioEl.currentTime || 0)}</strong></div>
      <div class="lyrics-sync-lines" id="lyricsSyncLines">${renderRows()}</div>
      <div class="lyrics-editor-actions">
        <button class="btn" id="btnCancelLyricsSync">Back</button>
        <button class="btn" id="btnSyncFromStart">Play from start</button>
        <button class="btn btn-primary" id="btnSaveSyncedLyrics" disabled>Save synced lyrics</button>
      </div>
    </div>`;

  const saveButton = $("#btnSaveSyncedLyrics");
  const refresh = () => {
    const list = $("#lyricsSyncLines");
    if(!list) return;
    list.innerHTML = renderRows();
    list.querySelectorAll("[data-line-index]").forEach(button => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.lineIndex);
        stamps[index] = Math.max(0, Math.round((audioEl.currentTime || 0) * 1000));
        refresh();
      });
    });
    saveButton.disabled = stamps.some(stamp => stamp === null);
  };
  refresh();

  $("#btnCancelLyricsSync").addEventListener("click", renderLyricsStage);
  $("#btnSyncFromStart").addEventListener("click", () => {
    audioEl.currentTime = 0;
    audioEl.play().catch(() => toast("Press play, then tap each lyric line."));
  });
  saveButton.addEventListener("click", async () => {
    for(let index=1; index<stamps.length; index++){
      if(stamps[index] < stamps[index - 1]){
        toast("Lyrics must be tapped in song order. Correct the out-of-order line.");
        return;
      }
    }
    saveButton.disabled = true;
    try{
      const synced = { source:"custom-synced", lines: lines.map((line, index) => ({ time:stamps[index], text:line })) };
      const saved = await saveTrackLyrics(track, timedLyricsToLrc(synced.lines));
      track.customLyrics = saved.custom_lyrics;
      track.lyrics = synced;
      track.lyricsResolved = true;
      toast("Lyrics synced to the track");
      renderLyricsStage();
    }catch(e){
      saveButton.disabled = false;
      toast(e.message || "Could not save synced lyrics");
    }
  });

  const updateClock = () => {
    const clock = $("#lyricsSyncTime");
    if(!clock){ lyricsSyncClockRaf = null; return; }
    clock.textContent = fmtTime(audioEl.currentTime || 0);
    lyricsSyncClockRaf = requestAnimationFrame(updateClock);
  };
  updateClock();
}
function openLyricsEditor(track){
  const stage = $("#lyricsStage");
  stage.innerHTML = `
    <div class="lyrics-editor">
      <div class="lyrics-editor-heading">
        <h3>Add lyrics</h3>
        <p>${escapeHtml(track.title)} · ${escapeHtml(track.artist)}</p>
      </div>
      <textarea id="lyricsInput" class="lyrics-input" placeholder="Paste plain lyrics or timestamped LRC lyrics here…">${escapeHtml(track.customLyrics || track.lyrics?.text || "")}</textarea>
      <div class="lyrics-editor-actions">
        <button class="btn" id="btnCancelLyrics">Cancel</button>
        <button class="btn btn-primary" id="btnSaveLyrics">Save lyrics</button>
      </div>
    </div>`;
  $("#btnCancelLyrics").addEventListener("click", renderLyricsStage);
  $("#btnSaveLyrics").addEventListener("click", async () => {
    const input = $("#lyricsInput");
    const lyrics = input.value.trim();
    if(!lyrics){ input.focus(); toast("Paste some lyrics first."); return; }
    const button = $("#btnSaveLyrics");
    button.disabled = true;
    try{
      const parsed = LyricsEngine.fromLRC(lyrics);
      const synced = parsed;
      const lyricsToSave = synced?.lines ? timedLyricsToLrc(synced.lines) : lyrics;
      const saved = await saveTrackLyrics(track, lyricsToSave);
      // Use the value accepted by the account-scoped API, rather than merely
      // assuming the browser's request succeeded.
      track.customLyrics = saved.custom_lyrics;
      track.lyrics = LyricsEngine.fromLRC(track.customLyrics) || synced || { source:"custom", text:track.customLyrics };
      track.lyricsResolved = true;
      toast(synced?.lines ? "Timestamped lyrics saved" : "Lyrics saved — use Sync to audio to add timing");
      renderLyricsStage();
    }catch(e){
      button.disabled = false;
      toast(e.message || "Could not save lyrics");
    }
  });
  $("#lyricsInput").focus();
}
function updateLyricsHighlight(instant){
  const t = currentTrack();
  if(!t || !t.lyrics || !t.lyrics.lines) return;
  const track = $("#lyricsTrack");
  if(!track) return;
  const curSec = audioEl.currentTime || 0;
  const curMs = curSec * 1000;
  const lines = t.lyrics.lines;
  // "Active" is defined as the LAST line whose timestamp is <= current playback
  // time — lines are guaranteed ascending (sorted at parse time), so a single
  // forward scan that stops at the first future line is correct and cheap.
  let activeIdx = -1;
  for(let i=0;i<lines.length;i++){ if(lines[i].time <= curMs) activeIdx = i; else break; }

  if(LYRICS_SYNC_DEBUG && activeIdx !== _lyricsLastLoggedIdx){
    const matched = activeIdx >= 0 ? lines[activeIdx] : null;
    LyricsDebug.log(
      `t=${curSec.toFixed(2)}s`,
      "→ activeIdx=", activeIdx,
      matched ? `lineTime=${(matched.time/1000).toFixed(2)}s text="${matched.text}"` : "(before first line)"
    );
    _lyricsLastLoggedIdx = activeIdx;
  }

  const els = track.children;
  for(let i=0;i<els.length;i++){
    els[i].classList.toggle("active", i === activeIdx);
    els[i].classList.toggle("past", i < activeIdx);
  }
  // Always keep some line vertically centered in the viewport. Before playback
  // reaches the first timestamp (or when nothing is playing yet), activeIdx is
  // -1 and this used to skip centering entirely — leaving the whole lyrics
  // block pinned at the container's top edge with every line trailing
  // downward off-center instead of lining up with the album art beside it.
  // Anchor on the first line in that case so the block is centered even
  // before anything is "active".
  const anchorIdx = activeIdx >= 0 ? activeIdx : 0;
  const anchorEl = els[anchorIdx];
  if(anchorEl){
    // .lyrics-track already sits with its own top edge at the viewport's
    // vertical middle via `top:50%` in CSS. The translateY only needs to
    // pull the anchor line's own center up to that point — it must NOT also
    // add viewport.clientHeight/2, or the line ends up offset an extra half
    // a viewport-height too low (which is why lines were landing near the
    // bottom of the screen instead of centered next to the album art).
    const targetY = -(anchorEl.offsetTop + anchorEl.clientHeight/2);
    if(instant){
      track.style.transition = "none";
      track.style.transform = `translateY(${targetY}px)`;
      requestAnimationFrame(() => { track.style.transition = ""; });
    } else {
      track.style.transform = `translateY(${targetY}px)`;
    }
  }
}
function openLyrics(){ closeViz(); renderLyricsStage(); $("#lyricsOverlay").classList.add("open"); }
function closeLyrics(){
  $("#lyricsOverlay").classList.remove("open");
  if(lyricsSyncClockRaf){
    cancelAnimationFrame(lyricsSyncClockRaf);
    lyricsSyncClockRaf = null;
  }
}

/* ---------- full visualizer overlay (radial spectrum) ---------- */
function drawViz(){
  const canvas = $("#vizCanvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);
  const cx=w/2, cy=h/2, baseR = w*0.22;
  ctx.beginPath(); ctx.arc(cx,cy,baseR,0,Math.PI*2);
  ctx.fillStyle = "rgba(255,255,255,0.02)"; ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth=1; ctx.stroke();

  if(analyser && !audioEl.paused){
    analyser.getByteFrequencyData(freqData);
    const bands = 64;
    const step = Math.floor(freqData.length/bands);
    ctx.save(); ctx.translate(cx,cy);
    for(let i=0;i<bands;i++){
      let sum=0; for(let j=0;j<step;j++) sum += freqData[i*step+j];
      const amp = (sum/step)/255;
      const angle = (i/bands)*Math.PI*2 - Math.PI/2;
      const r1 = baseR+4, r2 = baseR+4+amp*(w*0.24);
      const x1=Math.cos(angle)*r1, y1=Math.sin(angle)*r1;
      const x2=Math.cos(angle)*r2, y2=Math.sin(angle)*r2;
      const grad = ctx.createLinearGradient(x1,y1,x2,y2);
      grad.addColorStop(0,"#8b7fff"); grad.addColorStop(1,"#54e8d455");
      ctx.strokeStyle=grad; ctx.lineWidth=w*0.006; ctx.lineCap="round";
      ctx.shadowBlur=14; ctx.shadowColor="#8b7fff88";
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    }
    ctx.restore();
  }
  rafViz = requestAnimationFrame(drawViz);
}
function openViz(){
  closeLyrics();
  const t = currentTrack();
  $("#vizTitle").textContent = t? t.title : "Nothing playing";
  $("#vizArtist").textContent = t? t.artist : "Import and play a track";
  $("#vizOverlay").classList.add("open");
  ensureAudioGraph();
  drawViz();
}
function closeViz(){
  $("#vizOverlay").classList.remove("open");
  if(rafViz) cancelAnimationFrame(rafViz);
}

function updateVolUI(){
  const pct = state.muted ? 0 : state.volume*100;
  $("#volFill").style.width = pct+"%";
  const svg = $("#iconVol");
  svg.style.opacity = state.muted ? 0.4 : 1;
}
function setVolume(v){
  state.volume = Math.min(1, Math.max(0, v));
  state.muted = false;
  audioEl.volume = state.volume;
  updateVolUI(); saveSettings();
}

/* ============================================================
   VIEW / FILTER HELPERS
   ============================================================ */
function artistNameOf(t){
  return (t && t.artist) ? t.artist : "Unknown artist";
}

/* Split collaboration credits into individual performers.
   Keep duo/band names that only use "&" / "and" (e.g. "Strings & Heart").
   Also pull featured names out of titles like "(feat. A, B & C)" / "(with SZA)". */
const ARTIST_LIST_SEP_RE = /\s*(?:,|;|\/|\bfeat(?:uring)?\.?\b|\bft\.?\b|\bwith\b)\s*/i;
const ARTIST_LIST_SEP_TEST_RE = /[,;/]|\bfeat(?:uring)?\.?\b|\bft\.?\b|\bwith\b/i;
const TITLE_FEATURED_RE = /\((?:feat(?:uring)?|ft|with)\.?\s+([^)]+)\)/ig;
const ARTIST_AND_SPLIT_RE = /\s+(?:&|and)\s+/i;

function cleanArtistCredit(part){
  return String(part || "")
    .replace(/^[\s\-–—·•]+|[\s\-–—·•]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitArtistCreditList(raw){
  const text = cleanArtistCredit(raw);
  if(!text) return [];
  if(text.toLocaleLowerCase() === "unknown artist") return [text];

  const hasListSep = ARTIST_LIST_SEP_TEST_RE.test(text);
  let parts = hasListSep ? text.split(ARTIST_LIST_SEP_RE) : [text];
  if(hasListSep){
    // Inside an already-listed credit, "&" / "and" separate people
    // ("Lalo Brito & José…"). Leave sole credits like "Strings & Heart" intact.
    parts = parts.flatMap(part => part.split(ARTIST_AND_SPLIT_RE));
  }
  return parts.map(cleanArtistCredit).filter(Boolean);
}

function featuredArtistsFromTitle(title){
  const text = String(title || "");
  const found = [];
  let match;
  TITLE_FEATURED_RE.lastIndex = 0;
  while((match = TITLE_FEATURED_RE.exec(text)) !== null){
    found.push(...splitArtistCreditList(match[1]));
  }
  return found;
}

function artistsOf(t){
  const names = [
    ...splitArtistCreditList(artistNameOf(t)),
    ...featuredArtistsFromTitle(t && t.title),
  ];
  const seen = new Map();
  for(const name of names){
    const key = name.toLocaleLowerCase();
    if(!seen.has(key)) seen.set(key, name);
  }
  return Array.from(seen.values());
}

function artistKey(name){
  return String(name || "").toLocaleLowerCase();
}

function trackHasArtist(t, name){
  const key = artistKey(name);
  return artistsOf(t).some(n => artistKey(n) === key);
}

function getArtists(){
  const map = new Map();
  for(const t of state.tracks){
    const names = artistsOf(t);
    if(!names.length) continue;
    const album = typeof t.album === "string" ? t.album.trim() : "";
    const duration = Number(t.duration);
    for(const name of names){
      const key = artistKey(name);
      let entry = map.get(key);
      if(!entry){
        entry = { name, art: t.art, tracks: [], albums: new Set(), duration: 0 };
        map.set(key, entry);
      } else if(name.length > entry.name.length){
        // Prefer the fuller casing/spelling when the same person appears twice.
        entry.name = name;
      }
      // A collab track belongs on each performer's profile once.
      if(entry.tracks.some(existing => existing.id === t.id)) continue;
      entry.tracks.push(t);
      if(album && album.toLocaleLowerCase() !== "unknown album"){
        entry.albums.add(album.toLocaleLowerCase());
      }
      if(Number.isFinite(duration) && duration > 0){
        entry.duration += duration;
      }
    }
  }
  return Array.from(map.values()).map(artist => ({
    ...artist,
    albumCount: artist.albums.size,
  })).sort((a,b)=> a.name.localeCompare(b.name, undefined, {sensitivity:"base"}));
}
function artistViewKey(name){
  return "artist:" + encodeURIComponent(name);
}
function artistNameFromView(view){
  return decodeURIComponent(view.slice(7));
}
function openArtist(name){
  if(!name) return;
  state.view = artistViewKey(name);
  state.search = "";
  const input = $("#searchInput");
  if(input) input.value = "";
  render();
}

function getVisibleTracks(){
  let list;
  if(state.view === "library") list = state.tracks;
  else if(state.view === "favorites") list = state.tracks.filter(t=>t.favorite);
  else if(state.view.startsWith("playlist:")){
    const pl = state.playlists.find(p=>p.id===state.view.slice(9));
    list = pl ? pl.trackIds.map(id=>state.tracks.find(t=>t.id===id)).filter(Boolean) : [];
  } else if(state.view.startsWith("artist:")){
    const name = artistNameFromView(state.view);
    list = state.tracks.filter(t => trackHasArtist(t, name));
  } else list = state.tracks;

  if(state.search.trim()){
    const q = state.search.toLowerCase();
    list = list.filter(t => (t.title+" "+t.artist+" "+t.album).toLowerCase().includes(q));
  }
  return list;
}

/* ============================================================
   RENDERING
   ============================================================ */
function render(){
  renderTopbar();
  if(state.view === "account") renderAccountView();
  else if(state.view === "playlists") renderPlaylistsView();
  else if(state.view === "artists") renderArtistsView();
  else if(state.view.startsWith("artist:")) renderArtistDetailView();
  else if(state.view === "queue") renderQueueView();
  else renderTrackListView();
  renderQueuePanel();
  renderLibraryHighlight();
}

function renderTopbar(){
  const titles = { library:"Library", favorites:"Favorites", playlists:"Playlists", artists:"Artists", queue:"Queue", account:"Account" };
  let title = titles[state.view];
  if(!title && state.view.startsWith("playlist:")){
    const pl = state.playlists.find(p=>p.id===state.view.slice(9));
    title = pl ? pl.name : "Playlist";
  } else if(!title && state.view.startsWith("artist:")){
    title = artistNameFromView(state.view);
  }
  $("#viewTitle").textContent = title || "Library";
  let count;
  if(state.view === "playlists") count = state.playlists.length;
  else if(state.view === "artists"){
    let artists = getArtists();
    if(state.search.trim()){
      const q = state.search.toLowerCase();
      artists = artists.filter(a => a.name.toLowerCase().includes(q));
    }
    count = artists.length;
  }
  else count = getVisibleTracks().length;
  $("#viewCount").textContent = (state.view!=="account" && state.tracks.length) ? `· ${count}` : "";
  $("#viewToggle").style.display = (state.view==="playlists"||state.view==="artists"||state.view==="queue"||state.view==="account") ? "none" : "flex";
  $(".search-wrap").style.display = state.view==="account" ? "none" : "flex";
  $("#btnImportTop").style.display = state.view==="account" ? "none" : "flex";
  $$(".rail-btn[data-view]").forEach(b=>{
    const active = b.dataset.view === state.view
      || (state.view.startsWith("playlist") && b.dataset.view==="playlists")
      || (state.view.startsWith("artist") && b.dataset.view==="artists");
    b.classList.toggle("active", active);
  });
}

function artistLinkMarkup(name){
  const label = escapeHtml(name);
  return `<button type="button" class="artist-link" data-action="artist" data-artist="${encodeURIComponent(name)}" title="View ${label}">${label}</button>`;
}
function artistLinksMarkup(t){
  const names = artistsOf(t);
  if(!names.length) return artistLinkMarkup("Unknown artist");
  return names.map(artistLinkMarkup).join('<span class="artist-sep">, </span>');
}
function artistCreditsLabel(t){
  const names = artistsOf(t);
  return names.length ? names.join(", ") : artistNameOf(t);
}
function trackRowMarkup(t, idx, showAlbum=true){
  const playing = currentTrack()?.id === t.id;
  const artistText = escapeHtml(artistCreditsLabel(t));
  const title = escapeHtml(t.title);
  const albumText = showAlbum ? escapeHtml(t.album) : "";
  return `
  <div class="row" data-id="${t.id}" draggable="true">
    <div class="row-idx">
      <span class="num">${idx+1}</span>
      <span class="play-mini" data-action="play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>
      <span class="bars"><span></span><span></span><span></span></span>
    </div>
    <div class="row-title-wrap">
      <img class="row-art" src="${t.art}" alt="">
      <div class="row-title-stack">
        <div class="row-title" title="${title}">${title}</div>
      </div>
    </div>
    <div class="row-artist-group" title="${showAlbum ? `${artistText} — ${albumText}` : artistText}">
      <div class="row-artist">${artistLinksMarkup(t)}</div>
      ${showAlbum ? `<div class="row-album" title="${albumText}">${albumText}</div>` : ""}
    </div>
    <div class="row-album-cell" title="${albumText}">${showAlbum ? albumText : ""}</div>
    <div class="row-time" data-track-time="${t.id}">${t.duration?fmtTime(t.duration):"--:--"}</div>
    <div class="row-actions">
      <button data-action="fav" class="${t.favorite?'fav-on':''}" title="Favorite"><svg viewBox="0 0 24 24" fill="${t.favorite?'currentColor':'none'}" stroke="currentColor" stroke-width="1.8"><path d="M12 20s-7-4.3-9.5-9C0.8 7.4 3 4 6.5 4c2 0 3.4 1.1 4.5 2.6C12.1 5.1 13.5 4 15.5 4 19 4 21.2 7.4 19.5 11 17 15.7 12 20 12 20Z"/></svg></button>
      <button data-action="menu" title="More"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>
    </div>
  </div>`;
}
function cardMarkup(t){
  const playing = currentTrack()?.id === t.id;
  return `
  <div class="card ${playing?'playing':''}" data-id="${t.id}">
    <div class="card-art">
      <img src="${t.art}" alt="">
      <div class="card-play"><button data-action="play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button></div>
    </div>
    <button class="card-fav ${t.favorite?'on':''}" data-action="fav"><svg viewBox="0 0 24 24" fill="${t.favorite?'currentColor':'none'}" stroke="currentColor" stroke-width="1.8"><path d="M12 20s-7-4.3-9.5-9C0.8 7.4 3 4 6.5 4c2 0 3.4 1.1 4.5 2.6C12.1 5.1 13.5 4 15.5 4 19 4 21.2 7.4 19.5 11 17 15.7 12 20 12 20Z"/></svg></button>
    <div class="card-title">${escapeHtml(t.title)}</div>
    <div class="card-sub">${artistLinksMarkup(t)}</div>
  </div>`;
}
function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m])); }

function renderTrackListView(){
  const content = $("#content");
  const list = getVisibleTracks();
  if(state.tracks.length === 0){
    content.innerHTML = emptyStateMarkup();
    $("#emptyAddFiles")?.addEventListener("click", ()=> $("#fileInput").click());
    $("#emptyAddFolder")?.addEventListener("click", connectMusicFolder);
    return;
  }
  if(list.length === 0){
    content.innerHTML = `<div class="empty"><div class="empty-orb"></div><h3>No matches</h3><p>Try a different search term, or browse your full library.</p></div>`;
    return;
  }
  if(state.listMode === "grid"){
    content.innerHTML = `<div class="grid">${list.map(t=>cardMarkup(t)).join("")}</div>`;
  } else {
    content.innerHTML = `
      <div class="list">
        <div class="list-head"><div></div><div>Title</div><div>Artist / Album</div><div>Album</div><div>Time</div><div></div></div>
        ${list.map((t,i)=>trackRowMarkup(t,i)).join("")}
      </div>`;
  }
  wireTrackInteractions(list);
}

function emptyStateMarkup(){
  return `
  <div class="empty">
    <div class="empty-orb"></div>
    <h3>Your library is empty</h3>
    <p>Add songs or a folder. Auralis saves them on this computer so they come back next time.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:6px;">
      <button class="btn btn-primary" id="emptyAddFiles">Add music</button>
      <button class="btn" id="emptyAddFolder">Add folder</button>
    </div>
  </div>`;
}

function wireArtistLinks(root=document){
  root.querySelectorAll('[data-action="artist"]').forEach(el=>{
    el.addEventListener("click",(e)=>{
      e.stopPropagation();
      openArtist(decodeURIComponent(el.dataset.artist || ""));
    });
  });
}
function wireTrackInteractions(list){
  $$(".card").forEach(card => {
    const t = state.tracks.find(x=>x.id===card.dataset.id);
    card.addEventListener("click",(e)=>{
      if(e.target.closest('[data-action="fav"],[data-action="artist"]')) return;
      playTrackFromList(list, t.id);
    });
    card.querySelector('[data-action="fav"]').addEventListener("click",(e)=>{ e.stopPropagation(); toggleFavorite(t); });
  });
  $$(".row").forEach(row => {
    const t = state.tracks.find(x=>x.id===row.dataset.id);
    row.addEventListener("click",(e)=>{
      if(e.target.closest('[data-action="fav"],[data-action="menu"],[data-action="artist"]')) return;
      playTrackFromList(list, t.id);
    });
    row.querySelector('[data-action="fav"]').addEventListener("click",(e)=>{ e.stopPropagation(); toggleFavorite(t); });
    const menuBtn = row.querySelector('[data-action="menu"]');
    if(menuBtn) menuBtn.addEventListener("click",(e)=>{ e.stopPropagation(); openTrackMenu(e, t); });
    row.addEventListener("dragstart", e=>{ e.dataTransfer.setData("text/plain", t.id); });
  });
  wireArtistLinks($("#content"));
}

function toggleFavorite(t){
  t.favorite = !t.favorite;
  saveLibraryMeta();
  render();
  if(currentTrack()?.id === t.id) $("#nowFav").classList.toggle("on", t.favorite);
}

function openTrackMenu(e, t){
  closeMenus();
  const menu = document.createElement("div");
  menu.className = "menu";
  const rect = e.target.closest("button").getBoundingClientRect();
  menu.style.top = rect.bottom+6+"px";
  menu.style.left = Math.min(window.innerWidth-210, rect.left-150)+"px";
  const inPlaylist = state.view.startsWith("playlist:") ? state.view.slice(9) : null;
  menu.innerHTML = `
    <div class="menu-item" data-act="queue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16M4 12h10M4 18h10"/></svg>Add to queue</div>
    <div class="menu-item" data-act="playlist"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>Add to playlist</div>
    <div class="menu-sep"></div>
    ${inPlaylist ? `<div class="menu-item" data-act="remove-from-playlist"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6 6 18"/></svg>Remove from this playlist</div>` : ""}
    <div class="menu-item" data-act="remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>Remove from library</div>
  `;
  document.body.appendChild(menu);
  menu.querySelector('[data-act="queue"]').addEventListener("click", ()=>{ addToQueue(t); closeMenus(); });
  menu.querySelector('[data-act="playlist"]').addEventListener("click", (ev)=>{ openPlaylistSubmenu(ev, t, menu); });
  if(inPlaylist) menu.querySelector('[data-act="remove-from-playlist"]').addEventListener("click", ()=>{ removeFromPlaylist(inPlaylist, t); closeMenus(); });
  menu.querySelector('[data-act="remove"]').addEventListener("click", ()=>{ removeTrack(t); closeMenus(); });
  setTimeout(()=> document.addEventListener("click", closeMenus, {once:true}), 0);
}
function openPlaylistSubmenu(e, t, parentMenu){
  e.stopPropagation();
  const old = parentMenu.querySelector(".menu-sub"); if(old) old.remove();
  const sub = document.createElement("div");
  sub.className = "menu menu-sub";
  const items = state.playlists.map(p=>`<div class="menu-item" data-pl="${p.id}">${escapeHtml(p.name)}</div>`).join("");
  sub.innerHTML = items + `<div class="menu-sep"></div><div class="menu-item" data-pl="new"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 5v14M5 12h14"/></svg>New playlist…</div>`;
  parentMenu.appendChild(sub);
  sub.querySelectorAll("[data-pl]").forEach(item=>{
    item.addEventListener("click", ()=>{
      if(item.dataset.pl === "new"){
        const name = prompt("Name your playlist");
        if(name && name.trim()){
          const pl = {id:uid(), name:name.trim(), trackIds:[t.id]};
          state.playlists.push(pl); saveLibraryMeta(); toast(`Created “${pl.name}” and added the track.`);
        }
      } else {
        const pl = state.playlists.find(p=>p.id===item.dataset.pl);
        if(pl && !pl.trackIds.includes(t.id)){ pl.trackIds.push(t.id); saveLibraryMeta(); toast(`Added to “${pl.name}”.`); }
        else if(pl) toast(`Already in “${pl.name}”.`);
      }
      closeMenus(); render();
    });
  });
}
function closeMenus(){ $$(".menu").forEach(m=>m.remove()); }

function stopPlayback(){
  audioEl.pause();
  audioEl.removeAttribute("src");
  audioEl.load();
  if(currentBlobUrl){ URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
  updateNowPlayingUI();
  syncPlayIcons(false);
}

// Drop one queue slot at `i`. If that slot was currently playing, advance
// playback to whatever lands in its place (or stop when the queue empties).
function removeQueueSlot(i){
  if(i < 0 || i >= state.queue.length) return;
  const removingCurrent = i === state.queueIndex;
  state.queue.splice(i, 1);
  if(state.queue.length === 0){
    state.queueIndex = -1;
    stopPlayback();
    return;
  }
  if(i < state.queueIndex) state.queueIndex--;
  else if(removingCurrent){
    if(state.queueIndex >= state.queue.length) state.queueIndex = state.queue.length - 1;
    playCurrent();
  }
}

async function removeTrack(t){
  const playingId = currentTrack()?.id || null;
  const wasPlaying = playingId === t.id;
  await deleteTrackOnServer(t.id);
  state.tracks = state.tracks.filter(x=>x.id!==t.id);
  state.playlists.forEach(p=> p.trackIds = p.trackIds.filter(id=>id!==t.id));
  // Strip every occurrence; keep queueIndex pointed at the same playing
  // track when it survived, otherwise advance / stop.
  state.queue = state.queue.filter(id=>id!==t.id);
  if(wasPlaying){
    if(state.queue.length === 0){
      state.queueIndex = -1;
      stopPlayback();
    } else {
      if(state.queueIndex >= state.queue.length) state.queueIndex = state.queue.length - 1;
      if(state.queueIndex < 0) state.queueIndex = 0;
      playCurrent();
    }
  } else if(playingId){
    state.queueIndex = state.queue.indexOf(playingId);
  } else if(state.queueIndex >= state.queue.length){
    state.queueIndex = state.queue.length ? state.queue.length - 1 : -1;
  }
  if(t.art && t.art.startsWith("blob:")) URL.revokeObjectURL(t.art);
  saveLibraryMeta();
  toast(`Removed “${t.title}”.`);
  render();
}

function removeFromPlaylist(playlistId, t){
  const pl = state.playlists.find(p=>p.id===playlistId);
  if(!pl) return;
  pl.trackIds = pl.trackIds.filter(id=>id!==t.id);
  saveLibraryMeta();
  toast(`Removed “${t.title}” from “${pl.name}”.`);
  render();
}

function addToQueue(t){
  state.queue.push(t.id);
  if(state.queueIndex < 0) state.queueIndex = 0;
  toast(`Added “${t.title}” to the queue.`);
  renderQueuePanel();
}

/* ---------- playlists view ---------- */
/* ---------- account view ---------- */
let accountInfo = null;
async function fetchAccountInfo(){
  try{
    const res = await fetch("/api/me");
    if(res.ok) accountInfo = await res.json();
  }catch(_){}
  return accountInfo;
}

function fmtDate(unixSeconds){
  if(!unixSeconds) return "—";
  try{ return new Date(unixSeconds*1000).toLocaleDateString(undefined,{year:"numeric",month:"long",day:"numeric"}); }
  catch(_){ return "—"; }
}

async function renderAccountView(){
  const content = $("#content");
  if(!accountInfo){
    content.innerHTML = `<div class="account-view acct-loading">Loading account…</div>`;
    await fetchAccountInfo();
    if(state.view !== "account") return; // user navigated away while this was in flight
  }
  const info = accountInfo;
  const liked = state.tracks.filter(t=>t.favorite);
  const playlists = state.playlists;
  const artists = getArtists();

  content.innerHTML = `
    <div class="account-view">
      <section class="acct-card">
        <div class="acct-avatar">${escapeHtml((info?.username||"?").slice(0,1).toUpperCase())}</div>
        <div>
          <div class="acct-name">${escapeHtml(info?.username || "Unknown")}</div>
          <div class="acct-sub">${escapeHtml(info?.email || "No email on file")} · Member since ${fmtDate(info?.created_at)}</div>
        </div>
      </section>

      <div class="acct-grid">
        <section class="acct-panel" data-nav="library">
          <div class="acct-panel-head">
            <span>Music files</span><span class="acct-count">${state.tracks.length}</span>
          </div>
          <div class="acct-panel-sub">tracks in your library</div>
        </section>
        <section class="acct-panel" data-nav="favorites">
          <div class="acct-panel-head">
            <span>Liked songs</span><span class="acct-count">${liked.length}</span>
          </div>
          <div class="acct-panel-sub">${liked.slice(0,3).map(t=>escapeHtml(t.title)).join(", ") || "None yet"}</div>
        </section>
        <section class="acct-panel" data-nav="artists">
          <div class="acct-panel-head">
            <span>Artists</span><span class="acct-count">${artists.length}</span>
          </div>
          <div class="acct-panel-sub">${artists.slice(0,3).map(a=>escapeHtml(a.name)).join(", ") || "None yet"}</div>
        </section>
        <section class="acct-panel" data-nav="playlists">
          <div class="acct-panel-head">
            <span>Playlists</span><span class="acct-count">${playlists.length}</span>
          </div>
          <div class="acct-panel-sub">${playlists.slice(0,3).map(p=>escapeHtml(p.name)).join(", ") || "None yet"}</div>
        </section>
      </div>

      <section class="acct-settings">
        <div class="acct-settings-title">Change password</div>
        <form id="pwForm" class="acct-form">
          <input type="password" id="pwCurrent" placeholder="Current password" autocomplete="current-password" required>
          <input type="password" id="pwNew" placeholder="New password (min 8 characters)" autocomplete="new-password" required minlength="8">
          <button type="submit" class="btn btn-primary">Update password</button>
          <div class="acct-form-msg" id="pwMsg"></div>
        </form>
      </section>

      <section class="acct-settings">
        <div class="acct-settings-title">Session</div>
        <form method="post" action="/logout">
          <input type="hidden" name="csrf_token" value="${csrfToken || ""}">
          <button type="submit" class="btn">Log out</button>
        </form>
      </section>
    </div>`;

  $$(".acct-panel[data-nav]").forEach(panel=>{
    panel.addEventListener("click", ()=>{ state.view = panel.dataset.nav; render(); });
  });

  const pwForm = $("#pwForm");
  pwForm.addEventListener("submit", async (e)=>{
    e.preventDefault();
    const msg = $("#pwMsg");
    const current_password = $("#pwCurrent").value;
    const new_password = $("#pwNew").value;
    msg.textContent = "Updating…"; msg.className = "acct-form-msg";
    try{
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": await ensureCsrfToken() },
        body: JSON.stringify({ current_password, new_password }),
      });
      const data = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(data.detail || "Could not update password");
      msg.textContent = "Password updated."; msg.className = "acct-form-msg ok";
      pwForm.reset();
    }catch(err){
      msg.textContent = err.message; msg.className = "acct-form-msg error";
    }
  });
}

function renderPlaylistsView(){
  const content = $("#content");
  const cards = state.playlists.map(p => `
    <div class="pl-card" data-id="${p.id}">
      <div class="pl-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h13M4 12h13M4 18h9"/><circle cx="20" cy="16" r="2.4"/><path d="M20 6v10"/></svg></div>
      <div class="pl-name">${escapeHtml(p.name)}</div>
      <div class="pl-count">${p.trackIds.length} track${p.trackIds.length!==1?"s":""}</div>
    </div>`).join("");
  content.innerHTML = `
    <div class="pl-grid">
      ${cards}
      <div class="pl-card pl-new" id="plNewCard">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="22" height="22"><path d="M12 5v14M5 12h14"/></svg>
        New playlist
      </div>
    </div>`;
  $$(".pl-card[data-id]").forEach(card=>{
    card.addEventListener("click", ()=>{ state.view = "playlist:"+card.dataset.id; render(); });
  });
  $("#plNewCard").addEventListener("click", ()=>{
    const name = prompt("Name your playlist");
    if(name && name.trim()){
      state.playlists.push({id:uid(), name:name.trim(), trackIds:[]});
      saveLibraryMeta(); render();
    }
  });
}

function renderArtistsView(){
  const content = $("#content");
  if(state.tracks.length === 0){
    content.innerHTML = emptyStateMarkup();
    $("#emptyAddFiles")?.addEventListener("click", ()=> $("#fileInput").click());
    $("#emptyAddFolder")?.addEventListener("click", connectMusicFolder);
    return;
  }
  let artists = getArtists();
  if(state.search.trim()){
    const q = state.search.toLowerCase();
    artists = artists.filter(a => a.name.toLowerCase().includes(q));
  }
  if(artists.length === 0){
    content.innerHTML = `<div class="empty"><div class="empty-orb"></div><h3>No matches</h3><p>Try a different search term, or browse your full library.</p></div>`;
    return;
  }
  content.innerHTML = `
    <div class="artist-grid">
      ${artists.map(a => `
        <button type="button" class="artist-card" data-artist="${encodeURIComponent(a.name)}">
          <img class="artist-card-photo" data-artist-photo="${escapeHtml(a.name)}" src="${a.art}" alt="${escapeHtml(a.name)}">
          <div class="artist-card-name">${escapeHtml(a.name)}</div>
          <div class="artist-card-count">${a.tracks.length} song${a.tracks.length!==1?"s":""}</div>
        </button>`).join("")}
    </div>`;
  ArtistPhotoEngine.resolveAll(artists);
  $$(".artist-card").forEach(card=>{
    card.addEventListener("click", ()=> openArtist(decodeURIComponent(card.dataset.artist)));
  });
}

function renderArtistDetailView(){
  const content = $("#content");
  const name = artistNameFromView(state.view);
  const artist = getArtists().find(a => artistKey(a.name) === artistKey(name));
  if(!artist){
    content.innerHTML = `<div class="empty"><div class="empty-orb"></div><h3>Artist not found</h3><p>This artist no longer has songs in your library.</p></div>`;
    return;
  }
  const list = getVisibleTracks();
  const libraryFacts = [
    ["Songs", artist.tracks.length],
    ["Albums", artist.albumCount],
    ["Play time", artist.duration > 0 ? fmtLongDuration(artist.duration) : null],
  ].filter(([, value]) => value !== null && value !== undefined);
  const tracksHtml = list.length === 0
    ? `<div class="empty"><div class="empty-orb"></div><h3>No matches</h3><p>Try a different search term.</p></div>`
    : (state.listMode === "grid"
      ? `<div class="grid">${list.map(t=>cardMarkup(t)).join("")}</div>`
      : `<div class="list">
          <div class="list-head"><div></div><div>Title</div><div>Artist / Album</div><div>Album</div><div>Time</div><div></div></div>
          ${list.map((t,i)=>trackRowMarkup(t,i)).join("")}
        </div>`);
  content.innerHTML = `
    <div class="artist-page">
      <header class="artist-hero">
        <img class="artist-photo" data-artist-photo="${escapeHtml(artist.name)}" src="${artist.art}" alt="${escapeHtml(artist.name)}">
        <div class="artist-hero-meta">
          <div class="artist-kicker">Artist</div>
          <h1 class="artist-name">${escapeHtml(artist.name)}</h1>
          <div class="artist-sub">${artist.tracks.length} song${artist.tracks.length!==1?"s":""} in your library${artist.albumCount ? ` · ${artist.albumCount} album${artist.albumCount!==1?"s":""}` : ""}</div>
        </div>
      </header>
      <section class="artist-library-info" aria-label="Library information">
        ${libraryFacts.map(([label, value]) => `<div class="artist-library-stat"><span>${label}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("")}
      </section>
      <section class="artist-info" data-artist-profile="${escapeHtml(artist.name)}" aria-busy="true">
        <h2>About</h2>
        <p class="artist-bio" data-artist-bio>Looking up artist details…</p>
        <div class="artist-tags" data-artist-tags hidden></div>
        <p class="artist-source" data-artist-source hidden></p>
        <a class="artist-website" data-artist-website hidden target="_blank" rel="noopener noreferrer">Source page <span aria-hidden="true">↗</span></a>
      </section>
      ${tracksHtml}
    </div>`;
  ArtistPhotoEngine.resolve(artist.name);
  ArtistProfileEngine.resolve(artist.name);
  if(list.length) wireTrackInteractions(list);
}

/* ---------- queue view (full page) ---------- */
function renderQueueView(){
  const content = $("#content");
  if(state.queue.length===0){
    content.innerHTML = `<div class="empty"><div class="empty-orb"></div><h3>Queue is empty</h3><p>Play a track from your library to start building a queue.</p></div>`;
    return;
  }
  const rows = state.queue.map((id,i)=>{
    const t = state.tracks.find(x=>x.id===id);
    if(!t) return "";
    const playing = i === state.queueIndex;
    return `
    <div class="row" data-id="${t.id}" data-qi="${i}" draggable="true" style="grid-template-columns:36px 1fr 1fr 90px 44px;">
      <div class="row-idx"><span class="num">${i+1}</span></div>
      <div class="row-title-wrap"><img class="row-art" src="${t.art}"><div class="row-title">${escapeHtml(t.title)}</div></div>
      <div class="row-artist">${artistLinksMarkup(t)}</div>
      <div class="row-time">${t.duration?fmtTime(t.duration):"--:--"}</div>
      <div class="row-actions"><button data-act="remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    </div>`;
  }).join("");
  content.innerHTML = `<div class="list">${rows}</div>`;
  let dragSrcIndex = null;
  $$(".row[data-qi]").forEach(row=>{
    row.addEventListener("click",(e)=>{
      if(e.target.closest("button")) return;
      state.queueIndex = +row.dataset.qi; playCurrent();
    });
    row.querySelector('[data-act="remove"]').addEventListener("click",(e)=>{
      e.stopPropagation();
      removeQueueSlot(+row.dataset.qi);
      render();
    });
    // drag-to-reorder: the row was already marked draggable="true" with a
    // drag-handle-style layout, but nothing ever listened for the drag
    // events, so dragging a queue row did nothing (and could even trip the
    // window-level "drop files to import" overlay). Wired up for real here.
    row.addEventListener("dragstart", e=>{
      dragSrcIndex = +row.dataset.qi;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(dragSrcIndex));
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", ()=> row.classList.remove("dragging"));
    row.addEventListener("dragover", e=>{
      if(dragSrcIndex===null) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", ()=> row.classList.remove("drag-over"));
    row.addEventListener("drop", e=>{
      if(dragSrcIndex===null) return;
      e.preventDefault(); row.classList.remove("drag-over");
      const toIndex = +row.dataset.qi;
      if(dragSrcIndex !== toIndex) reorderQueue(dragSrcIndex, toIndex);
      dragSrcIndex = null;
      renderQueueView(); renderQueuePanel();
    });
  });
  wireArtistLinks(content);
}

/* ---------- queue side panel ---------- */
function renderQueuePanel(){
  const el = $("#queueList");
  if(state.queue.length===0){ el.innerHTML = `<div style="padding:30px 14px;color:var(--text-dim);font-size:12.5px;text-align:center;">Nothing queued yet.</div>`; return; }
  el.innerHTML = state.queue.map((id,i)=>{
    const t = state.tracks.find(x=>x.id===id); if(!t) return "";
    return `
    <div class="q-row ${i===state.queueIndex?'playing':''}" data-i="${i}" draggable="true">
      <span class="q-drag"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.4"/><circle cx="8" cy="12" r="1.4"/><circle cx="8" cy="18" r="1.4"/><circle cx="16" cy="6" r="1.4"/><circle cx="16" cy="12" r="1.4"/><circle cx="16" cy="18" r="1.4"/></svg></span>
      <img src="${t.art}">
      <div class="q-meta"><div class="q-title">${escapeHtml(t.title)}</div><div class="q-artist">${escapeHtml(t.artist)}</div></div>
      <button class="q-remove" data-act="rm"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>`;
  }).join("");
  let dragSrcIndex = null;
  el.querySelectorAll(".q-row").forEach(row=>{
    row.addEventListener("click",(e)=>{ if(e.target.closest("button")) return; state.queueIndex = +row.dataset.i; playCurrent(); });
    row.querySelector('[data-act="rm"]').addEventListener("click",(e)=>{
      e.stopPropagation();
      removeQueueSlot(+row.dataset.i);
      renderQueuePanel();
      if(state.view==="queue") renderQueueView();
    });
    row.addEventListener("dragstart", e=>{
      dragSrcIndex = +row.dataset.i;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(dragSrcIndex));
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", ()=> row.classList.remove("dragging"));
    row.addEventListener("dragover", e=>{
      if(dragSrcIndex===null) return;
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", ()=> row.classList.remove("drag-over"));
    row.addEventListener("drop", e=>{
      if(dragSrcIndex===null) return;
      e.preventDefault(); row.classList.remove("drag-over");
      const toIndex = +row.dataset.i;
      if(dragSrcIndex !== toIndex) reorderQueue(dragSrcIndex, toIndex);
      dragSrcIndex = null;
      renderQueuePanel();
      if(state.view==="queue") renderQueueView();
    });
  });
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
function on(sel, event, handler){
  const el = typeof sel === "string" ? $(sel) : sel;
  if(!el){ console.warn("Auralis: missing element", sel); return; }
  el.addEventListener(event, handler);
}
on("#btnImportTop", "click", ()=> $("#fileInput")?.click());
on("#btnImportRail", "click", ()=> $("#fileInput")?.click());
on("#fileInput", "change", (e)=>{ importFiles(e.target.files); e.target.value = ""; });
on("#folderInput", "change", (e)=>{ importFiles(e.target.files); e.target.value = ""; });

$$(".rail-btn[data-view]").forEach(btn=>{
  btn.addEventListener("click", ()=>{ state.view = btn.dataset.view; state.search=""; $("#searchInput").value=""; render(); });
});
$$("#viewToggle button").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    state.listMode = btn.dataset.mode;
    $$("#viewToggle button").forEach(b=>b.classList.toggle("active", b===btn));
    saveSettings(); render();
  });
});
on("#searchInput", "input", (e)=>{
  state.search = e.target.value;
  if(state.view === "artists") renderArtistsView();
  else if(state.view.startsWith("artist:")) renderArtistDetailView();
  else renderTrackListView();
  renderTopbar();
});
on("#nowArtist", "click", (e)=>{
  const btn = e.target.closest('[data-action="artist"]');
  if(btn){
    openArtist(decodeURIComponent(btn.dataset.artist || ""));
    return;
  }
  const t = currentTrack();
  if(!t) return;
  const names = artistsOf(t);
  if(names[0]) openArtist(names[0]);
});

on("#btnPlay", "click", togglePlay);
on("#miniPlay", "click", togglePlay);
on("#btnNext", "click", ()=>playNext(false));
on("#miniNext", "click", ()=>playNext(false));
on("#btnPrev", "click", playPrev);
on("#miniPrev", "click", playPrev);
on("#btnShuffle", "click", ()=>{ state.shuffle=!state.shuffle; $("#btnShuffle").classList.toggle("on",state.shuffle); saveSettings(); toast(state.shuffle?"Shuffle on":"Shuffle off"); });
on("#btnRepeat", "click", ()=>{
  state.repeat = state.repeat==="off" ? "all" : state.repeat==="all" ? "one" : "off";
  $("#btnRepeat").classList.toggle("on", state.repeat!=="off");
  $("#btnRepeat").title = "Repeat: "+state.repeat;
  saveSettings(); toast("Repeat: "+state.repeat);
});
on("#nowFav", "click", ()=>{ const t=currentTrack(); if(t) toggleFavorite(t); });

function seekTo(clientX, seekEl){
  const rect = seekEl.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (clientX-rect.left)/rect.width));
  if(audioEl.duration) audioEl.currentTime = pct*audioEl.duration;
}
[$("#seek"), $("#miniSeek")].forEach(el=>{
  if(el) el.addEventListener("click",(e)=> seekTo(e.clientX, el));
});
on("#volTrack", "click", (e)=>{
  const rect = e.currentTarget.getBoundingClientRect();
  setVolume((e.clientX-rect.left)/rect.width);
});
on("#btnMute", "click", ()=>{ state.muted=!state.muted; audioEl.volume = state.muted?0:state.volume; updateVolUI(); saveSettings(); });

on("#btnLyrics", "click", ()=> $("#lyricsOverlay").classList.contains("open") ? closeLyrics() : openLyrics());
on("#lyricsClose", "click", closeLyrics);
on("#lyricsOverlay", "click", (e)=>{ if(e.target.id==="lyricsOverlay") closeLyrics(); });

on("#btnViz", "click", openViz);
on("#vizClose", "click", closeViz);
on("#vizOverlay", "click",(e)=>{ if(e.target.id==="vizOverlay") closeViz(); });

on("#btnQueueToggle", "click", ()=> $("#sidePanel").classList.toggle("open"));
on("#btnCloseQueue", "click", ()=> $("#sidePanel").classList.remove("open"));

on("#btnMini", "click", ()=> enterMiniMode());
on("#btnMiniExit", "click", ()=> exitMiniMode());
function enterMiniMode(){
  document.body.classList.add("mini-mode");
  const mp = $("#miniPlayer");
  mp.style.right = "24px"; mp.style.bottom = "24px"; mp.style.left="auto"; mp.style.top="auto";
}
function exitMiniMode(){ document.body.classList.remove("mini-mode"); }

// mini player drag
(function(){
  const mp = $("#miniPlayer"), handle = $("#miniDrag");
  if(!mp || !handle) return;
  let dragging=false, offX=0, offY=0;
  handle.addEventListener("pointerdown",(e)=>{
    dragging=true; const r=mp.getBoundingClientRect();
    offX = e.clientX-r.left; offY = e.clientY-r.top;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener("pointermove",(e)=>{
    if(!dragging) return;
    mp.style.left = Math.max(4,Math.min(window.innerWidth-304, e.clientX-offX))+"px";
    mp.style.top = Math.max(4,Math.min(window.innerHeight-320, e.clientY-offY))+"px";
    mp.style.right="auto"; mp.style.bottom="auto";
  });
  handle.addEventListener("pointerup",()=>dragging=false);
})();

on("#btnShortcuts", "click", ()=> $("#shortcutsOverlay").classList.add("open"));
on("#shortcutsOverlay", "click",(e)=>{ if(e.target.id==="shortcutsOverlay") $("#shortcutsOverlay").classList.remove("open"); });

/* keyboard shortcuts */
document.addEventListener("keydown",(e)=>{
  const tag = (e.target.tagName||"").toLowerCase();
  if(tag==="input" || tag==="textarea"){
    if(e.key==="Escape") e.target.blur();
    return;
  }
  if(e.key==="/"){ e.preventDefault(); $("#searchInput")?.focus(); return; }
  if(e.key==="?"){ $("#shortcutsOverlay")?.classList.toggle("open"); return; }
  if(e.key==="Escape"){
    $("#shortcutsOverlay")?.classList.remove("open");
    $("#sidePanel")?.classList.remove("open");
    $("#dropOverlay")?.classList.remove("show");
    dragCounter = 0;
    closeViz();
    closeLyrics();
    closeMenus();
    return;
  }
  switch(e.key){
    case " ": e.preventDefault(); togglePlay(); break;
    case "ArrowRight": if(e.shiftKey) playNext(false); else if(audioEl.duration) audioEl.currentTime = Math.min(audioEl.duration, audioEl.currentTime+5); break;
    case "ArrowLeft": if(e.shiftKey) playPrev(); else audioEl.currentTime = Math.max(0, audioEl.currentTime-5); break;
    case "ArrowUp": e.preventDefault(); setVolume(state.volume+0.05); break;
    case "ArrowDown": e.preventDefault(); setVolume(state.volume-0.05); break;
    case "m": case "M": $("#btnMute")?.click(); break;
    case "f": case "F": { const t=currentTrack(); if(t) toggleFavorite(t); break; }
    case "n": case "N": document.body.classList.contains("mini-mode") ? exitMiniMode() : enterMiniMode(); break;
    case "l": case "L": $("#lyricsOverlay")?.classList.contains("open") ? closeLyrics() : openLyrics(); break;
    case "v": case "V": $("#vizOverlay")?.classList.contains("open") ? closeViz() : openViz(); break;
  }
});

/* drag & drop import anywhere on window */
// Only real OS file drags carry a "Files" type; a drag started on a queue
// row (for reordering) carries "text/plain" instead. Without this check the
// import overlay would pop up — and a failed "No audio files found" toast
// would fire — every time someone dragged a track to reorder the queue.
let dragCounter = 0;
function isFileDrag(e){ return e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes("Files"); }
function hideDropOverlay(){ dragCounter=0; $("#dropOverlay")?.classList.remove("show"); }
window.addEventListener("dragenter", (e)=>{ if(!isFileDrag(e)) return; e.preventDefault(); dragCounter++; $("#dropOverlay")?.classList.add("show"); });
window.addEventListener("dragover", (e)=>{ if(isFileDrag(e)) e.preventDefault(); });
window.addEventListener("dragleave", (e)=>{ if(!isFileDrag(e)) return; dragCounter--; if(dragCounter<=0) hideDropOverlay(); });
window.addEventListener("drop", (e)=>{
  if(!isFileDrag(e)) return;
  e.preventDefault(); hideDropOverlay();
  const files = [];
  if(e.dataTransfer.items){
    for(const item of e.dataTransfer.items) if(item.kind==="file") files.push(item.getAsFile());
  } else Array.from(e.dataTransfer.files).forEach(f=>files.push(f));
  importFiles(files);
});
// Clicking the overlay dismisses a stuck drag state that would otherwise
// block every button under it.
on("#dropOverlay", "click", hideDropOverlay);

/* pause visualizer rAF when tab hidden to save CPU */
document.addEventListener("visibilitychange", ()=>{
  if(document.hidden){ if(rafViz){ cancelAnimationFrame(rafViz); rafViz=null; } }
  else { if($("#vizOverlay")?.classList.contains("open") && !rafViz) drawViz(); }
});

/* ============================================================
   INIT
   ============================================================ */
let initializationStarted = false;

async function init(){
  if(initializationStarted) return;
  initializationStarted = true;
  try{
    const label = $("#btnImportTopLabel"); if(label) label.textContent = "Add music";
    $("#btnImportRail")?.setAttribute("data-tip", "Add music");
    await loadPersisted();
    audioEl.volume = state.muted ? 0 : state.volume;
    $$("#viewToggle button").forEach(b=>b.classList.toggle("active", b.dataset.mode===state.listMode));
    state.shuffle && $("#btnShuffle")?.classList.add("on");
    if(state.repeat!=="off") $("#btnRepeat")?.classList.add("on");
    updateVolUI();
    const count = await loadServerLibrary();
    ensureCsrfToken();
    render();
    if(count) toast(`Loaded ${count} saved track${count!==1?"s":""}.`);
    else if(state.tracks.length === 0){
      // Distinguish "empty library" from "API unreachable"
      fetch("/api/health").then(r=>{
        if(!r.ok) toast("Can't reach the Auralis server.");
      }).catch(()=> toast("Can't reach the Auralis server. Is it running?"));
    }
  }catch(e){
    console.error("Auralis init failed", e);
    toast("Something went wrong loading the library.");
    try{ render(); }catch(_){}
  }
}
init();

})();
