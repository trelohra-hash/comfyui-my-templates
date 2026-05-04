/**
 * ComfyUI My Templates Extension  v2.0  (clean rewrite)
 * ─────────────────────────────────────────────────────────
 * Uses ComfyUI's official extension APIs (no DOM injection hacks):
 *   • commands + menuCommands       → "Save to My Template" in File menu
 *   • app.extensionManager.registerSidebarTab → "⭐ My Templates" sidebar icon
 *
 * Features
 *   • Save current workflow as a named template with category + thumbnail
 *   • Image / Video file → auto-extract first frame as thumbnail
 *   • Categorize: Image / Video / Audio / 3D Model / LLM / Utility
 *   • Click card → loads workflow into graph
 *   • Edit / delete templates
 *   • Backend saves workflow JSON to ComfyUI/my_template_projects/
 *   • Ctrl+S hook → optional "Save as template?" prompt
 *   • Persistent across sessions (localStorage)
 */

import { app } from "../../scripts/app.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const STORAGE_KEY = "comfy_my_templates_v3";

const CATS = {
  image:   { label: "Image",    color: "#2dd4bf", bg: "rgba(20,184,166,.18)",  border: "#0f766e" },
  video:   { label: "Video",    color: "#a78bfa", bg: "rgba(168,85,247,.18)",  border: "#7c3aed" },
  audio:   { label: "Audio",    color: "#fb923c", bg: "rgba(251,146,60,.18)",  border: "#c2410c" },
  "3d":    { label: "3D Model", color: "#60a5fa", bg: "rgba(96,165,250,.18)",  border: "#1d4ed8" },
  llm:     { label: "LLM",      color: "#f472b6", bg: "rgba(244,114,182,.18)", border: "#be185d" },
  utility: { label: "Utility",  color: "#facc15", bg: "rgba(250,204,21,.14)",  border: "#a16207" },
};

const GRADIENTS = [
  "linear-gradient(135deg,#0a2818 0%,#1b5e20 40%,#4ade80 100%)",
  "linear-gradient(135deg,#0d0022 0%,#3b1d8a 40%,#a78bfa 100%)",
  "linear-gradient(135deg,#001524 0%,#0c4a6e 40%,#60a5fa 100%)",
  "linear-gradient(135deg,#1a0010 0%,#831843 40%,#f472b6 100%)",
  "linear-gradient(135deg,#1a1000 0%,#92400e 40%,#fbbf24 100%)",
  "linear-gradient(135deg,#0a1a2e 0%,#1e3a5f 40%,#38bdf8 100%)",
];

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  templates:     [],
  tab:           "all",
  search:        "",
  panelRoot:     null,    // DOM element passed by registerSidebarTab.render
  templatesDir:  null,    // backend folder path (fetched from /comfy_my_templates/dir)

  // Modal-only state
  editingId:        null,
  selectedCat:      "image",
  pendingWf:        null,
  pendingThumb:     null,        // base64 data URL (poster)
  pendingType:      "image",     // "image" or "video"
  pendingVideoFile: null,        // File object — only set for video uploads
};

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────
function loadTemplates() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}
function persistTemplates() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.templates));
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend helpers
// ─────────────────────────────────────────────────────────────────────────────
async function backendSave(name, workflow, thumbnail) {
  try {
    const r = await fetch("/comfy_my_templates/save", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ name, workflow, thumbnail }),
    });
    const j = await r.json();
    if (!j.success) return null;
    return { filename: j.filename, thumbFile: j.thumb_filename };
  } catch { return null; }
}

async function backendSaveThumb(filename, thumbnail) {
  if (!filename || !thumbnail) return null;
  try {
    const r = await fetch("/comfy_my_templates/save_thumb", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ filename, thumbnail }),
    });
    const j = await r.json();
    return j.success ? j.filename : null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Client-side video trim — uses MediaRecorder + captureStream() to record the
// first 3 seconds of a video into a small WebM blob. No server-side ffmpeg
// needed; everything runs inside the browser.
// ─────────────────────────────────────────────────────────────────────────────
async function trimVideoToFirst3s(file, { maxSeconds = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const url   = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src         = url;
    video.muted       = true;
    video.playsInline = true;
    // Hide it; we just need the stream
    video.style.cssText = "position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;";
    document.body.appendChild(video);

    const cleanup = () => {
      try { URL.revokeObjectURL(url); } catch {}
      try { video.remove(); } catch {}
    };

    video.addEventListener("loadedmetadata", async () => {
      try {
        // captureStream gets the video frames as a MediaStream
        const stream = video.captureStream
          ? video.captureStream()
          : (video.mozCaptureStream ? video.mozCaptureStream() : null);

        if (!stream) {
          cleanup();
          return reject(new Error("captureStream not supported in this browser"));
        }

        // Strip audio tracks — thumbnails don't need sound, smaller files
        stream.getAudioTracks().forEach(t => {
          try { stream.removeTrack(t); t.stop(); } catch {}
        });

        // Pick the best available WebM codec
        const candidates = [
          "video/webm;codecs=vp9",
          "video/webm;codecs=vp8",
          "video/webm",
        ];
        let mimeType = "";
        for (const t of candidates) {
          if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) {
            mimeType = t; break;
          }
        }
        if (!mimeType) {
          cleanup();
          return reject(new Error("MediaRecorder / WebM not supported"));
        }

        const recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: 1_500_000,   // ~1.5 Mbps → ~570 KB for 3s
        });
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onerror = (e) => {
          cleanup();
          reject(e.error || new Error("MediaRecorder error"));
        };
        recorder.onstop = () => {
          cleanup();
          const blob = new Blob(chunks, { type: "video/webm" });
          resolve(blob);
        };

        // Start recording, then play the video. Stop after maxSeconds.
        recorder.start();
        video.currentTime = 0;
        const duration = Math.min(maxSeconds, video.duration || maxSeconds);

        const playPromise = video.play();
        if (playPromise?.catch) playPromise.catch(() => {});

        setTimeout(() => {
          try { if (recorder.state === "recording") recorder.stop(); } catch {}
          try { video.pause(); } catch {}
        }, duration * 1000);

      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    video.addEventListener("error", () => {
      cleanup();
      reject(new Error("video load failed"));
    });

    video.load();
  });
}

async function backendSaveVideo(filename, videoFile) {
  if (!filename || !videoFile) return null;
  try {
    const fd = new FormData();
    fd.append("filename",  filename);
    fd.append("orig_name", videoFile.name || "");
    fd.append("video",     videoFile);
    const r = await fetch("/comfy_my_templates/save_video", {
      method: "POST",
      body:   fd,
    });
    const j = await r.json();
    return j.success ? j.filename : null;
  } catch { return null; }
}

async function backendDelete(filename) {
  if (!filename) return false;
  try {
    const r = await fetch("/comfy_my_templates/delete", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ filename }),
    });
    const j = await r.json();
    return j.success;
  } catch { return false; }
}

async function backendDir() {
  try {
    const r = await fetch("/comfy_my_templates/dir");
    const j = await r.json();
    return j.success ? j.dir : null;
  } catch { return null; }
}

// Returns the URL to display a template's thumbnail (or null if no thumb).
// Prefers the disk file (via /comfy_my_templates/thumb/...) over legacy base64.
function getThumbURL(t) {
  if (t.thumbFile) {
    const v = t.thumbVersion || 0;
    return `/comfy_my_templates/thumb/${encodeURIComponent(t.thumbFile)}?v=${v}`;
  }
  if (t.thumbnail) return t.thumbnail;   // legacy base64 fallback
  return null;
}

// Returns the URL to play a template's video (or null if not a video thumb).
function getVideoURL(t) {
  if (!t.videoFile) return null;
  const v = t.videoVersion || 0;
  return `/comfy_my_templates/video/${encodeURIComponent(t.videoFile)}?v=${v}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast
// ─────────────────────────────────────────────────────────────────────────────
function toast(msg) {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;bottom:20px;right:20px;z-index:10002;" +
    "background:#1a3a25;border:1px solid #2d6a40;border-radius:7px;" +
    "padding:9px 14px;color:#4ade80;font-size:12px;" +
    "font-family:'Segoe UI',system-ui,sans-serif;" +
    "animation:mt-in .22s ease;pointer-events:none;";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS (injected once at startup)
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
  /* ── Panel layout (renders inside the sidebar tab container) ── */
  #mt-panel {
    display: flex; flex-direction: column;
    width: 100%; height: 100%;
    font-family: 'Segoe UI', system-ui, sans-serif; color: #d4d4d4;
    background: #161616; overflow: hidden;
  }
  #mt-panel * { box-sizing: border-box; }

  .mt-hdr {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px; background: #1a1a1a;
    border-bottom: 1px solid #2a2a2a; flex-shrink: 0;
  }
  .mt-hdr-title { font-size: 14px; font-weight: 600; color: #e0e0e0; }
  .mt-search {
    flex: 1; min-width: 0; background: #111; border: 1px solid #2e2e2e;
    border-radius: 6px; padding: 5px 10px; color: #d4d4d4;
    font-size: 13px; outline: none;
  }
  .mt-search::placeholder { color: #555; }
  .mt-search:focus { border-color: #4a9eff; }

  .mt-body { display: flex; flex: 1; overflow: hidden; min-height: 0; }

  /* ── Sidebar (categories) ── */
  .mt-sb {
    width: 160px; flex-shrink: 0; background: #141414;
    border-right: 1px solid #2a2a2a; overflow-y: auto; padding: 8px 0;
  }
  .mt-sb-hdr {
    padding: 5px 12px; font-size: 10px; font-weight: 600;
    color: #555; text-transform: uppercase; letter-spacing: .08em;
    margin-top: 4px;
  }
  .mt-sb-item {
    display: flex; align-items: center; gap: 7px;
    padding: 7px 12px; font-size: 13px; color: #888;
    cursor: pointer; transition: background .12s;
  }
  .mt-sb-item:hover  { background: #1e1e1e; color: #d4d4d4; }
  .mt-sb-item.active { background: #1a2d45; color: #4a9eff; }
  .mt-sb-cnt {
    margin-left: auto; background: #222; border-radius: 10px;
    padding: 1px 6px; font-size: 10px; color: #555;
  }
  .mt-sb-cnt.g { background: #1a3525; color: #4ade80; }

  /* ── Main area ── */
  .mt-main { flex: 1; overflow-y: auto; padding: 14px; min-width: 0; }
  .mt-main-hdr {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 12px; gap: 10px; flex-wrap: wrap;
  }
  .mt-main-title { font-size: 16px; font-weight: 600; color: #e0e0e0; }
  .mt-save-btn {
    background: #1a3a25; border: 1px solid #2d6a40; border-radius: 6px;
    color: #4ade80; font-size: 12px; padding: 6px 12px; cursor: pointer;
    display: flex; align-items: center; gap: 5px; font-family: inherit;
    flex-shrink: 0; white-space: nowrap;
  }
  .mt-save-btn:hover { background: #1f4a2e; }
  .mt-info {
    background: #111e14; border: 1px solid #1e3a28; border-radius: 6px;
    padding: 8px 12px; font-size: 11px; color: #6ab87a; margin-bottom: 12px;
    line-height: 1.5;
  }
  .mt-info-path { color: #3a6a4a; font-size: 10px; }

  /* ── Grid ── */
  .mt-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 10px;
  }

  /* ── Card ── */
  .mt-card {
    background: #1e1e1e; border: 1px solid #2a2a2a; border-radius: 8px;
    overflow: hidden; cursor: pointer; position: relative;
    transition: border-color .15s, transform .1s;
  }
  .mt-card:hover { border-color: #444; transform: translateY(-1px); }
  .mt-card:hover .mt-card-actions { opacity: 1; }
  .mt-card-actions {
    position: absolute; top: 6px; right: 6px;
    display: flex; gap: 3px; opacity: 0; transition: opacity .15s; z-index: 5;
  }
  .mt-card-btn {
    background: rgba(0,0,0,.85); border: 1px solid #444; border-radius: 4px;
    color: #ccc; font-size: 10px; padding: 3px 7px; cursor: pointer;
    font-family: inherit;
  }
  .mt-card-btn:hover { background: #333; }
  .mt-card-btn.red { color: #f87171; border-color: #7f1d1d; }
  .mt-card-btn.red:hover { background: #1a0000; }
  .mt-thumb { width: 100%; height: 100px; position: relative; }
  .mt-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .mt-thumb-poster {
    position: absolute; inset: 0;
    width: 100%; height: 100%; object-fit: cover; display: block;
    z-index: 1;
  }
  .mt-thumb-video {
    position: absolute; inset: 0;
    width: 100%; height: 100%; object-fit: cover;
    opacity: 0; transition: opacity .25s ease;
    pointer-events: none;
    z-index: 2;
  }
  .mt-card:hover .mt-thumb-video { opacity: 1; }
  .mt-vid-badge {
    position: absolute; bottom: 6px; right: 6px;
    background: rgba(0,0,0,.78); color: #fff;
    font-size: 11px; padding: 2px 6px; border-radius: 4px;
    z-index: 4; pointer-events: none;
    transition: opacity .15s;
  }
  .mt-card:hover .mt-vid-badge { opacity: 0; }
  .mt-badges { position: absolute; top: 6px; left: 6px; display: flex; gap: 3px; flex-wrap: wrap; }
  .mt-badge {
    font-size: 10px; padding: 2px 6px; border-radius: 3px; font-weight: 500;
  }
  .mt-card-body { padding: 8px 10px; }
  .mt-card-name {
    font-size: 12px; font-weight: 500; color: #d4d4d4;
    margin-bottom: 3px; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .mt-card-desc {
    font-size: 11px; color: #555; line-height: 1.4;
    display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow: hidden; height: 28px;
  }
  .mt-card-footer {
    display: flex; align-items: center; gap: 4px;
    padding: 5px 10px; border-top: 1px solid #222;
  }
  .mt-card-type { font-size: 10px; color: #555; }
  .mt-card-date { margin-left: auto; font-size: 10px; color: #444; }

  /* ── Empty state ── */
  .mt-empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 50px 20px; text-align: center; gap: 10px; grid-column: 1 / -1;
  }
  .mt-empty-icon {
    width: 44px; height: 44px; border-radius: 12px; background: #1e2a1e;
    display: flex; align-items: center; justify-content: center; font-size: 20px;
  }
  .mt-empty-title { font-size: 14px; color: #777; }
  .mt-empty-sub   { font-size: 12px; color: #444; max-width: 240px; line-height: 1.5; }

  /* ── Save / Edit modal (floating overlay) ── */
  .mt-modal-bg {
    position: fixed; inset: 0; z-index: 10000;
    background: rgba(0,0,0,.72);
    display: flex; align-items: center; justify-content: center;
  }
  .mt-modal {
    background: #1e1e1e; border: 1px solid #333; border-radius: 10px;
    padding: 20px; width: 380px; max-height: 90vh; overflow-y: auto;
    font-family: 'Segoe UI', system-ui, sans-serif; color: #d4d4d4;
  }
  .mt-modal-title { font-size: 15px; font-weight: 600; color: #e0e0e0; margin-bottom: 16px; }
  .mt-modal label {
    font-size: 10px; color: #555; display: block; margin-bottom: 4px;
    text-transform: uppercase; letter-spacing: .06em;
  }
  .mt-modal input, .mt-modal textarea {
    width: 100%; background: #141414; border: 1px solid #2e2e2e;
    border-radius: 5px; padding: 7px 9px; color: #d4d4d4;
    font-size: 13px; outline: none; margin-bottom: 10px;
    font-family: inherit;
  }
  .mt-modal textarea { height: 56px; resize: none; }
  .mt-modal input:focus, .mt-modal textarea:focus { border-color: #4a9eff; }
  .mt-modal input.err { border-color: #dc2626; }
  .mt-cat-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
    margin-bottom: 14px;
  }
  .mt-cat-btn {
    background: #141414; border: 1px solid #2e2e2e; border-radius: 6px;
    padding: 7px 4px; color: #666; font-size: 11px;
    cursor: pointer; text-align: center;
    font-family: inherit; transition: all .12s;
  }
  .mt-cat-btn:hover { border-color: #444; color: #ccc; }

  /* Image / Video toggle */
  .mt-thumb-type {
    display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
    margin-bottom: 8px;
  }
  .mt-type-btn {
    background: #141414; border: 1px solid #2e2e2e; border-radius: 6px;
    padding: 8px 4px; color: #888; font-size: 12px;
    cursor: pointer; text-align: center;
    font-family: inherit; transition: all .12s;
  }
  .mt-type-btn:hover { border-color: #444; color: #ccc; }
  .mt-type-btn.active {
    border-color: #2d6a40; background: rgba(45,106,64,.18); color: #4ade80;
  }

  /* Warning text under type toggle */
  .mt-thumb-warn {
    background: rgba(74,158,255,.06);
    border: 1px solid rgba(74,158,255,.3);
    border-radius: 6px;
    padding: 7px 10px;
    font-size: 11px; color: #7fb8e8; line-height: 1.45;
    margin-bottom: 10px;
  }
  .mt-thumb-warn code {
    background: rgba(0,0,0,.3); padding: 1px 5px; border-radius: 3px;
    color: #a8cdf0; font-size: 10px;
  }

  /* Video info tag (shown in modal preview after video upload) */
  .mt-vid-tag {
    position: absolute; bottom: 6px; left: 6px;
    background: rgba(0,0,0,.82); color: #4ade80;
    font-size: 10px; padding: 3px 7px; border-radius: 4px;
    max-width: calc(100% - 80px);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    z-index: 2;
  }
  .mt-thumb-zone {
    border: 1.5px dashed #333; border-radius: 7px; padding: 10px;
    margin-bottom: 12px; cursor: pointer; transition: border-color .15s;
    background: #111; text-align: center;
    display: flex; flex-direction: column; align-items: center; gap: 5px;
    min-height: 56px; justify-content: center; position: relative;
  }
  .mt-thumb-zone:hover { border-color: #4a9eff; }
  .mt-thumb-zone.has-thumb { border-color: #2d6a40; padding: 0; overflow: hidden; height: 100px; }
  .mt-thumb-zone.has-thumb img {
    width: 100%; height: 100%; object-fit: cover; display: block; border-radius: 5px;
  }
  .mt-tz-lbl { font-size: 11px; color: #555; }
  .mt-tz-hint { font-size: 10px; color: #3a3a3a; }
  .mt-thumb-clear {
    position: absolute; top: 5px; right: 5px;
    background: rgba(0,0,0,.8); border: 1px solid #555; border-radius: 4px;
    color: #ccc; font-size: 10px; padding: 2px 6px; cursor: pointer; z-index: 2;
  }
  .mt-modal-footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
  .mt-btn-cancel {
    background: transparent; border: 1px solid #333; border-radius: 5px;
    padding: 6px 12px; color: #777; font-size: 12px; cursor: pointer; font-family: inherit;
  }
  .mt-btn-cancel:hover { background: #222; }
  .mt-btn-ok {
    background: #1a3a25; border: 1px solid #2d6a40; border-radius: 5px;
    padding: 6px 12px; color: #4ade80; font-size: 12px; cursor: pointer; font-family: inherit;
  }
  .mt-btn-ok:hover { background: #1f4a2e; }

  /* ── Save prompt (Ctrl+S) ── */
  #mt-save-prompt {
    position: fixed; bottom: 20px; right: 20px; z-index: 10001;
    background: #1a1a1a; border: 1px solid #2e2e2e; border-radius: 9px;
    padding: 12px 14px; font-family: 'Segoe UI', system-ui, sans-serif;
    color: #d4d4d4; font-size: 12px;
    display: flex; flex-direction: column; gap: 8px;
    min-width: 250px; box-shadow: 0 8px 32px rgba(0,0,0,.6);
    animation: mt-in .22s ease;
  }

  @keyframes mt-in { from { transform: translateY(8px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

  /* ── Floating draggable window ── */
  #mt-floating {
    position: fixed;
    background: #161616;
    border: 1px solid #2e2e2e;
    border-radius: 10px;
    display: none; flex-direction: column;
    font-family: 'Segoe UI', system-ui, sans-serif; color: #d4d4d4;
    box-shadow: 0 16px 48px rgba(0,0,0,.8);
    overflow: hidden; z-index: 9000;
    animation: mt-in .18s ease;
  }
  #mt-floating.open { display: flex; }

  /* Override panel layout for floating mode */
  #mt-floating .mt-hdr { cursor: grab; user-select: none; }
  #mt-floating .mt-hdr.dragging { cursor: grabbing; }
  #mt-floating .mt-grip {
    display: flex; gap: 3px; align-items: center;
    opacity: .25; flex-shrink: 0;
  }
  #mt-floating .mt-grip span {
    display: block; width: 3px; height: 14px;
    background: #aaa; border-radius: 2px;
  }
  #mt-floating .mt-fclose {
    background: none; border: none; color: #555; font-size: 17px;
    cursor: pointer; padding: 2px 6px; border-radius: 4px; line-height: 1;
    flex-shrink: 0;
  }
  #mt-floating .mt-fclose:hover { color: #d4d4d4; background: #2a2a2a; }

  /* 8-direction resize handles */
  .mt-rs { position: absolute; z-index: 10; }
  .mt-rs-n  { top:0;    left:8px;   right:8px;  height:5px; cursor:n-resize;  }
  .mt-rs-s  { bottom:0; left:8px;   right:8px;  height:5px; cursor:s-resize;  }
  .mt-rs-e  { right:0;  top:8px;    bottom:8px; width:5px;  cursor:e-resize;  }
  .mt-rs-w  { left:0;   top:8px;    bottom:8px; width:5px;  cursor:w-resize;  }
  .mt-rs-ne { top:0;    right:0;    width:14px; height:14px;cursor:ne-resize; }
  .mt-rs-nw { top:0;    left:0;     width:14px; height:14px;cursor:nw-resize; }
  .mt-rs-se { bottom:0; right:0;    width:14px; height:14px;cursor:se-resize; }
  .mt-rs-sw { bottom:0; left:0;     width:14px; height:14px;cursor:sw-resize; }
  .mt-rs-se::after {
    content:''; position:absolute; right:3px; bottom:3px;
    width:9px; height:9px;
    border-right:2px solid #444; border-bottom:2px solid #444;
    border-radius:0 0 3px 0;
  }

  /* No-select while dragging */
  body.mt-dragging * { user-select: none !important; cursor: inherit !important; }

  /* ── Topbar button (injected next to "Manager" in the top-right toolbar) ── */
  /* Visual styling matches typical ComfyUI toolbar buttons (Manager, etc.):
     sharp corners, semi-bold text, white label. Hardcoded — no dependency
     on any other extension being installed. The button uses align-self:stretch
     so its vertical bounds always match the toolbar's flex container exactly. */
  #mt-topbar-btn {
    background: #1a3a25 !important;
    border: 1px solid #2d6a40 !important;
    border-radius: 0 !important;            /* sharp corners */
    color: #ffffff !important;              /* white label */
    font-size: 13px !important;
    font-weight: 500 !important;
    padding: 0 14px !important;
    cursor: pointer !important;
    font-family: 'Segoe UI', system-ui, sans-serif !important;
    margin: 0 4px !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    align-self: stretch !important;         /* match sibling height in flex */
    gap: 6px !important;
    height: auto !important;
    min-height: 32px !important;            /* fallback if not in a flex parent */
    line-height: 1 !important;
    white-space: nowrap !important;
    box-sizing: border-box !important;
    transition: background .12s !important;
  }
  #mt-topbar-btn:hover { background: #1f4a2e !important; }
  #mt-topbar-btn.active {
    background: #2d6a40 !important;
    color: #ffffff !important;
  }
`;

function injectGlobalCSS() {
  if (document.getElementById("mt-css-v3")) return;
  const s = document.createElement("style");
  s.id = "mt-css-v3";
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Render: full panel layout into a container element
// ─────────────────────────────────────────────────────────────────────────────
function renderPanel(container) {
  container.innerHTML = `
    <div id="mt-panel">
      <div class="mt-hdr">
        <span style="font-size:15px;flex-shrink:0;">⭐</span>
        <span class="mt-hdr-title">My Templates</span>
        <input type="text" class="mt-search" id="mt-search-inp" placeholder="Search...">
      </div>
      <div class="mt-body">
        <div class="mt-sb"  id="mt-sb"></div>
        <div class="mt-main" id="mt-main"></div>
      </div>
    </div>
  `;
  container.querySelector("#mt-search-inp").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderMain();
  });
  renderSidebar();
  renderMain();
}

function renderSidebar() {
  if (!state.panelRoot) return;
  const counts = {};
  Object.keys(CATS).forEach(k => { counts[k] = state.templates.filter(t => t.cat === k).length; });
  const items = [
    { id: "all", label: "All My Templates", count: state.templates.length, green: true },
    ...Object.entries(CATS).map(([k, c]) => ({ id: k, label: c.label, count: counts[k] })),
  ];

  const sb = state.panelRoot.querySelector("#mt-sb");
  if (!sb) return;
  sb.innerHTML = `
    <div class="mt-sb-hdr">My Templates</div>
    ${items.map(i => `
      <div class="mt-sb-item ${state.tab === i.id ? "active" : ""}" data-tab="${i.id}">
        ${i.label}
        ${i.count > 0 ? `<span class="mt-sb-cnt ${i.id === "all" ? "g" : ""}">${i.count}</span>` : ""}
      </div>
    `).join("")}
  `;
  sb.querySelectorAll(".mt-sb-item").forEach(el => {
    el.addEventListener("click", () => {
      state.tab = el.dataset.tab;
      renderSidebar();
      renderMain();
    });
  });
}

function getFilteredList() {
  let list = state.tab === "all"
    ? [...state.templates]
    : state.templates.filter(t => t.cat === state.tab);
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter(t => t.name.toLowerCase().includes(q) || (t.desc || "").toLowerCase().includes(q));
  }
  return list;
}

function renderMain() {
  if (!state.panelRoot) return;
  const main = state.panelRoot.querySelector("#mt-main");
  if (!main) return;

  const list  = getFilteredList();
  const title = state.tab === "all" ? "All My Templates" : (CATS[state.tab]?.label || state.tab);

  main.innerHTML = `
    <div class="mt-main-hdr">
      <span class="mt-main-title">${title}</span>
      <button class="mt-save-btn" id="mt-save-now">💾 Save Current Project</button>
    </div>
    ${state.templates.length > 0 ? `
      <div class="mt-info">
        ✦ Hover → <strong>✏️</strong> to edit category &nbsp;|&nbsp; Click → loads workflow
        ${state.templatesDir ? `<br><span class="mt-info-path">📁 ${state.templatesDir}</span>` : ""}
      </div>
    ` : ""}
    <div class="mt-grid" id="mt-grid"></div>
  `;

  main.querySelector("#mt-save-now").addEventListener("click", () => {
    openSaveModal(captureWorkflow(), null);
  });

  const grid = main.querySelector("#mt-grid");
  if (list.length === 0) {
    grid.innerHTML = `
      <div class="mt-empty">
        <div class="mt-empty-icon">⭐</div>
        <div class="mt-empty-title">${
          state.tab === "all"
            ? "No templates saved yet"
            : `No templates in category "${title}"`
        }</div>
        <div class="mt-empty-sub">${
          state.tab === "all"
            ? 'Click "Save Current Project" or use File → Save to My Template.'
            : "Save a template and assign it to this category."
        }</div>
      </div>`;
    return;
  }

  grid.innerHTML = list.map((t, i) => {
    const cat   = t.cat ? CATS[t.cat] : null;
    const thumb = t.gradient || GRADIENTS[i % GRADIENTS.length];
    const thumbURL = getThumbURL(t);
    const videoURL = getVideoURL(t);
    const thumbStyle = thumbURL ? "background:#000;" : `background:${thumb};`;
    let thumbContent = "";
    if (thumbURL) {
      thumbContent += `<img src="${thumbURL}" class="mt-thumb-poster">`;
      if (videoURL) {
        thumbContent += `<video class="mt-thumb-video" src="${videoURL}" muted loop preload="metadata" playsinline></video>`;
      }
    }
    return `
      <div class="mt-card" data-id="${t.id}" title="Click to load">
        <div class="mt-card-actions">
          <button class="mt-card-btn"     data-action="edit" data-id="${t.id}">✏️</button>
          <button class="mt-card-btn red" data-action="del"  data-id="${t.id}">✕</button>
        </div>
        <div class="mt-thumb" style="${thumbStyle}">
          ${thumbContent}
          <div class="mt-badges">
            <span class="mt-badge" style="background:rgba(74,222,128,.82);color:#052e16;">My</span>
            ${cat ? `<span class="mt-badge" style="background:${cat.bg};color:${cat.color};border:1px solid ${cat.border}44;">${cat.label}</span>` : ""}
          </div>
          ${videoURL ? `<span class="mt-vid-badge">🎬</span>` : ""}
        </div>
        <div class="mt-card-body">
          <div class="mt-card-name" title="${t.name}">${t.name}</div>
          <div class="mt-card-desc">${t.desc || "Custom workflow."}</div>
        </div>
        <div class="mt-card-footer">
          <span class="mt-card-type">Node graph</span>
          ${t.file ? `<span class="mt-card-date" title="${t.file}" style="color:#3a6a4a;">📄 ${t.file}</span>` : (t.savedAt ? `<span class="mt-card-date">${t.savedAt}</span>` : "")}
        </div>
      </div>
    `;
  }).join("");

  grid.querySelectorAll(".mt-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-action]")) return;
      const t = state.templates.find(x => x.id === card.dataset.id);
      if (t) loadWorkflow(t);
    });
    // Video hover-play with 3-second loop
    const video = card.querySelector(".mt-thumb-video");
    if (video) {
      const cap3s = () => { if (video.currentTime >= 3) video.currentTime = 0; };
      card.addEventListener("mouseenter", () => {
        video.currentTime = 0;
        video.addEventListener("timeupdate", cap3s);
        const p = video.play();
        if (p?.catch) p.catch(() => {});
      });
      card.addEventListener("mouseleave", () => {
        video.pause();
        video.currentTime = 0;
        video.removeEventListener("timeupdate", cap3s);
      });
    }
  });
  grid.querySelectorAll("[data-action='edit']").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const t = state.templates.find(x => x.id === btn.dataset.id);
      if (t) openSaveModal(null, t);
    });
  });
  grid.querySelectorAll("[data-action='del']").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteTemplate(btn.dataset.id);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow operations
// ─────────────────────────────────────────────────────────────────────────────
function captureWorkflow() {
  try { return app.graph?.serialize() ?? null; } catch { return null; }
}

function loadWorkflow(t) {
  if (!t.workflow) { toast("This template has no saved workflow."); return; }
  try {
    app.loadGraphData(t.workflow);
    toast(`"${t.name}" loaded ✓`);
  } catch (e) {
    console.error(e);
    toast("Error loading workflow.");
  }
}

async function deleteTemplate(id) {
  const t = state.templates.find(x => x.id === id);
  if (t?.file) await backendDelete(t.file);
  state.templates = state.templates.filter(x => x.id !== id);
  persistTemplates();
  renderSidebar();
  renderMain();
}

// ─────────────────────────────────────────────────────────────────────────────
// Save / Edit modal
// ─────────────────────────────────────────────────────────────────────────────
function openSaveModal(workflow, editTarget = null) {
  state.editingId        = editTarget?.id   || null;
  state.selectedCat      = editTarget?.cat  || "image";
  state.pendingWf        = workflow;
  state.pendingThumb     = editTarget ? getThumbURL(editTarget) : null;
  state.pendingType      = editTarget?.videoFile ? "video" : "image";
  state.pendingVideoFile = null;

  const isVideo = state.pendingType === "video";

  const bg = document.createElement("div");
  bg.className = "mt-modal-bg";
  bg.innerHTML = `
    <div class="mt-modal">
      <div class="mt-modal-title">${editTarget ? "✏️ Edit Template" : "💾 Save as My Template"}</div>
      <label>Workflow Name</label>
      <input type="text" id="mt-m-name" value="${editTarget?.name || ""}" placeholder="e.g. My Portrait LoRA">
      <label>Description</label>
      <textarea id="mt-m-desc" placeholder="What does this workflow do...">${editTarget?.desc || ""}</textarea>
      <label>Category</label>
      <div class="mt-cat-grid" id="mt-m-cats"></div>
      <label>Thumbnail Type</label>
      <div class="mt-thumb-type" id="mt-m-type">
        <button class="mt-type-btn ${!isVideo ? "active" : ""}" data-type="image" type="button">📷 Image</button>
        <button class="mt-type-btn ${ isVideo ? "active" : ""}" data-type="video" type="button">🎬 Video</button>
      </div>
      <div class="mt-thumb-warn" id="mt-thumb-warn" style="display:${isVideo ? "block" : "none"};">
        ℹ Video is auto-trimmed to the <strong>first 3 seconds</strong> in your browser and saved as a small WebM clip in <code>my_template_projects/</code>. Original file is not uploaded.
      </div>
      <input type="file" id="mt-m-file" accept="${isVideo ? "video/*" : "image/*"}" style="display:none;">
      <div class="mt-thumb-zone ${state.pendingThumb ? "has-thumb" : ""}" id="mt-m-zone">
        ${state.pendingThumb
          ? `<img src="${state.pendingThumb}"><button class="mt-thumb-clear" id="mt-m-clear">✕ Remove</button>`
          : `<div class="mt-tz-lbl">📁 Choose ${isVideo ? "video" : "image"} file</div><div class="mt-tz-hint">${isVideo ? "MP4 · WEBM · MOV" : "JPG · PNG · WEBP"}</div>`}
      </div>
      <div class="mt-modal-footer">
        <button class="mt-btn-cancel" id="mt-m-cancel">Cancel</button>
        <button class="mt-btn-ok"     id="mt-m-ok">${editTarget ? "Save changes" : "Save"}</button>
      </div>
    </div>
  `;
  bg.addEventListener("click", (e) => { if (e.target === bg) bg.remove(); });
  bg.querySelector("#mt-m-cancel").addEventListener("click", () => bg.remove());
  bg.querySelector("#mt-m-ok").addEventListener("click",     () => confirmModal(bg));
  bg.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); bg.remove(); }
    if (e.key === "Enter")  { e.preventDefault(); confirmModal(bg); }
  });

  // Thumbnail type toggle (Image / Video)
  bg.querySelectorAll(".mt-type-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const newType = btn.dataset.type;
      if (state.pendingType === newType) return;
      state.pendingType      = newType;
      state.pendingThumb     = null;
      state.pendingVideoFile = null;

      bg.querySelectorAll(".mt-type-btn").forEach(b => b.classList.toggle("active", b.dataset.type === newType));
      bg.querySelector("#mt-thumb-warn").style.display = newType === "video" ? "block" : "none";
      bg.querySelector("#mt-m-file").accept = newType === "video" ? "video/*" : "image/*";

      const z = bg.querySelector("#mt-m-zone");
      z.className = "mt-thumb-zone";
      z.innerHTML = `<div class="mt-tz-lbl">📁 Choose ${newType === "video" ? "video" : "image"} file</div><div class="mt-tz-hint">${newType === "video" ? "MP4 · WEBM · MOV" : "JPG · PNG · WEBP"}</div>`;
    });
  });

  // Thumbnail interactions
  const zone = bg.querySelector("#mt-m-zone");
  const file = bg.querySelector("#mt-m-file");
  zone.addEventListener("click", (e) => {
    if (e.target.id === "mt-m-clear") {
      e.stopPropagation();
      state.pendingThumb     = null;
      state.pendingVideoFile = null;
      zone.className = "mt-thumb-zone";
      const isV = state.pendingType === "video";
      zone.innerHTML = `<div class="mt-tz-lbl">📁 Choose ${isV ? "video" : "image"} file</div><div class="mt-tz-hint">${isV ? "MP4 · WEBM · MOV" : "JPG · PNG · WEBP"}</div>`;
      return;
    }
    file.click();
  });
  file.addEventListener("change", () => { if (file.files[0]) processThumb(file.files[0], zone); });
  zone.addEventListener("dragover",  (e) => { e.preventDefault(); zone.style.borderColor = "#4a9eff"; });
  zone.addEventListener("dragleave", ()  => { zone.style.borderColor = ""; });
  zone.addEventListener("drop",      (e) => {
    e.preventDefault(); zone.style.borderColor = "";
    if (e.dataTransfer.files[0]) processThumb(e.dataTransfer.files[0], zone);
  });

  document.body.appendChild(bg);
  renderCatGrid(bg);
  setTimeout(() => bg.querySelector("#mt-m-name").focus(), 50);
}

function renderCatGrid(bg) {
  const grid = bg.querySelector("#mt-m-cats");
  grid.innerHTML = Object.entries(CATS).map(([k, c]) => {
    const sel = state.selectedCat === k;
    return `
      <button class="mt-cat-btn" data-cat="${k}"
        style="${sel ? `border-color:${c.border};color:${c.color};background:${c.bg};` : ""}">
        ${c.label}
      </button>`;
  }).join("");
  grid.querySelectorAll(".mt-cat-btn").forEach(b => {
    b.addEventListener("click", () => {
      state.selectedCat = b.dataset.cat;
      renderCatGrid(bg);
    });
  });
}

function processThumb(file, zone) {
  zone.innerHTML = `<div class="mt-tz-lbl" style="color:#4a9eff;">Processing...</div>`;

  if (file.type.startsWith("image/")) {
    state.pendingType      = "image";
    state.pendingVideoFile = null;
    const reader = new FileReader();
    reader.onload = (e) => {
      state.pendingThumb = e.target.result;
      zone.className = "mt-thumb-zone has-thumb";
      zone.innerHTML = `<img src="${state.pendingThumb}"><button class="mt-thumb-clear" id="mt-m-clear">✕ Remove</button>`;
    };
    reader.readAsDataURL(file);
  } else if (file.type.startsWith("video/")) {
    state.pendingType      = "video";
    state.pendingVideoFile = null;     // will be set after trim
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.src         = url;
    v.muted       = true;
    v.playsInline = true;

    v.addEventListener("loadeddata", () => { v.currentTime = 0; });
    v.addEventListener("seeked", async () => {
      // 1) Capture poster (first frame) from this video element
      const c = document.createElement("canvas");
      c.width  = v.videoWidth  || 320;
      c.height = v.videoHeight || 180;
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      state.pendingThumb = c.toDataURL("image/jpeg", 0.82);
      URL.revokeObjectURL(url);

      // Show poster + "Trimming..." status
      zone.className = "mt-thumb-zone has-thumb";
      zone.innerHTML = `
        <img src="${state.pendingThumb}">
        <span class="mt-vid-tag" id="mt-vid-tag" style="color:#4a9eff;">🎬 Trimming to 3s…</span>
      `;

      // 2) Trim the video to first 3 seconds (browser-side, no server-side ffmpeg)
      try {
        const blob = await trimVideoToFirst3s(file, { maxSeconds: 3 });
        const sizeStr = blob.size > 1024 * 1024
          ? `${(blob.size / (1024*1024)).toFixed(2)} MB`
          : `${(blob.size / 1024).toFixed(0)} KB`;

        // Wrap as File so backend gets a name with .webm extension
        state.pendingVideoFile = new File([blob], "trimmed.webm", { type: "video/webm" });

        const tag = zone.querySelector("#mt-vid-tag");
        if (tag) {
          tag.innerHTML = `🎬 ${sizeStr} · 3s clip ✓`;
          tag.style.color = "#4ade80";
        }
        // Add Remove button now that trim is complete
        if (!zone.querySelector(".mt-thumb-clear")) {
          const btn = document.createElement("button");
          btn.className = "mt-thumb-clear";
          btn.id        = "mt-m-clear";
          btn.textContent = "✕ Remove";
          zone.appendChild(btn);
        }
      } catch (err) {
        console.error("[MyTemplates] video trim failed:", err);
        // Fallback: keep poster, no video clip → user can still save with image-only thumb
        state.pendingVideoFile = null;
        const tag = zone.querySelector("#mt-vid-tag");
        if (tag) {
          tag.innerHTML = "⚠ Trim failed — saved as image only";
          tag.style.color = "#facc15";
        }
        if (!zone.querySelector(".mt-thumb-clear")) {
          const btn = document.createElement("button");
          btn.className = "mt-thumb-clear";
          btn.id        = "mt-m-clear";
          btn.textContent = "✕ Remove";
          zone.appendChild(btn);
        }
      }
    });
    v.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      state.pendingVideoFile = null;
      zone.className = "mt-thumb-zone";
      zone.innerHTML = `<div class="mt-tz-lbl" style="color:#f87171;">Video error</div><div class="mt-tz-hint">MP4 · WEBM · MOV</div>`;
    });
    v.load();
  }
}

async function confirmModal(bg) {
  const nameEl = bg.querySelector("#mt-m-name");
  const name   = nameEl.value.trim();
  if (!name) { nameEl.classList.add("err"); nameEl.focus(); return; }
  const desc = bg.querySelector("#mt-m-desc").value.trim();
  const cat  = state.selectedCat || "image";

  // Show a brief uploading hint for videos (can take a moment for large files)
  const okBtn = bg.querySelector("#mt-m-ok");
  if (state.pendingVideoFile) {
    okBtn.textContent = "Uploading video…";
    okBtn.disabled = true;
  }

  if (state.editingId) {
    // ── Editing an existing template ────────────────────────────────────────
    const t = state.templates.find(x => x.id === state.editingId);
    if (t) {
      t.name = name; t.desc = desc; t.cat = cat;

      if (state.pendingThumb === null) {
        // User removed the thumbnail entirely
        delete t.thumbnail; delete t.thumbFile; delete t.videoFile;
      } else if (state.pendingThumb && state.pendingThumb.startsWith("data:")) {
        // New poster uploaded → save to disk
        if (t.file) {
          const newThumb = await backendSaveThumb(t.file, state.pendingThumb);
          if (newThumb) {
            t.thumbFile    = newThumb;
            t.thumbVersion = (t.thumbVersion || 0) + 1;
            delete t.thumbnail;
          } else {
            t.thumbnail = state.pendingThumb;
          }
        } else {
          t.thumbnail = state.pendingThumb;
        }
        // If a new video file was selected, upload it; otherwise drop video reference
        if (state.pendingVideoFile && t.file) {
          const newVid = await backendSaveVideo(t.file, state.pendingVideoFile);
          if (newVid) {
            t.videoFile    = newVid;
            t.videoVersion = (t.videoVersion || 0) + 1;
          }
        } else if (state.pendingType === "image") {
          delete t.videoFile;   // switched from video → image
        }
      }
    }
    toast("Template updated ✓");
  } else {
    // ── New template ────────────────────────────────────────────────────────
    let saved = null;
    if (state.pendingWf) {
      saved = await backendSave(name, state.pendingWf, state.pendingThumb);
    }

    let videoFilename = null;
    if (saved?.filename && state.pendingVideoFile) {
      videoFilename = await backendSaveVideo(saved.filename, state.pendingVideoFile);
    }

    state.templates.unshift({
      id:           "mt_" + Date.now(),
      name,
      desc:         desc || "Custom workflow.",
      cat,
      gradient:     GRADIENTS[state.templates.length % GRADIENTS.length],
      workflow:     state.pendingWf,
      file:         saved?.filename  || null,
      thumbFile:    saved?.thumbFile || null,
      videoFile:    videoFilename,
      thumbnail:    (!saved?.thumbFile && state.pendingThumb) ? state.pendingThumb : null,
      thumbVersion: 0,
      videoVersion: 0,
      savedAt:      new Date().toLocaleDateString("en-US"),
    });

    let note = saved?.filename ? ` → my_template_projects/${saved.filename}` : "";
    if (videoFilename) note += ` + ${videoFilename}`;
    toast(`"${name}" saved!${note} ✓`);
  }

  persistTemplates();
  bg.remove();
  renderSidebar();
  renderMain();
}

// ─────────────────────────────────────────────────────────────────────────────
// Ctrl+S → "Save as template?" prompt
// ─────────────────────────────────────────────────────────────────────────────
function showSavePrompt(wf) {
  document.getElementById("mt-save-prompt")?.remove();
  const el = document.createElement("div");
  el.id = "mt-save-prompt";
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="font-size:16px;">💾</span>
      <span style="color:#ccc;font-weight:500;">Workflow saved!</span>
      <button id="mt-px" style="margin-left:auto;background:none;border:none;color:#555;cursor:pointer;font-size:14px;">✕</button>
    </div>
    <div style="color:#666;font-size:11px;">Save it as My Template too?</div>
    <div style="display:flex;gap:6px;">
      <button id="mt-py" style="flex:1;background:#1a3a25;border:1px solid #2d6a40;border-radius:5px;color:#4ade80;font-size:11px;padding:5px;cursor:pointer;font-family:inherit;">⭐ Yes, save it</button>
      <button id="mt-pn" style="background:#1e1e1e;border:1px solid #333;border-radius:5px;color:#666;font-size:11px;padding:5px 10px;cursor:pointer;font-family:inherit;">No</button>
    </div>
  `;
  const rm = () => el.remove();
  el.querySelector("#mt-px").addEventListener("click", rm);
  el.querySelector("#mt-pn").addEventListener("click", rm);
  el.querySelector("#mt-py").addEventListener("click", () => { rm(); openSaveModal(wf, null); });
  document.body.appendChild(el);
  setTimeout(rm, 9000);
}

function hookSave() {
  let debounce = 0;
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s" && !e.shiftKey) {
      const now = Date.now();
      if (now - debounce < 500) return;
      debounce = now;
      setTimeout(() => { const wf = captureWorkflow(); if (wf) showSavePrompt(wf); }, 450);
    }
  }, false);
}

// ─────────────────────────────────────────────────────────────────────────────
// Floating window — draggable, resizable, with persistent layout
// ─────────────────────────────────────────────────────────────────────────────
const FLOATING_LAYOUT_KEY = "comfy_mt_floating_layout";
const MIN_W = 520;
const MIN_H = 360;

let floatingEl = null;

function loadFloatingLayout() {
  try { return JSON.parse(localStorage.getItem(FLOATING_LAYOUT_KEY) || "null"); }
  catch { return null; }
}
function saveFloatingLayout() {
  if (!floatingEl) return;
  const r = floatingEl.getBoundingClientRect();
  localStorage.setItem(FLOATING_LAYOUT_KEY, JSON.stringify({
    x: r.left, y: r.top, w: r.width, h: r.height,
  }));
}

function buildFloatingWindow() {
  const win = document.createElement("div");
  win.id = "mt-floating";
  win.innerHTML = `
    <div class="mt-rs mt-rs-n"  data-dir="n"></div>
    <div class="mt-rs mt-rs-s"  data-dir="s"></div>
    <div class="mt-rs mt-rs-e"  data-dir="e"></div>
    <div class="mt-rs mt-rs-w"  data-dir="w"></div>
    <div class="mt-rs mt-rs-ne" data-dir="ne"></div>
    <div class="mt-rs mt-rs-nw" data-dir="nw"></div>
    <div class="mt-rs mt-rs-se" data-dir="se"></div>
    <div class="mt-rs mt-rs-sw" data-dir="sw"></div>
    <div class="mt-hdr" id="mt-fdrag">
      <div class="mt-grip"><span></span><span></span><span></span></div>
      <span style="font-size:15px;flex-shrink:0;">⭐</span>
      <span class="mt-hdr-title">My Templates</span>
      <input type="text" class="mt-search" id="mt-fsearch" placeholder="Search...">
      <button class="mt-fclose" id="mt-fclose" title="Close (Esc)">✕</button>
    </div>
    <div class="mt-body">
      <div class="mt-sb"   id="mt-sb"></div>
      <div class="mt-main" id="mt-main"></div>
    </div>
  `;
  document.body.appendChild(win);

  // Restore layout
  const vw = window.innerWidth, vh = window.innerHeight;
  const saved = loadFloatingLayout();
  const w = Math.max(MIN_W, Math.min(saved?.w ?? 820, vw - 20));
  const h = Math.max(MIN_H, Math.min(saved?.h ?? 600, vh - 20));
  const x = Math.max(0, Math.min(saved?.x ?? (vw - w - 16), vw - w));
  const y = Math.max(0, Math.min(saved?.y ?? 50, vh - h));
  Object.assign(win.style, { left: x+"px", top: y+"px", width: w+"px", height: h+"px" });

  // Wire events
  win.querySelector("#mt-fclose").addEventListener("click", closeFloatingWindow);
  win.querySelector("#mt-fsearch").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderMain();
  });
  makeDraggable(win.querySelector("#mt-fdrag"), win);
  makeResizable(win);

  return win;
}

function makeDraggable(handle, win) {
  handle.addEventListener("mousedown", (e) => {
    if (e.target.closest("input, button")) return;
    e.preventDefault();
    const r = win.getBoundingClientRect();
    const ox = e.clientX, oy = e.clientY, ol = r.left, ot = r.top;
    handle.classList.add("dragging");
    document.body.classList.add("mt-dragging");

    const move = (ev) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const pw = win.offsetWidth, ph = win.offsetHeight;
      const x = Math.max(0, Math.min(ol + ev.clientX - ox, vw - pw));
      const y = Math.max(0, Math.min(ot + ev.clientY - oy, vh - ph));
      win.style.left = x + "px";
      win.style.top  = y + "px";
    };
    const up = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("mt-dragging");
      saveFloatingLayout();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup",   up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup",   up);
  });
}

function makeResizable(win) {
  win.querySelectorAll(".mt-rs").forEach(handle => {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      const dir = handle.dataset.dir;
      const r = win.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      const sl = r.left, st = r.top, sw = r.width, sh = r.height;
      document.body.classList.add("mt-dragging");

      const move = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        const vw = window.innerWidth, vh = window.innerHeight;
        let l = sl, t = st, w = sw, h = sh;
        if (dir.includes("e")) w = Math.max(MIN_W, sw + dx);
        if (dir.includes("s")) h = Math.max(MIN_H, sh + dy);
        if (dir.includes("w")) { const nw = Math.max(MIN_W, sw - dx); l = sl + sw - nw; w = nw; }
        if (dir.includes("n")) { const nh = Math.max(MIN_H, sh - dy); t = st + sh - nh; h = nh; }
        if (l < 0) { w += l; l = 0; }
        if (t < 0) { h += t; t = 0; }
        if (l + w > vw) w = vw - l;
        if (t + h > vh) h = vh - t;
        Object.assign(win.style, { left: l+"px", top: t+"px", width: w+"px", height: h+"px" });
      };
      const up = () => {
        document.body.classList.remove("mt-dragging");
        saveFloatingLayout();
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup",   up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup",   up);
    });
  });
}

function openFloatingWindow() {
  if (!floatingEl) floatingEl = buildFloatingWindow();
  state.panelRoot = floatingEl;
  floatingEl.classList.add("open");
  renderSidebar();
  renderMain();
  // Sync the topbar button state
  const btn = document.getElementById("mt-topbar-btn");
  if (btn) btn.classList.add("active");
}

function closeFloatingWindow() {
  if (floatingEl) {
    saveFloatingLayout();
    floatingEl.classList.remove("open");
  }
  // Sync the topbar button state (in case window was closed via X / Esc)
  const btn = document.getElementById("mt-topbar-btn");
  if (btn) btn.classList.remove("active");
}

function isFloatingOpen() {
  return floatingEl && floatingEl.classList.contains("open");
}

// ─────────────────────────────────────────────────────────────────────────────
// Topbar button — injects a "⭐ My Templates" button into the top-right
// toolbar, right next to the "Manager" button (does NOT modify any existing
// button — only insertBefore on the same parent container).
// ─────────────────────────────────────────────────────────────────────────────
function addTopbarButton() {
  if (document.getElementById("mt-topbar-btn")) return;

  const btn = document.createElement("button");
  btn.id        = "mt-topbar-btn";
  btn.title     = "My Templates (Ctrl+Shift+M)";
  btn.innerHTML = "⭐ My Templates";
  btn.addEventListener("click", () => {
    if (isFloatingOpen()) {
      closeFloatingWindow();
      btn.classList.remove("active");
    } else {
      openFloatingWindow();
      btn.classList.add("active");
    }
  });

  let attempts = 0;
  const MAX_ATTEMPTS = 40;
  let observer = null;
  let timeoutId = null;

  const tryInject = () => {
    attempts++;
    if (btn.parentElement) {
      observer?.disconnect();
      clearTimeout(timeoutId);
      return;
    }
    if (attempts > MAX_ATTEMPTS) {
      observer?.disconnect();
      clearTimeout(timeoutId);
      console.warn("[MyTemplates] Could not anchor topbar button after", MAX_ATTEMPTS, "attempts");
      return;
    }

    // Anchor: the "Manager" button in the top-right toolbar.
    // We insertBefore Manager — Manager itself is NEVER modified.
    // (Note: we only use Manager as a position reference. Visual styling is
    // hardcoded in our own CSS so we don't depend on Manager being installed.)
    for (const el of document.querySelectorAll("button")) {
      const txt = el.textContent?.trim();
      if (!txt || txt !== "Manager") continue;
      const r = el.getBoundingClientRect();
      // Must be in the top area (not somewhere else in the page)
      if (r.top > 100 || r.height === 0 || r.width === 0) continue;

      const container = el.parentElement;
      if (container) {
        container.insertBefore(btn, el);   // ← non-destructive insert
        observer?.disconnect();
        clearTimeout(timeoutId);
        return;
      }
    }
  };

  tryInject();
  if (!btn.parentElement) {
    observer = new MutationObserver(tryInject);
    observer.observe(document.body, { childList: true, subtree: true });
    timeoutId = setTimeout(() => observer?.disconnect(), 20000);
  }
}

// Sync the topbar button's active state when the floating window is closed via X / Esc
function syncTopbarBtnState() {
  const btn = document.getElementById("mt-topbar-btn");
  if (!btn) return;
  btn.classList.toggle("active", isFloatingOpen());
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension registration
// ─────────────────────────────────────────────────────────────────────────────
app.registerExtension({
  name: "MyTemplates.Panel",

  // ── File menu items via official API (no DOM injection, no side panel) ──
  commands: [
    {
      id:       "myTemplates.openWindow",
      label:    "Browse My Templates",
      icon:     "pi pi-star",
      function: () => {
        if (isFloatingOpen()) closeFloatingWindow();
        else                  openFloatingWindow();
      },
    },
    {
      id:       "myTemplates.saveAsTemplate",
      label:    "Save to My Template",
      icon:     "pi pi-save",
      function: () => {
        const wf = captureWorkflow();
        openFloatingWindow();   // ensure window is built so save modal has a host
        openSaveModal(wf, null);
      },
    },
  ],
  menuCommands: [
    {
      path:     ["File"],
      commands: ["myTemplates.openWindow", "myTemplates.saveAsTemplate"],
    },
  ],
  // Keybinding: Ctrl+Shift+M opens / closes the My Templates window
  keybindings: [
    {
      combo:     { key: "m", ctrl: true, shift: true },
      commandId: "myTemplates.openWindow",
    },
  ],

  async setup() {
    injectGlobalCSS();
    state.templates = loadTemplates();
    backendDir().then(d => { state.templatesDir = d; if (isFloatingOpen()) renderMain(); });

    // Inject the topbar button (next to "Graph" dropdown, top-left)
    addTopbarButton();

    // Escape closes the floating window (when no modal is open inside it)
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isFloatingOpen() && !document.querySelector(".mt-modal-bg")) {
        closeFloatingWindow();
      }
    });

    hookSave();
    console.log("[MyTemplates] v2.4 — topbar button (next to Manager) + English UI ✓");
  },
});
