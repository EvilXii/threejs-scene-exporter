# 3D Scene Exporter for three.js

A Chrome extension that detects **three.js** scenes on any web page, lists every 3D object, and exports them to **GLB, GLTF, OBJ, STL or three.js JSON**. No server, no accounts, no data leaves your browser.

> Not affiliated with the three.js project.

## Features
- Automatic detection of scenes (also in iframes), with a badge showing how many were found
- Object tree: export the whole scene or only the objects you tick
- Flash an object as wireframe on the page to identify it
- Formats: GLB, GLTF, OBJ (+MTL + textures, zipped), STL (Z-up option), three.js JSON
- Materials, textures, vertex colors, instanced meshes, multi-material meshes, skinned/morphed pose baking
- Output validated with the Khronos glTF validator in CI

## Install
**From a release:** download the zip from [Releases](../../releases), unzip it, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and choose the unzipped folder.

**From source:** clone this repo and load the `extension/` folder the same way.

## Use
1. Open a page with a three.js scene and **reload it once** after installing (the extension must be active when the scene is created).
2. Click the toolbar icon, pick a scene and a format, click **Export**.

## How detection works
three.js announces each `Scene` it creates on `window.__THREE_DEVTOOLS__`. The extension installs a listener before page scripts run, so it can find scenes even inside bundled code. It also scans global variables like `window.scene`.

## Limitations
- three.js r125+ (best on r151+).
- Meshes only: lines, points, sprites, lights, cameras and animation clips are not exported.
- Cross-origin textures without CORS cannot be read.
- Texture repeat/offset transforms and custom shaders are simplified.
- Scenes created before the extension was active need a page reload.

## Development
```bash
npm install
npm test        # runs the exporter against real three.js + glTF validator
npm run build   # creates dist/threejs-scene-exporter-vX.Y.Z.zip
```
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Privacy
No data collection, no network requests. See [PRIVACY.md](PRIVACY.md).

## Responsible use
Only export content you own or have permission to use. 3D models on websites are often copyrighted.

## License
[MIT](LICENSE)
