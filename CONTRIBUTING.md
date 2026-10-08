# Contributing

Thanks for helping improve the exporter!

## Setup
```bash
git clone <your-fork-url>
cd threejs-scene-exporter
npm install
npm test
```
Load the extension in Chrome: `chrome://extensions` > Developer mode > Load unpacked > select the `extension/` folder. After editing code, click the reload icon on the extension card and reload the test page.

## Project layout
| Path | Purpose |
|---|---|
| `extension/inject.js` | Runs in the page (MAIN world). Scene detection and all exporters (GLB/GLTF/OBJ/STL/JSON). |
| `extension/popup.*` | Popup UI. Talks to the page with `chrome.scripting.executeScript`. |
| `extension/bridge.js`, `background.js` | Toolbar badge with the scene count. |
| `test/export.test.mjs` | Runs `inject.js` against real three.js and validates glTF output. |

## Guidelines
- Keep the extension dependency-free and offline: no network calls, no remote code.
- Exporters are duck-typed on purpose so they work with any three.js version. Don't import three.js.
- Add or update a test in `test/` for every export-format change. `npm test` must pass.
- Keep pull requests focused, and describe how you tested (page URL, three.js version).

## Ideas welcome
Lines/points export, animation clips, texture transforms (`KHR_texture_transform`), Draco/meshopt, WebGPU renderer scenes, click-to-pick objects.

## Reporting bugs
Please include: Chrome version, the page URL (or a minimal repro), three.js version (the popup shows it), the export format, and any message shown in the popup.
