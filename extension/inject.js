/* Three.js Scene Exporter - page-context script (runs in the page's MAIN world).
 * 1. Detects three.js scenes (via the __THREE_DEVTOOLS__ hook + global scan).
 * 2. Exports scenes / selected objects to GLB, GLTF, OBJ(+MTL zip), STL and three.js JSON.
 * The exporters are self-contained (duck-typed), so they work with any three.js version >= ~r125.
 */
(() => {
  'use strict';
  const W = typeof window !== 'undefined' ? window : globalThis;
  if (W.__T3X__) return;

  /* ------------------------------------------------------------------ */
  /* Detection                                                           */
  /* ------------------------------------------------------------------ */
  let idCounter = 0;
  const entries = [];
  const seen = new WeakSet();
  const canvasRefs = [];
  const canvasSeen = new WeakSet();
  const rendererRefs = [];
  let revision = null;
  const mkRef = (o) => (typeof WeakRef === 'function' ? new WeakRef(o) : { deref: () => o });

  function register(obj, via) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);
    entries.push({ id: ++idCounter, ref: mkRef(obj), via });
  }

  // three.js announces every Scene / WebGLRenderer it creates on __THREE_DEVTOOLS__ (if present)
  try {
    let dt = W.__THREE_DEVTOOLS__;
    if (!dt || typeof dt.addEventListener !== 'function') {
      dt = new EventTarget();
      W.__THREE_DEVTOOLS__ = dt;
    }
    dt.addEventListener('observe', (e) => {
      const o = e && e.detail;
      if (!o) return;
      if (o.isScene) register(o, 'devtools hook');
      else if (o.isWebGLRenderer || o.isWebGPURenderer) rendererRefs.push(mkRef(o));
    });
    dt.addEventListener('register', (e) => {
      if (e && e.detail && e.detail.revision) revision = e.detail.revision;
    });
  } catch (e) { /* ignore */ }

  // remember canvases that got a WebGL context (used for hints when no scene is reachable)
  try {
    if (typeof HTMLCanvasElement !== 'undefined') {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type) {
        const ctx = orig.apply(this, arguments);
        try {
          if (ctx && /webgl/i.test(String(type)) && !canvasSeen.has(this)) {
            canvasSeen.add(this);
            canvasRefs.push(mkRef(this));
          }
        } catch (e) { /* ignore */ }
        return ctx;
      };
    }
  } catch (e) { /* ignore */ }

  const SKIP_KEYS = new Set(['THREE', 'window', 'self', 'top', 'parent', 'frames', 'document', 'location', 'history',
    'navigator', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'opener', 'frameElement', 'globalThis',
    'performance', 'screen', 'visualViewport', 'customElements', 'speechSynthesis', 'crypto', '__T3X__']);

  function isDomLike(v) {
    try {
      return (typeof Node !== 'undefined' && v instanceof Node) ||
        (typeof Window !== 'undefined' && v instanceof Window) ||
        (typeof Event !== 'undefined' && v instanceof Event);
    } catch (e) { return false; }
  }

  // fallback: look for scenes stored on window / window.x (works for globals like window.scene, window.app.scene)
  function scanGlobals() {
    let budget = 6000;
    const check = (v, path) => {
      try {
        if (!v || typeof v !== 'object' || v.isObject3D !== true) return false;
        if (v.isScene || !v.parent) register(v, 'global ' + path);
        return true;
      } catch (e) { return false; }
    };
    let names;
    try { names = Object.getOwnPropertyNames(W); } catch (e) { return; }
    for (const k of names) {
      if (budget-- <= 0) return;
      if (SKIP_KEYS.has(k)) continue;
      let d;
      try { d = Object.getOwnPropertyDescriptor(W, k); } catch (e) { continue; }
      if (!d || !('value' in d)) continue;
      const v = d.value;
      if (!v || typeof v !== 'object' || isDomLike(v)) continue;
      if (check(v, k)) continue;
      let inner;
      try { inner = Array.isArray(v) ? v.slice(0, 200).map((_, i) => String(i)) : Object.getOwnPropertyNames(v); } catch (e) { continue; }
      for (const k2 of inner) {
        if (budget-- <= 0) return;
        let d2;
        try { d2 = Object.getOwnPropertyDescriptor(v, k2); } catch (e) { continue; }
        if (!d2 || !('value' in d2)) continue;
        check(d2.value, k + '.' + k2);
      }
    }
  }

  function geomCounts(o) {
    const geo = o.geometry;
    const pos = geo && geo.attributes && geo.attributes.position;
    if (!pos || !pos.count) return [0, 0];
    const inst = o.isInstancedMesh ? o.count : 1;
    const tris = geo.index ? geo.index.count / 3 : pos.count / 3;
    return [pos.count * inst, tris * inst];
  }

  function stats(root) {
    let meshes = 0, tris = 0, verts = 0, objects = 0;
    const st = [root];
    while (st.length) {
      const o = st.pop();
      objects++;
      if (o.isMesh && o.geometry) {
        meshes++;
        const [v, t] = geomCounts(o);
        verts += v; tris += t;
      }
      const c = o.children;
      if (c) for (let i = 0; i < c.length; i++) st.push(c[i]);
    }
    return { meshes, tris: Math.round(tris), verts, objects };
  }

  function getRoot(id) {
    const e = entries.find((x) => x.id === id);
    const o = e && e.ref.deref();
    if (!o) throw new Error('This scene no longer exists on the page. Rescan and try again.');
    return o;
  }

  const liveCanvases = () => canvasRefs.filter((r) => { const c = r.deref(); return c && c.isConnected; }).length;

  function detect() {
    scanGlobals();
    const sources = [];
    let empties = 0;
    for (const e of entries) {
      const o = e.ref.deref();
      if (!o) continue;
      const s = stats(o);
      if (!s.meshes) { empties++; continue; }
      sources.push({
        id: e.id,
        name: o.name || (o.isScene ? 'Scene' : o.type || 'Object3D'),
        kind: o.isScene ? 'Scene' : (o.type || 'Object3D'),
        via: e.via,
        ...s
      });
    }
    let top = false;
    try { top = W === W.top; } catch (e) { /* cross-origin */ }
    return {
      url: String(W.location && W.location.href),
      title: typeof document !== 'undefined' ? document.title : '',
      top,
      revision: W.__THREE__ || revision,
      canvases: liveCanvases(),
      renderers: rendererRefs.filter((r) => r.deref()).length,
      sources,
      empties
    };
  }

  function summarize(o) {
    const s = stats(o);
    return {
      uuid: o.uuid,
      name: o.name || '',
      type: o.type || 'Object3D',
      visible: o.visible !== false,
      children: o.children.length,
      meshes: s.meshes,
      tris: s.tris
    };
  }

  function tree(id, uuid) {
    const root = getRoot(id);
    const parent = uuid ? root.getObjectByProperty('uuid', uuid) : root;
    if (!parent) return { total: 0, items: [] };
    const total = parent.children.length;
    return { total, items: parent.children.slice(0, 400).map(summarize) };
  }

  function resolveTargets(id, uuids) {
    const root = getRoot(id);
    if (root.updateWorldMatrix) root.updateWorldMatrix(true, true);
    let targets = [root];
    if (uuids && uuids.length) {
      targets = uuids.map((u) => root.getObjectByProperty('uuid', u)).filter(Boolean);
      const set = new Set(targets);
      targets = targets.filter((t) => { // drop objects whose ancestor is also selected
        for (let p = t.parent; p; p = p.parent) if (set.has(p)) return false;
        return true;
      });
      if (!targets.length) targets = [root];
    }
    return { root, targets };
  }

  function flash(id, uuids) {
    const { targets } = resolveTargets(id, uuids);
    const mats = new Set();
    targets.forEach((t) => t.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m && 'wireframe' in m) mats.add(m); });
    }));
    const prev = [];
    mats.forEach((m) => { prev.push([m, m.wireframe]); m.wireframe = true; });
    setTimeout(() => prev.forEach(([m, v]) => { m.wireframe = v; }), 1600);
    return mats.size;
  }

  /* ------------------------------------------------------------------ */
  /* Math helpers (column-major 4x4 like three.js)                       */
  /* ------------------------------------------------------------------ */
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const isIdentity = (m) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9);

  function mul(a, b) { // a * b
    const o = new Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  // maps (x,y,z) -> (x,-z,y): Y-up (three.js) to Z-up (CAD, slicers, Blender import)
  const Y_TO_Z = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

  function normalMatrix(M) {
    const m00 = M[0], m01 = M[4], m02 = M[8], m10 = M[1], m11 = M[5], m12 = M[9], m20 = M[2], m21 = M[6], m22 = M[10];
    const c = [
      m11 * m22 - m12 * m21, m12 * m20 - m10 * m22, m10 * m21 - m11 * m20,
      m02 * m21 - m01 * m22, m00 * m22 - m02 * m20, m01 * m20 - m00 * m21,
      m01 * m12 - m02 * m11, m02 * m10 - m00 * m12, m00 * m11 - m01 * m10
    ];
    const det = m00 * c[0] + m01 * c[1] + m02 * c[2];
    return { c, flip: det < 0 };
  }

  function worldPositions(geom, M) {
    const p = geom.position, n = geom.count, out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      out[i * 3] = M[0] * x + M[4] * y + M[8] * z + M[12];
      out[i * 3 + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
      out[i * 3 + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Scene -> intermediate representation                                */
  /* ------------------------------------------------------------------ */
  const ATTR_GETTERS = ['getX', 'getY', 'getZ', 'getW'];

  function readAttr(attr, size) {
    const n = attr.count;
    if (!attr.isInterleavedBufferAttribute && !attr.normalized && attr.array instanceof Float32Array && attr.itemSize === size) {
      return attr.array.slice(0, n * size);
    }
    const out = new Float32Array(n * size);
    const comps = Math.min(size, attr.itemSize);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < comps; k++) out[i * size + k] = attr[ATTR_GETTERS[k]](i);
    }
    return out;
  }

  function computeNormals(pos, index) {
    const n = pos.length / 3, nrm = new Float32Array(n * 3);
    const tri = index ? index.length / 3 : n / 3;
    for (let t = 0; t < tri; t++) {
      const a = index ? index[t * 3] : t * 3, b = index ? index[t * 3 + 1] : t * 3 + 1, c = index ? index[t * 3 + 2] : t * 3 + 2;
      const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const v of [a, b, c]) { nrm[v * 3] += nx; nrm[v * 3 + 1] += ny; nrm[v * 3 + 2] += nz; }
    }
    for (let i = 0; i < n; i++) {
      const l = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]) || 1;
      nrm[i * 3] /= l; nrm[i * 3 + 1] /= l; nrm[i * 3 + 2] /= l;
    }
    return nrm;
  }

  function collectMeshes(root, includeHidden) {
    const out = [];
    const st = [root];
    while (st.length) {
      const o = st.pop();
      if (!includeHidden && o !== root && o.visible === false) continue;
      if (o.isMesh && o.geometry) out.push(o);
      for (let i = o.children.length - 1; i >= 0; i--) st.push(o.children[i]);
    }
    return out;
  }

  function extractGeometry(o, opts, warnings) {
    const geo = o.geometry;
    const posAttr = geo && geo.attributes && geo.attributes.position;
    if (!geo || !geo.isBufferGeometry || !posAttr || posAttr.isGLBufferAttribute || !posAttr.count) {
      warnings.add('Skipped a mesh with unsupported geometry (' + ((geo && geo.type) || 'none') + ').');
      return null;
    }
    const morphing = o.morphTargetInfluences && o.morphTargetInfluences.some((v) => v !== 0) &&
      geo.morphAttributes && geo.morphAttributes.position;
    const bake = opts.bakePose !== false && (o.isSkinnedMesh || morphing) && typeof o.getVertexPosition === 'function';
    if ((o.isSkinnedMesh || morphing) && !bake) warnings.add('Skinned/morphed pose could not be baked (needs three.js r151+); exported bind pose.');

    const n = posAttr.count;
    let position;
    if (bake) {
      position = new Float32Array(n * 3);
      const target = new o.position.constructor();
      for (let i = 0; i < n; i++) {
        o.getVertexPosition(i, target);
        position[i * 3] = target.x; position[i * 3 + 1] = target.y; position[i * 3 + 2] = target.z;
      }
    } else {
      position = readAttr(posAttr, 3);
    }
    const index = geo.index ? new Uint32Array(geo.index.array) : null;
    let normal = null;
    if (bake) normal = computeNormals(position, index);
    else if (geo.attributes.normal && !geo.attributes.normal.isGLBufferAttribute) normal = readAttr(geo.attributes.normal, 3);
    const uv = geo.attributes.uv && !geo.attributes.uv.isGLBufferAttribute ? readAttr(geo.attributes.uv, 2) : null;
    let color = null;
    const ca = geo.attributes.color;
    if (ca && !ca.isGLBufferAttribute) { const size = ca.itemSize >= 4 ? 4 : 3; color = { data: readAttr(ca, size), size }; }
    return { position, normal, uv, color, index, count: n, type: geo.type };
  }

  const WRAP_GL = { 1000: 10497, 1001: 33071, 1002: 33648 };

  function rawToImageData(img, w, h) {
    const d = img.data;
    const px = w * h;
    const out = new Uint8ClampedArray(px * 4);
    if (d.length === px * 4) out.set(d);
    else if (d.length === px * 3) { for (let i = 0; i < px; i++) { out[i * 4] = d[i * 3]; out[i * 4 + 1] = d[i * 3 + 1]; out[i * 4 + 2] = d[i * 3 + 2]; out[i * 4 + 3] = 255; } }
    else if (d.length === px) { for (let i = 0; i < px; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = d[i]; out[i * 4 + 3] = 255; } }
    else return null;
    if (!(d instanceof Uint8Array || d instanceof Uint8ClampedArray)) return null;
    return new ImageData(out, w, h);
  }

  async function textureToPNG(tex, maxTex) {
    if (tex.isCompressedTexture || tex.isCubeTexture || tex.isCompressedArrayTexture) throw new Error('unsupported texture type');
    const img = tex.image || (tex.source && tex.source.data);
    if (!img || Array.isArray(img)) throw new Error('no image data');
    let w, h;
    const raw = img.data && ArrayBuffer.isView(img.data);
    if (raw) { w = img.width; h = img.height; }
    else if (img.naturalWidth) { w = img.naturalWidth; h = img.naturalHeight; }
    else if (img.videoWidth) { w = img.videoWidth; h = img.videoHeight; }
    else { w = img.width; h = img.height; }
    if (!w || !h) throw new Error('image not loaded');
    const scale = Math.min(1, maxTex / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (raw) {
      const id = rawToImageData(img, w, h);
      if (!id) throw new Error('unsupported pixel format');
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      tmp.getContext('2d').putImageData(id, 0, 0);
      ctx.drawImage(tmp, 0, 0, cw, ch);
    } else {
      ctx.drawImage(img, 0, 0, cw, ch);
    }
    const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function buildIR(targets, opts) {
    const warnings = new Set();
    const ir = { meshes: [], textures: new Set(), warnings };
    const geomCache = new Map(), matCache = new Map(), texCache = new Map();
    const maxTex = opts.maxTexture || 4096;
    let matId = 0, texId = 0;

    async function getTex(t) {
      if (!t || opts.textures === false) return null;
      if (texCache.has(t)) return texCache.get(t);
      let res = null;
      try {
        const png = await textureToPNG(t, maxTex);
        res = { id: ++texId, name: t.name || 'texture_' + texId, png, flipY: t.flipY === true, wrapS: t.wrapS, wrapT: t.wrapT };
        ir.textures.add(res);
        if (t.repeat && (t.repeat.x !== 1 || t.repeat.y !== 1)) warnings.add('Texture repeat/offset transforms are not exported.');
      } catch (e) {
        warnings.add('A texture could not be exported (' + (e && e.message ? e.message : e) + '); cross-origin images cannot be read.');
      }
      texCache.set(t, res);
      return res;
    }

    async function getMat(m) {
      if (matCache.has(m)) return matCache.get(m);
      const d = {
        id: ++matId, name: m.name || m.type || 'material', baseColor: [1, 1, 1, 1], metallic: 0, roughness: 1,
        emissive: [0, 0, 0], alphaMode: 'OPAQUE', alphaCutoff: 0.5, doubleSided: false, unlit: false,
        vertexColors: !!m.vertexColors, opacity: 1, normalScale: 1,
        tex: { base: null, normal: null, emissive: null, mr: null, ao: null }
      };
      if (m.color && m.color.isColor) d.baseColor = [m.color.r, m.color.g, m.color.b, 1];
      else if (!m.isMeshBasicMaterial && !m.isMeshStandardMaterial) warnings.add('Custom shader materials are exported as plain grey/base color.');
      if (m.color === undefined) d.baseColor = [0.8, 0.8, 0.8, 1];
      d.opacity = typeof m.opacity === 'number' ? m.opacity : 1;
      if (m.transparent || d.opacity < 1) { d.alphaMode = 'BLEND'; d.baseColor[3] = d.opacity; }
      else if (m.alphaTest > 0) { d.alphaMode = 'MASK'; d.alphaCutoff = m.alphaTest; }
      d.doubleSided = m.side === 2 || m.side === 1;
      if (m.isMeshStandardMaterial) { d.metallic = m.metalness; d.roughness = m.roughness; }
      else if (m.isMeshPhongMaterial) { d.roughness = Math.min(1, Math.max(0.2, 1 - (m.shininess || 30) / 120)); }
      else if (m.isMeshBasicMaterial) { d.unlit = true; }
      if (m.emissive && m.emissive.isColor) {
        const k = typeof m.emissiveIntensity === 'number' ? m.emissiveIntensity : 1;
        d.emissive = [Math.min(1, m.emissive.r * k), Math.min(1, m.emissive.g * k), Math.min(1, m.emissive.b * k)];
      }
      d.tex.base = await getTex(m.map);
      d.tex.normal = await getTex(m.normalMap);
      d.tex.emissive = await getTex(m.emissiveMap);
      d.tex.ao = await getTex(m.aoMap);
      if (m.metalnessMap && m.roughnessMap && m.metalnessMap !== m.roughnessMap) warnings.add('Separate metalness/roughness maps are not merged; roughness map used.');
      d.tex.mr = await getTex(m.roughnessMap || m.metalnessMap);
      if (d.tex.mr) { d.metallic = m.metalnessMap ? 1 : d.metallic; d.roughness = m.roughnessMap ? 1 : d.roughness; }
      if (m.normalScale && typeof m.normalScale.x === 'number') d.normalScale = m.normalScale.x;
      matCache.set(m, d);
      return d;
    }

    const defaultMat = await getMat({ type: 'MeshStandardMaterial', isMeshStandardMaterial: true, color: { isColor: true, r: 0.8, g: 0.8, b: 0.8 }, metalness: 0, roughness: 0.7, opacity: 1, side: 0, name: 'default' });

    const list = [];
    const dupe = new Set();
    for (const t of targets) for (const m of collectMeshes(t, opts.includeHidden)) if (!dupe.has(m)) { dupe.add(m); list.push(m); }

    let meshIndex = 0;
    for (const o of list) {
      meshIndex++;
      const mats0 = Array.isArray(o.material) ? o.material : [o.material];
      const bakeKey = o.isSkinnedMesh || (o.morphTargetInfluences && o.morphTargetInfluences.length);
      let geom = !bakeKey ? geomCache.get(o.geometry) : null;
      if (!geom) {
        geom = extractGeometry(o, opts, warnings);
        if (!geom) continue;
        if (!bakeKey) geomCache.set(o.geometry, geom);
      }
      const total = geom.index ? geom.index.length : geom.count;
      let rawGroups = [{ start: 0, count: total, materialIndex: 0 }];
      if (mats0.length > 1 && o.geometry.groups && o.geometry.groups.length) rawGroups = o.geometry.groups;
      else if (mats0.length > 1) warnings.add('A multi-material mesh had no geometry groups; first material used.');
      const groups = [];
      for (const g of rawGroups) {
        const m = mats0[g.materialIndex];
        if (m && !opts.includeHidden && (m.visible === false || m.colorWrite === false)) continue;
        const start = Math.max(0, g.start), count = Math.floor(Math.min(g.count, total - start) / 3) * 3;
        if (count <= 0) continue;
        groups.push({ start, count, mat: m ? await getMat(m) : defaultMat });
      }
      if (!groups.length) continue;

      const base = Array.from(o.matrixWorld.elements);
      const name = o.name || (o.parent && o.parent.name) || (geom.type || 'Mesh') + '_' + meshIndex;
      let uvFlip = false;
      for (const g of groups) {
        const t = g.mat.tex.base || g.mat.tex.normal || g.mat.tex.emissive || g.mat.tex.mr || g.mat.tex.ao;
        if (t) { uvFlip = t.flipY; break; }
      }
      if (o.isInstancedMesh && o.instanceMatrix) {
        const cap = 20000;
        const count = Math.min(o.count, cap);
        if (o.count > cap) warnings.add('InstancedMesh truncated to ' + cap + ' instances.');
        const arr = o.instanceMatrix.array;
        for (let i = 0; i < count; i++) {
          const im = Array.from(arr.subarray(i * 16, i * 16 + 16));
          ir.meshes.push({ name: name + '_' + i, matrix: mul(base, im), geom, groups, uvFlip });
        }
      } else {
        ir.meshes.push({ name, matrix: base, geom, groups, uvFlip });
      }
    }
    if (opts.zUp) for (const m of ir.meshes) m.matrix = mul(Y_TO_Z, m.matrix);
    return ir;
  }

  /* ------------------------------------------------------------------ */
  /* glTF / GLB writer                                                   */
  /* ------------------------------------------------------------------ */
  const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

  function gltfFromIR(ir) {
    const J = {
      asset: { version: '2.0', generator: 'Three.js Scene Exporter (Chrome extension)' },
      scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }]
    };
    const chunks = [];
    let len = 0;
    const ext = new Set();

    const addView = (bytes, target) => {
      const pad = (4 - (len % 4)) % 4;
      if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
      const v = { buffer: 0, byteOffset: len, byteLength: bytes.byteLength };
      if (target) v.target = target;
      J.bufferViews.push(v);
      chunks.push(bytes);
      len += bytes.byteLength;
      return J.bufferViews.length - 1;
    };
    const addAcc = (arr, componentType, type, target, withBounds) => {
      const bv = addView(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), target);
      const a = { bufferView: bv, componentType, count: arr.length / NUM[type], type };
      if (withBounds) {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) { const v = arr[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
        a.min = min; a.max = max;
      }
      J.accessors.push(a);
      return J.accessors.length - 1;
    };

    const texIdx = new Map();
    const texRef = (t) => {
      if (!t) return undefined;
      if (!texIdx.has(t)) {
        (J.images = J.images || []).push({ bufferView: addView(t.png), mimeType: 'image/png', name: t.name });
        (J.samplers = J.samplers || []).push({ wrapS: WRAP_GL[t.wrapS] || 10497, wrapT: WRAP_GL[t.wrapT] || 10497 });
        (J.textures = J.textures || []).push({ source: J.images.length - 1, sampler: J.samplers.length - 1 });
        texIdx.set(t, J.textures.length - 1);
      }
      return { index: texIdx.get(t) };
    };

    const matIdx = new Map();
    const matRef = (d) => {
      if (matIdx.has(d)) return matIdx.get(d);
      const pbr = {
        baseColorFactor: [d.baseColor[0], d.baseColor[1], d.baseColor[2], d.alphaMode === 'OPAQUE' ? 1 : d.baseColor[3]],
        metallicFactor: d.metallic, roughnessFactor: d.roughness
      };
      const bt = texRef(d.tex.base); if (bt) pbr.baseColorTexture = bt;
      const mt = texRef(d.tex.mr); if (mt) pbr.metallicRoughnessTexture = mt;
      const m = { name: d.name, pbrMetallicRoughness: pbr };
      const nt = texRef(d.tex.normal); if (nt) { nt.scale = d.normalScale; m.normalTexture = nt; }
      const ot = texRef(d.tex.ao); if (ot) m.occlusionTexture = ot;
      const et = texRef(d.tex.emissive); if (et) m.emissiveTexture = et;
      if (d.emissive.some((v) => v > 0)) m.emissiveFactor = d.emissive;
      if (d.alphaMode !== 'OPAQUE') m.alphaMode = d.alphaMode;
      if (d.alphaMode === 'MASK') m.alphaCutoff = d.alphaCutoff;
      if (d.doubleSided) m.doubleSided = true;
      if (d.unlit) { m.extensions = { KHR_materials_unlit: {} }; ext.add('KHR_materials_unlit'); }
      J.materials.push(m);
      matIdx.set(d, J.materials.length - 1);
      return J.materials.length - 1;
    };

    const accCache = new Map();
    const geomAcc = (geom, flip, wantColor) => {
      let a = accCache.get(geom);
      if (!a) {
        a = { pos: addAcc(geom.position, 5126, 'VEC3', 34962, true), uv: {}, idx: new Map() };
        if (geom.normal) a.nrm = addAcc(geom.normal, 5126, 'VEC3', 34962);
        accCache.set(geom, a);
      }
      if (geom.uv && a.uv[flip ? 1 : 0] === undefined) {
        let uv = geom.uv;
        if (flip) { uv = new Float32Array(geom.uv); for (let i = 1; i < uv.length; i += 2) uv[i] = 1 - uv[i]; }
        a.uv[flip ? 1 : 0] = addAcc(uv, 5126, 'VEC2', 34962);
      }
      if (wantColor && geom.color && a.col === undefined) a.col = addAcc(geom.color.data, 5126, geom.color.size === 4 ? 'VEC4' : 'VEC3', 34962);
      return a;
    };
    const idxAcc = (geom, a, g) => {
      const key = g.start + ':' + g.count;
      if (a.idx.has(key)) return a.idx.get(key);
      let res;
      if (!geom.index && g.start === 0 && g.count === geom.count) res = null;
      else {
        let src;
        if (geom.index) src = geom.index.subarray(g.start, g.start + g.count);
        else { src = new Uint32Array(g.count); for (let i = 0; i < g.count; i++) src[i] = g.start + i; }
        res = geom.count < 65535 ? addAcc(new Uint16Array(src), 5123, 'SCALAR', 34963) : addAcc(new Uint32Array(src), 5125, 'SCALAR', 34963);
      }
      a.idx.set(key, res);
      return res;
    };

    const meshCache = new Map();
    for (const m of ir.meshes) {
      const wantColor = m.groups.some((g) => g.mat.vertexColors) && !!m.geom.color;
      const key = m.groups.map((g) => g.start + ':' + g.count + ':' + g.mat.id).join(';') + '|' + m.uvFlip + '|' + wantColor;
      let perGeom = meshCache.get(m.geom);
      if (!perGeom) { perGeom = new Map(); meshCache.set(m.geom, perGeom); }
      let mi = perGeom.get(key);
      if (mi === undefined) {
        const a = geomAcc(m.geom, m.uvFlip, wantColor);
        const primitives = m.groups.map((g) => {
          const attributes = { POSITION: a.pos };
          if (a.nrm !== undefined) attributes.NORMAL = a.nrm;
          if (a.uv[m.uvFlip ? 1 : 0] !== undefined) attributes.TEXCOORD_0 = a.uv[m.uvFlip ? 1 : 0];
          if (wantColor && a.col !== undefined) attributes.COLOR_0 = a.col;
          const p = { attributes, mode: 4, material: matRef(g.mat) };
          const ia = idxAcc(m.geom, a, g);
          if (ia !== null) p.indices = ia;
          return p;
        });
        J.meshes.push({ name: m.name, primitives });
        mi = J.meshes.length - 1;
        perGeom.set(key, mi);
      }
      const node = { name: m.name, mesh: mi };
      if (!isIdentity(m.matrix)) node.matrix = m.matrix;
      J.nodes.push(node);
      J.scenes[0].nodes.push(J.nodes.length - 1);
    }
    if (ext.size) J.extensionsUsed = Array.from(ext);
    if (!J.meshes.length) throw new Error('Nothing to export.');
    return { J, chunks, getLen: () => len, setLen: (v) => { len = v; } };
  }

  function padTo4(state) {
    const pad = (4 - (state.getLen() % 4)) % 4;
    if (pad) { state.chunks.push(new Uint8Array(pad)); state.setLen(state.getLen() + pad); }
    return state.getLen();
  }

  function packGLB(state) {
    const len = padTo4(state);
    state.J.buffers[0].byteLength = len;
    const jsonBytes = new TextEncoder().encode(JSON.stringify(state.J));
    const jsonChunk = new Uint8Array(jsonBytes.length + ((4 - (jsonBytes.length % 4)) % 4)).fill(0x20);
    jsonChunk.set(jsonBytes);
    const head = new DataView(new ArrayBuffer(20));
    head.setUint32(0, 0x46546c67, true);
    head.setUint32(4, 2, true);
    head.setUint32(8, 12 + 8 + jsonChunk.length + 8 + len, true);
    head.setUint32(12, jsonChunk.length, true);
    head.setUint32(16, 0x4e4f534a, true);
    const binHead = new DataView(new ArrayBuffer(8));
    binHead.setUint32(0, len, true);
    binHead.setUint32(4, 0x004e4942, true);
    return new Blob([head.buffer, jsonChunk, binHead.buffer, ...state.chunks], { type: 'model/gltf-binary' });
  }

  function blobToDataURL(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  }

  async function packGLTF(state) {
    const len = padTo4(state);
    state.J.buffers[0] = { byteLength: len, uri: await blobToDataURL(new Blob(state.chunks)) };
    return new Blob([JSON.stringify(state.J)], { type: 'model/gltf+json' });
  }

  /* ------------------------------------------------------------------ */
  /* OBJ + MTL (zipped with textures) and STL                            */
  /* ------------------------------------------------------------------ */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8); return (~c) >>> 0; }

  function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, name, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);
      offset += 30 + name.length + size;
    }
    const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  const safeName = (s) => String(s || 'unnamed').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'unnamed';
  const lin2srgb = (c) => { c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };
  const f6 = (v) => (Math.round(v * 1e6) / 1e6).toString();

  function objFromIR(ir) {
    const out = ['# Exported by Three.js Scene Exporter', 'mtllib model.mtl'];
    let vo = 1, to = 1, no = 1;
    const mtlNames = new Map();
    const mtl = ['# Exported by Three.js Scene Exporter'];
    const texFiles = new Map();
    const texFile = (t) => {
      if (!t) return null;
      if (!texFiles.has(t)) texFiles.set(t, 'textures/tex_' + t.id + '.png');
      return texFiles.get(t);
    };
    const mtlName = (d) => {
      if (!mtlNames.has(d)) {
        const n = safeName(d.name) + '_' + d.id;
        mtlNames.set(d, n);
        mtl.push('', 'newmtl ' + n, 'Ka 0 0 0',
          'Kd ' + f6(lin2srgb(d.baseColor[0])) + ' ' + f6(lin2srgb(d.baseColor[1])) + ' ' + f6(lin2srgb(d.baseColor[2])),
          'Ks ' + f6(0.5 * (1 - d.roughness) + 0.5 * d.metallic) + ' ' + f6(0.5 * (1 - d.roughness) + 0.5 * d.metallic) + ' ' + f6(0.5 * (1 - d.roughness) + 0.5 * d.metallic),
          'Ns ' + f6(Math.max(1, (1 - d.roughness) * 200)), 'd ' + f6(d.alphaMode === 'OPAQUE' ? 1 : d.baseColor[3]), 'illum 2');
        if (d.emissive.some((v) => v > 0)) mtl.push('Ke ' + d.emissive.map((v) => f6(lin2srgb(v))).join(' '));
        const kd = texFile(d.tex.base); if (kd) mtl.push('map_Kd ' + kd);
        const bump = texFile(d.tex.normal); if (bump) mtl.push('map_Bump ' + bump);
        const ke = texFile(d.tex.emissive); if (ke) mtl.push('map_Ke ' + ke);
      }
      return mtlNames.get(d);
    };

    for (const m of ir.meshes) {
      const g = m.geom, M = m.matrix, n = g.count;
      const N = normalMatrix(M);
      const wp = worldPositions(g, M);
      out.push('o ' + safeName(m.name));
      for (let i = 0; i < n; i++) out.push('v ' + f6(wp[i * 3]) + ' ' + f6(wp[i * 3 + 1]) + ' ' + f6(wp[i * 3 + 2]));
      if (g.uv) for (let i = 0; i < n; i++) out.push('vt ' + f6(g.uv[i * 2]) + ' ' + f6(m.uvFlip ? g.uv[i * 2 + 1] : 1 - g.uv[i * 2 + 1]));
      if (g.normal) {
        const s = N.flip ? -1 : 1, c = N.c;
        for (let i = 0; i < n; i++) {
          const x = g.normal[i * 3], y = g.normal[i * 3 + 1], z = g.normal[i * 3 + 2];
          const nx = (c[0] * x + c[1] * y + c[2] * z) * s, ny = (c[3] * x + c[4] * y + c[5] * z) * s, nz = (c[6] * x + c[7] * y + c[8] * z) * s;
          const l = Math.hypot(nx, ny, nz) || 1;
          out.push('vn ' + f6(nx / l) + ' ' + f6(ny / l) + ' ' + f6(nz / l));
        }
      }
      const ref = (i) => {
        const v = vo + i;
        if (g.uv && g.normal) return v + '/' + (to + i) + '/' + (no + i);
        if (g.uv) return v + '/' + (to + i);
        if (g.normal) return v + '//' + (no + i);
        return String(v);
      };
      for (const grp of m.groups) {
        out.push('usemtl ' + mtlName(grp.mat));
        for (let k = 0; k < grp.count; k += 3) {
          const a = g.index ? g.index[grp.start + k] : grp.start + k;
          const b = g.index ? g.index[grp.start + k + 1] : grp.start + k + 1;
          const c = g.index ? g.index[grp.start + k + 2] : grp.start + k + 2;
          out.push(N.flip ? 'f ' + ref(a) + ' ' + ref(c) + ' ' + ref(b) : 'f ' + ref(a) + ' ' + ref(b) + ' ' + ref(c));
        }
      }
      vo += n; if (g.uv) to += n; if (g.normal) no += n;
    }
    const enc = new TextEncoder();
    const files = [{ name: 'model.obj', data: enc.encode(out.join('\n') + '\n') }, { name: 'model.mtl', data: enc.encode(mtl.join('\n') + '\n') }];
    texFiles.forEach((path, t) => files.push({ name: path, data: t.png }));
    return makeZip(files);
  }

  function stlFromIR(ir) {
    let tris = 0;
    for (const m of ir.meshes) for (const g of m.groups) tris += g.count / 3;
    const buf = new ArrayBuffer(84 + 50 * tris);
    const dv = new DataView(buf);
    const hdr = new TextEncoder().encode('Three.js Scene Exporter');
    new Uint8Array(buf, 0, 80).set(hdr.subarray(0, 80));
    dv.setUint32(80, tris, true);
    let off = 84;
    for (const m of ir.meshes) {
      const wp = worldPositions(m.geom, m.matrix), flip = normalMatrix(m.matrix).flip, g0 = m.geom;
      for (const g of m.groups) {
        for (let k = 0; k < g.count; k += 3) {
          let a = g0.index ? g0.index[g.start + k] : g.start + k;
          let b = g0.index ? g0.index[g.start + k + 1] : g.start + k + 1;
          let c = g0.index ? g0.index[g.start + k + 2] : g.start + k + 2;
          if (flip) { const t = b; b = c; c = t; }
          const ux = wp[b * 3] - wp[a * 3], uy = wp[b * 3 + 1] - wp[a * 3 + 1], uz = wp[b * 3 + 2] - wp[a * 3 + 2];
          const vx = wp[c * 3] - wp[a * 3], vy = wp[c * 3 + 1] - wp[a * 3 + 1], vz = wp[c * 3 + 2] - wp[a * 3 + 2];
          let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
          dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true);
          let p = off + 12;
          for (const v of [a, b, c]) { dv.setFloat32(p, wp[v * 3], true); dv.setFloat32(p + 4, wp[v * 3 + 1], true); dv.setFloat32(p + 8, wp[v * 3 + 2], true); p += 12; }
          off += 50;
        }
      }
    }
    return new Blob([buf], { type: 'model/stl' });
  }

  /* ------------------------------------------------------------------ */
  /* Public export API                                                   */
  /* ------------------------------------------------------------------ */
  const EXT = { glb: 'glb', gltf: 'gltf', obj: 'zip', stl: 'stl', json: 'json' };

  async function exportToBlob(id, uuids, format, opts) {
    opts = opts || {};
    format = String(format || 'glb').toLowerCase();
    if (!EXT[format]) throw new Error('Unknown format: ' + format);
    const { root, targets } = resolveTargets(id, uuids);
    const label = targets.length === 1 ? (targets[0].name || root.name || 'scene') : (root.name || 'scene') + '_selection';
    const base = safeName((W.location && W.location.hostname) || 'page') + '_' + safeName(label);
    const filename = base + '.' + EXT[format];

    if (format === 'json') {
      if (typeof targets[0].toJSON !== 'function') throw new Error('toJSON() is not available on this object.');
      const data = targets.length === 1 ? targets[0].toJSON() : { objects: targets.map((t) => t.toJSON()) };
      return { blob: new Blob([JSON.stringify(data)], { type: 'application/json' }), filename, meshes: 0, triangles: 0, warnings: [] };
    }

    const ir = await buildIR(targets, opts);
    if (!ir.meshes.length) throw new Error('No exportable meshes found (hidden objects are skipped unless enabled).');
    let blob;
    if (format === 'glb') blob = packGLB(gltfFromIR(ir));
    else if (format === 'gltf') blob = await packGLTF(gltfFromIR(ir));
    else if (format === 'obj') blob = objFromIR(ir);
    else blob = stlFromIR(ir);
    let triangles = 0;
    for (const m of ir.meshes) for (const g of m.groups) triangles += g.count / 3;
    return { blob, filename, meshes: ir.meshes.length, triangles, warnings: Array.from(ir.warnings) };
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 30000);
  }

  async function exportScene(id, uuids, format, opts) {
    try {
      const r = await exportToBlob(id, uuids, format, opts);
      download(r.blob, r.filename);
      return { ok: true, filename: r.filename, bytes: r.blob.size, meshes: r.meshes, triangles: r.triangles, warnings: r.warnings };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Badge heartbeat (page -> content script bridge -> background)       */
  /* ------------------------------------------------------------------ */
  let lastSent = '';
  function tick() {
    try {
      let count = 0;
      for (const e of entries) { const o = e.ref.deref(); if (o && o.children && o.children.length) count++; }
      const three = !!(W.__THREE__ || revision);
      const key = count + ':' + three;
      if (key === lastSent) return;
      lastSent = key;
      W.postMessage({ __t3x: true, type: 'count', count, three }, '*');
    } catch (e) { /* ignore */ }
  }
  if (typeof setInterval === 'function') setInterval(tick, 2000);

  const api = { version: '1.0.0', detect, tree, flash, exportScene, _internal: { exportToBlob, buildIR, gltfFromIR } };
  Object.defineProperty(W, '__T3X__', { value: api, configurable: true, enumerable: false, writable: false });
})();
