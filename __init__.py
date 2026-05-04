"""
ComfyUI My Templates Extension  v2.0
=====================================
Adds "My Templates" floating window + File menu "Save to My Template" option.

Folder structure:
  ComfyUI/
  └── my_template_projects/      ← workflow + thumbnail files saved here
      ├── My_Portrait_LoRA.json
      ├── My_Portrait_LoRA.jpg   ← thumbnail (auto, optional)
      ├── Video_Upscale_v2.json
      └── Video_Upscale_v2.jpg

API routes:
  POST /comfy_my_templates/save              → saves workflow + thumbnail
  POST /comfy_my_templates/save_thumb        → updates only thumbnail
  POST /comfy_my_templates/delete            → deletes workflow + thumbnail
  GET  /comfy_my_templates/thumb/{filename}  → serves thumbnail JPG/PNG file
  GET  /comfy_my_templates/list              → lists saved files
  GET  /comfy_my_templates/dir               → returns the folder path
"""

import os
import json
import re
import base64

from aiohttp import web

WEB_DIRECTORY = "./js"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# ── Resolve templates folder (ComfyUI root / my_template_projects) ────────────
try:
    import folder_paths
    _BASE = folder_paths.base_path
except Exception:
    _BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

TEMPLATES_DIR = os.path.join(_BASE, "my_template_projects")


def _safe_name(raw):
    """Turn an arbitrary name into a safe filename (no extension)."""
    s = re.sub(r"[^\w\s\-]", "", raw, flags=re.UNICODE).strip()
    s = re.sub(r"\s+", "_", s)
    return s or "workflow"


def _safe_basename(filename):
    """Strip path components + extension, return safe base name."""
    fname = os.path.basename(filename)
    base, _ = os.path.splitext(fname)
    base = re.sub(r"[^\w\-]", "_", base)
    return base


def _unique_path(base_name):
    """Return a filepath that doesn't collide with existing files."""
    os.makedirs(TEMPLATES_DIR, exist_ok=True)
    path = os.path.join(TEMPLATES_DIR, "{}.json".format(base_name))
    counter = 1
    while os.path.exists(path):
        path = os.path.join(TEMPLATES_DIR, "{}_{}.json".format(base_name, counter))
        counter += 1
    return path


def _save_thumb_to_disk(base_name, data_url):
    """
    Write a base64 data URL thumbnail to disk as <base_name>.jpg.
    Returns the filename on success, None otherwise.
    """
    if not data_url:
        return None
    try:
        b64 = data_url.split(",", 1)[1] if "," in data_url else data_url
        thumb_filename = "{}.jpg".format(base_name)
        thumb_path = os.path.join(TEMPLATES_DIR, thumb_filename)
        os.makedirs(TEMPLATES_DIR, exist_ok=True)
        with open(thumb_path, "wb") as f:
            f.write(base64.b64decode(b64))
        return thumb_filename
    except Exception as e:
        print("[MyTemplates] thumb save failed: {}".format(e))
        return None


# ── Register routes ───────────────────────────────────────────────────────────
try:
    from server import PromptServer

    @PromptServer.instance.routes.post("/comfy_my_templates/save")
    async def save_template_project(request):
        """
        Body JSON:
          { "name": "My Workflow", "workflow": { ... },
            "thumbnail": "data:image/jpeg;base64,..." (optional) }

        Returns:
          { "success": true, "filename": "My_Workflow.json",
            "thumb_filename": "My_Workflow.jpg" or null }
        """
        try:
            data       = await request.json()
            raw_name   = data.get("name", "workflow")
            workflow   = data.get("workflow", {})
            thumb_data = data.get("thumbnail")

            safe   = _safe_name(raw_name)
            fpath  = _unique_path(safe)
            fname  = os.path.basename(fpath)
            base   = os.path.splitext(fname)[0]

            with open(fpath, "w", encoding="utf-8") as f:
                json.dump(workflow, f, indent=2, ensure_ascii=False)

            thumb_filename = _save_thumb_to_disk(base, thumb_data) if thumb_data else None

            return web.json_response({
                "success":        True,
                "filename":       fname,
                "thumb_filename": thumb_filename,
                "path":           fpath,
            })

        except Exception as e:
            return web.json_response({"success": False, "error": str(e)}, status=500)


    @PromptServer.instance.routes.post("/comfy_my_templates/save_thumb")
    async def save_thumb_only(request):
        """
        Body JSON:
          { "filename": "My_Workflow.json", "thumbnail": "data:image/..." }
        Saves/replaces only the thumbnail (used during edit).
        """
        try:
            data       = await request.json()
            filename   = data.get("filename", "")
            thumb_data = data.get("thumbnail", "")

            if not filename or not thumb_data:
                return web.json_response(
                    {"success": False, "error": "missing filename or thumbnail"},
                    status=400,
                )

            base = _safe_basename(filename)
            thumb_filename = _save_thumb_to_disk(base, thumb_data)

            if not thumb_filename:
                return web.json_response(
                    {"success": False, "error": "could not write file"},
                    status=500,
                )

            return web.json_response({"success": True, "filename": thumb_filename})

        except Exception as e:
            return web.json_response({"success": False, "error": str(e)}, status=500)


    @PromptServer.instance.routes.post("/comfy_my_templates/save_video")
    async def save_video(request):
        """
        Multipart form upload for video thumbnails.
        Form fields:
          filename   = "My_Workflow.json" (the template's json filename)
          orig_name  = "myvideo.mp4"     (original file name, used for extension)
          video      = <binary file data>
        """
        try:
            reader     = await request.multipart()
            filename   = None
            orig_name  = ""
            video_data = None

            while True:
                part = await reader.next()
                if part is None:
                    break
                if part.name == "filename":
                    filename = (await part.text()).strip()
                elif part.name == "orig_name":
                    orig_name = (await part.text()).strip()
                elif part.name == "video":
                    video_data = await part.read()

            if not filename or not video_data:
                return web.json_response(
                    {"success": False, "error": "missing filename or video data"},
                    status=400,
                )

            base = _safe_basename(filename)

            # Pick extension from original filename (fallback to .mp4)
            ext = os.path.splitext(orig_name)[1].lower() if orig_name else ".mp4"
            if ext not in (".mp4", ".webm", ".mov"):
                ext = ".mp4"

            # Clean up any older video for this template (different ext)
            for old_ext in (".mp4", ".webm", ".mov"):
                old_path = os.path.join(TEMPLATES_DIR, "{}{}".format(base, old_ext))
                if os.path.isfile(old_path):
                    try:
                        os.remove(old_path)
                    except Exception:
                        pass

            video_filename = "{}{}".format(base, ext)
            video_path     = os.path.join(TEMPLATES_DIR, video_filename)
            os.makedirs(TEMPLATES_DIR, exist_ok=True)
            with open(video_path, "wb") as f:
                f.write(video_data)

            return web.json_response({
                "success":  True,
                "filename": video_filename,
                "size":     len(video_data),
            })

        except Exception as e:
            return web.json_response({"success": False, "error": str(e)}, status=500)


    @PromptServer.instance.routes.get("/comfy_my_templates/video/{filename}")
    async def get_video(request):
        """Serves a video file from the my_template_projects folder."""
        raw = request.match_info.get("filename", "")
        fname = os.path.basename(raw)
        if not fname or ".." in fname or "/" in fname or "\\" in fname:
            return web.Response(status=400)
        ext = os.path.splitext(fname)[1].lower()
        if ext not in (".mp4", ".webm", ".mov"):
            return web.Response(status=400)

        path = os.path.join(TEMPLATES_DIR, fname)
        if not os.path.isfile(path):
            return web.Response(status=404)

        return web.FileResponse(path, headers={"Cache-Control": "no-cache"})


    @PromptServer.instance.routes.post("/comfy_my_templates/delete")
    async def delete_template(request):
        """
        Body JSON:
          { "filename": "My_Workflow.json" }
        Deletes the .json + matching .jpg/.jpeg/.png thumbnail.
        """
        try:
            data = await request.json()
            filename = data.get("filename", "")
            if not filename:
                return web.json_response(
                    {"success": False, "error": "missing filename"},
                    status=400,
                )

            base    = _safe_basename(filename)
            deleted = []
            for ext in (".json", ".jpg", ".jpeg", ".png", ".webp",
                        ".mp4", ".webm", ".mov"):
                p = os.path.join(TEMPLATES_DIR, "{}{}".format(base, ext))
                if os.path.isfile(p):
                    try:
                        os.remove(p)
                        deleted.append(os.path.basename(p))
                    except Exception as e:
                        print("[MyTemplates] delete failed for {}: {}".format(p, e))

            return web.json_response({"success": True, "deleted": deleted})

        except Exception as e:
            return web.json_response({"success": False, "error": str(e)}, status=500)


    @PromptServer.instance.routes.get("/comfy_my_templates/thumb/{filename}")
    async def get_thumb(request):
        """Serves a thumbnail file from the my_template_projects folder."""
        raw = request.match_info.get("filename", "")
        fname = os.path.basename(raw)
        if not fname or ".." in fname or "/" in fname or "\\" in fname:
            return web.Response(status=400)
        ext = os.path.splitext(fname)[1].lower()
        if ext not in (".jpg", ".jpeg", ".png", ".webp"):
            return web.Response(status=400)

        path = os.path.join(TEMPLATES_DIR, fname)
        if not os.path.isfile(path):
            return web.Response(status=404)

        return web.FileResponse(path, headers={"Cache-Control": "no-cache"})


    @PromptServer.instance.routes.get("/comfy_my_templates/list")
    async def list_template_projects(request):
        """Returns list of saved template files."""
        try:
            os.makedirs(TEMPLATES_DIR, exist_ok=True)
            files = sorted(
                f for f in os.listdir(TEMPLATES_DIR) if f.endswith(".json")
            )
            return web.json_response({
                "success": True,
                "files":   files,
                "dir":     TEMPLATES_DIR,
            })
        except Exception as e:
            return web.json_response({"success": False, "error": str(e)}, status=500)


    @PromptServer.instance.routes.get("/comfy_my_templates/dir")
    async def get_templates_dir(request):
        return web.json_response({"success": True, "dir": TEMPLATES_DIR})


    print("[MyTemplates] Routes registered. Projects folder: {}".format(TEMPLATES_DIR))

except ImportError:
    print("[MyTemplates] Warning: PromptServer not available — API routes skipped.")

# ── Ensure folder exists on startup ──────────────────────────────────────────
os.makedirs(TEMPLATES_DIR, exist_ok=True)

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
