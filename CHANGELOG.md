# Changelog

## 1.0.0
- Detect three.js scenes via the `__THREE_DEVTOOLS__` hook and a global scan; iframes supported.
- Scene/object browser with per-object selection and wireframe flash.
- Export to GLB, GLTF, OBJ (+MTL +textures, zipped), STL and three.js JSON.
- Handles InstancedMesh, multi-material meshes, vertex colors, textures, skinned/morphed pose baking.
- Toolbar badge with the number of detected scenes.
