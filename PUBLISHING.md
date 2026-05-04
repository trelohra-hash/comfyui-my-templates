# Publishing Guide

Step-by-step για να ανεβάσεις το extension στο GitHub + Comfy Registry.

---

## Part 1 — GitHub Repository

### 1.1 Create the repo

1. Go to https://github.com/new
2. Repository name: `comfyui-my-templates`
3. Visibility: Public
4. Do **NOT** initialize with README/LICENSE (we already have them)
5. Click **Create repository**

### 1.2 Customize files before pushing

Open these files and replace the placeholders with your info:

**`pyproject.toml`** (3 placeholders):
```toml
Repository = "https://github.com/YOUR_GITHUB_USER/comfyui-my-templates"
"Bug Tracker" = "https://github.com/YOUR_GITHUB_USER/comfyui-my-templates/issues"
PublisherId = "YOUR_PUBLISHER_ID"
```

**`LICENSE`**:
```
Copyright (c) 2026 YOUR_NAME
```

**`README.md`** (1 placeholder):
```
git clone https://github.com/YOUR_GITHUB_USER/comfyui-my-templates.git
```

### 1.3 Push to GitHub

From inside the `comfyui-my-templates/` folder:

```bash
git init
git add .
git commit -m "Initial release v1.0.0"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USER/comfyui-my-templates.git
git push -u origin main
```

✅ Done — users can now manually install via `git clone`.

---

## Part 2 — Comfy Registry (one-click install via Manager)

### 2.1 Create publisher account

1. Go to https://registry.comfy.org/
2. Sign in with your GitHub account
3. Create a Publisher (e.g. your username) → note down the **Publisher ID**
4. In your publisher settings, generate an **API Key** → copy it (you'll only see it once)

### 2.2 Update `pyproject.toml`

Replace `YOUR_PUBLISHER_ID` with the real publisher id you just created. Commit and push.

### 2.3 Add the API key as a GitHub secret

1. Go to your repo → **Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Name: `REGISTRY_ACCESS_TOKEN`
4. Value: paste the API key from step 2.1
5. Click **Add secret**

### 2.4 Trigger the first publish

The included GitHub Action (`.github/workflows/publish.yml`) auto-runs whenever you change `pyproject.toml`.

To publish a new version manually:

1. Edit `pyproject.toml` — bump the `version` field (e.g. `1.0.0` → `1.0.1`)
2. Commit and push to `main`
3. Watch the GitHub Action run → check **Actions** tab in your repo
4. Once green, your node appears at `https://registry.comfy.org/publishers/YOUR_PUBLISHER_ID/nodes/comfyui-my-templates`

✅ Done — users can now install via ComfyUI Manager (search "My Templates").

---

## Part 3 — ComfyUI Manager listing (legacy registry)

Some older ComfyUI installs use the legacy ComfyUI-Manager `custom-node-list.json`.
Submit a PR to https://github.com/ltdrdata/ComfyUI-Manager/blob/main/custom-node-list.json with this entry:

```json
{
  "author": "YOUR_NAME",
  "title": "My Templates",
  "reference": "https://github.com/YOUR_GITHUB_USER/comfyui-my-templates",
  "files": ["https://github.com/YOUR_GITHUB_USER/comfyui-my-templates"],
  "install_type": "git-clone",
  "description": "Save, categorize and reload your own workflows as private templates with image / 3-second video thumbnails."
}
```

This is optional — most users now have the new Manager which uses the Comfy Registry directly.

---

## Versioning & updates

For every new release:

1. Make your code changes
2. Bump `version` in `pyproject.toml` (semver: MAJOR.MINOR.PATCH)
3. Commit + push
4. The GitHub Action publishes automatically to Comfy Registry
5. Users get notified of the update via ComfyUI Manager

**Tip:** Tag releases on GitHub for nice changelog UI:
```bash
git tag -a v1.0.1 -m "Fix: X / Add: Y"
git push origin v1.0.1
```

---

## Will ComfyUI updates break the extension?

**Very unlikely.** The extension uses only stable, official APIs:
- `app.registerExtension` (commands, menuCommands, keybindings)
- `app.graph.serialize()` / `app.loadGraphData()`
- `app.extensionManager` (toast, dialog)
- `PromptServer.instance.routes` for backend HTTP routes

The only "soft" coupling is one DOM lookup that finds the **Manager** button to use as a position anchor for our toolbar button. If that lookup fails (e.g. ComfyUI restructures the toolbar), our button simply doesn't appear — but everything else still works (File menu, keyboard shortcut). Nothing in the extension would break ComfyUI itself.

ComfyUI **never modifies files inside `custom_nodes/`** during updates, so the extension stays as-is.
