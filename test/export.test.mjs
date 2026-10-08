// Runs the page script against real three.js in Node and validates the glTF output.
import fs from 'fs';
import vm from 'vm';
import assert from 'assert/strict';
import { fileURLToPath } from 'url';
import path from 'path';
import validator from 'gltf-validator';

const here = path.dirname(fileURLToPath(import.meta.url));
globalThis.window = globalThis;
globalThis.location = { href: 'http://test.local/', hostname: 'test.local' };
globalThis.document = { title: 't', createElement: () => ({}), body: {} };
globalThis.FileReader = class {
  readAsDataURL(b) {
    b.arrayBuffer().then((ab) => {
      this.result = 'data:' + (b.type || 'application/octet-stream') + ';base64,' + Buffer.from(ab).toString('base64');
      this.onload();
    });
  }
};

// install the hook BEFORE three is imported, exactly like the content script does
vm.runInThisContext(fs.readFileSync(path.join(here, '../extension/inject.js'), 'utf8'));
const THREE = await import('three');
const T3X = globalThis.__T3X__;

const scene = new THREE.Scene();
scene.name = 'TestScene';
const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0xff3300 }));
box.name = 'RedBox'; box.position.set(2, 0, 0); scene.add(box);
const group = new THREE.Group(); group.name = 'Group'; group.scale.setScalar(2); scene.add(group);
const sph = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), [
  new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
  new THREE.MeshPhongMaterial({ color: 0x0000ff, transparent: true, opacity: 0.5 })
]);
sph.geometry.clearGroups(); sph.geometry.addGroup(0, 300, 0); sph.geometry.addGroup(300, sph.geometry.index.count - 300, 1);
group.add(sph);
const inst = new THREE.InstancedMesh(new THREE.ConeGeometry(0.3, 1, 8), new THREE.MeshStandardMaterial(), 4);
const m4 = new THREE.Matrix4();
for (let i = 0; i < 4; i++) { m4.makeTranslation(i, 3, 0); inst.setMatrixAt(i, m4); }
scene.add(inst);
const hidden = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()); hidden.visible = false; scene.add(hidden);
const g = new THREE.BufferGeometry();
g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
const tri = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ side: THREE.DoubleSide })); tri.scale.x = -1; scene.add(tri);
scene.updateMatrixWorld(true);

const d = T3X.detect();
assert.equal(d.sources.length, 1, 'scene should be detected via the devtools hook');
assert.equal(d.sources[0].meshes, 5);
const id = d.sources[0].id;
assert.equal(T3X.tree(id, null).items.length, 5);

for (const f of ['glb', 'gltf', 'obj', 'stl', 'json']) {
  const r = await T3X._internal.exportToBlob(id, [], f, { zUp: f === 'stl' });
  const buf = new Uint8Array(await r.blob.arrayBuffer());
  assert.ok(buf.length > 0, f + ' is empty');
  if (f !== 'json') assert.equal(r.meshes, 7, f + ' mesh count (5 meshes + 3 extra cone instances - 1 hidden)');
  if (f === 'glb' || f === 'gltf') {
    const rep = await validator.validateBytes(buf, { uri: r.filename, externalResourceFunction: null });
    assert.equal(rep.issues.numErrors, 0, f + ' validator errors: ' + JSON.stringify(rep.issues.messages));
    assert.equal(rep.issues.numWarnings, 0, f + ' validator warnings');
  }
  if (f === 'stl') {
    const n = new DataView(buf.buffer).getUint32(80, true);
    assert.equal(buf.length, 84 + 50 * n, 'STL size matches triangle count');
  }
  console.log('ok', f, r.filename, buf.length + ' bytes');
}

const sel = await T3X._internal.exportToBlob(id, [group.uuid], 'glb', {});
assert.equal(sel.meshes, 1, 'subtree selection');
const withHidden = await T3X._internal.exportToBlob(id, [], 'glb', { includeHidden: true });
assert.equal(withHidden.meshes, 8, 'hidden objects included on request');
console.log('All tests passed');
process.exit(0);
