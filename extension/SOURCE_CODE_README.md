# ACO - Cart Optimizer — Source Code for Mozilla Review

## Overview

This extension does **not use any build tools, bundlers, minifiers, or transpilers**
for its own code. The contents of the `extension/` directory are the complete,
unprocessed source code that can be loaded directly into Firefox as a temporary
extension.

The only exception is `extension/highs.js` and `extension/highs.wasm`, which are
files from the **open-source third-party library HiGHS** (an LP/MILP solver compiled
from C++ to WebAssembly via Emscripten). These files are exempt per Mozilla policy
("except open-source third-party libraries").

> **Note for reviewers:** The repository also contains a set of standalone Python
> scripts (`main.py`, `scraper.py`, `optimizer.py`, `executor.py`, `config.py`,
> `requirements.txt`, `run.bat`). These are a **separate command-line tool** for
> power users who prefer running the optimiser locally without a browser extension.
> They are **not part of the Firefox add-on** and do not need to be reviewed.
> Only the `extension/` directory is relevant to this submission.

---

## System Requirements

- **OS**: Windows, Linux or macOS
- **Node.js**: v18 or later (only needed to verify the `highs.js` origin)
- **npm**: v9 or later (only needed to verify the `highs.js` origin)
- **Firefox**: 109.0 or later

---

## Extension File Structure

```
extension/
├── manifest.json          ← Chromium-specific manifest (Chrome, Edge, Brave)
├── manifest.firefox.json  ← Firefox-specific manifest
├── background.js          ← Background script (plain JS, no build step)
├── content.js             ← Content script (plain JS, no build step)
├── popup.js               ← Popup script (plain JS, no build step)
├── popup.html             ← Popup HTML
├── popup.css              ← Popup stylesheet
├── overlay.css            ← Overlay stylesheet injected into Allegro pages
├── config.example.js      ← Configuration template (see note below)
├── config.production.js   ← Production config (monetisation params)
├── highs.js               ← ⚠ Third-party library — see section below
├── highs.wasm             ← ⚠ Third-party library — see section below
└── icons/
    └── logo.png
```

All `.js`, `.html`, `.css` files written by the author are **plain, human-readable
source files with no compilation or transformation step**.

### Files NOT part of the extension (separate Python CLI tool)

The following files exist in the repository but are **entirely unrelated** to the
Firefox extension and can be ignored by Mozilla reviewers:

| File | Purpose |
|---|---|
| `main.py` | Python CLI entry point |
| `scraper.py` | Allegro scraper (Playwright) |
| `optimizer.py` | Local Python MILP solver |
| `executor.py` | Cart executor |
| `config.py` | Python tool config |
| `requirements.txt` | Python dependencies |
| `run.bat` | Windows launcher for the Python tool |
| `venv/` | Python virtual environment (git-ignored) |
| `__pycache__/` | Python cache (git-ignored) |

These Python files do not interact with the browser extension in any way.

---

## How to Load the Extension in Firefox (No Build Needed)

1. Clone or download the repository:
   ```
   git clone https://github.com/ggqode/ACO.git
   cd ACO
   ```

2. Prepare the Firefox manifest:
   For Firefox, the Firefox-specific manifest file (`manifest.firefox.json`) must be used as `manifest.json`.
   Copy or rename the file:
   ```bash
   cp extension/manifest.firefox.json extension/manifest.json
   ```

3. *(Optional)* If you prefer a ZIP containing **only the extension files**,
   you can create one manually:
   ```bash
   # Linux / macOS
   zip -r ACO-extension-source.zip extension/ SOURCE_CODE_README.md

   # Windows (PowerShell)
   Compress-Archive -Path extension, SOURCE_CODE_README.md -DestinationPath ACO-extension-source.zip
   ```

4. Open Firefox and navigate to `about:debugging`.

5. Click **"This Firefox"** → **"Load Temporary Add-on…"**

6. Navigate to the `extension/` directory and select the updated **`manifest.json`** (which now contains the Firefox-specific configuration).

The extension is now loaded. No compilation, no npm install, no build step required
for any of the author's own code.

---

## Third-Party Library: `highs.js` and `highs.wasm`

### What it is

`highs.js` and `highs.wasm` are the JavaScript + WebAssembly build of the
**HiGHS** linear/integer programming solver, an open-source C++ library.

- **HiGHS source code**: https://github.com/ERGO-Code/HiGHS (MIT License)
- **npm package used**: [`highs`](https://www.npmjs.com/package/highs) v1.14.x

These files were taken **without modification** from the npm package and are
open-source third-party libraries.

### How to verify / reproduce `highs.js`

```bash
# Install the exact package version used in this project
npm install highs@1.14.2

# The files can then be found at:
#   node_modules/highs/highs.js
#   node_modules/highs/highs.wasm
```

You can confirm the files are identical to those in the `extension/` directory
by comparing checksums:

```bash
# On Linux/macOS:
md5sum node_modules/highs/highs.js extension/highs.js
md5sum node_modules/highs/highs.wasm extension/highs.wasm

# On Windows (PowerShell):
Get-FileHash node_modules/highs/highs.js, extension/highs.js -Algorithm MD5
Get-FileHash node_modules/highs/highs.wasm, extension/highs.wasm -Algorithm MD5
```

Both pairs of files should produce **identical hashes**.

---

## Summary

| File | Written by author? | Build step? | Notes |
|---|---|---|---|
| `manifest.json` | ✅ Yes | ❌ None | Plain JSON |
| `background.js` | ✅ Yes | ❌ None | Plain JS |
| `content.js` | ✅ Yes | ❌ None | Plain JS |
| `popup.js` | ✅ Yes | ❌ None | Plain JS |
| `popup.html` | ✅ Yes | ❌ None | Plain HTML |
| `popup.css` | ✅ Yes | ❌ None | Plain CSS |
| `overlay.css` | ✅ Yes | ❌ None | Plain CSS |
| `highs.js` | ❌ Third-party | ✅ Emscripten (C++→WASM) | npm: `highs@1.14.x` — open-source (MIT) |
| `highs.wasm` | ❌ Third-party | ✅ Emscripten (C++→WASM) | npm: `highs@1.14.x` — open-source (MIT) |
