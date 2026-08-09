import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { LEVELUP_IMAGES } from '../ui/levelUpImages.js';
import { hexMetrics, hexCenter, hexCellAt, hexRing, hexTileTransform } from './hexLattice.js';

// A throwaway alignment check for the hex backdrop: X drops a cluster of seven
// hex tiles onto the cells around the player and keeps them there as you move,
// so you can see whether the drawn art lands on the drawn grid lines. Nothing
// here is persisted and nothing else in the game reads it — it exists to
// answer "does it line up" before any of it becomes a real tile layer.
//
// It shares hexLattice with the grid itself, so if the tiles are off, the maths
// is wrong for both — they can't drift apart independently.

const TILE_COUNT = 7; // centre cell + its six neighbours

// Seven visibly different tiles, so seams between neighbours are obvious.
const TILE_KEYS = [
  'Reef_001', 'Beach_001', 'TidePool_001', 'OpeanOcean_001',
  'DeepSea_001', 'Crab', 'SeaStar',
];

export function createHexTiles(scene) {
  const group = new THREE.Group();
  group.visible = false;
  group.position.z = -4.4; // just in FRONT of the grid at -4.5, so the lines
                           // read as sitting under the art's edges
  scene.add(group);

  const loader = new THREE.TextureLoader();
  const meshes = [];
  let built = 0; // spacing the geometry was built for; -1 forces a rebuild

  function build() {
    for (const mesh of meshes) {
      group.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.map?.dispose(); // build() reloads the textures, so the old
      mesh.material.dispose();      // ones have to go or a spacing slider leaks
    }
    meshes.length = 0;

    const m = hexMetrics(Math.max(0.5, CONFIG.grid.spacing));
    const t = hexTileTransform(m);

    for (let i = 0; i < TILE_COUNT; i++) {
      const key = TILE_KEYS[i % TILE_KEYS.length];
      const tex = loader.load(LEVELUP_IMAGES[key].src);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(t.planeW, t.planeH),
        new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          depthWrite: false,
          opacity: 0.9,
        })
      );
      group.add(mesh);
      meshes.push(mesh);
    }
    built = CONFIG.grid.spacing;
  }

  function update(playerPos) {
    if (!group.visible) return;
    if (built !== CONFIG.grid.spacing) build();

    const m = hexMetrics(Math.max(0.5, CONFIG.grid.spacing));
    const t = hexTileTransform(m);
    const home = hexCellAt(playerPos.x, playerPos.y, m);
    const cells = [home, ...hexRing(home.col, home.row, m)];

    for (let i = 0; i < meshes.length; i++) {
      const c = hexCenter(cells[i].col, cells[i].row, m);
      meshes[i].position.set(c.x + t.offsetX, c.y + t.offsetY, 0);
    }
  }

  function toggle() {
    group.visible = !group.visible;
    if (group.visible && !meshes.length) build();
    console.info(`[hexTiles] alignment overlay ${group.visible ? 'on' : 'off'}` +
      (CONFIG.grid.pattern === 'hex' ? '' : " — grid pattern is 'square', switch it to 'hex' in the ` tuner"));
    return group.visible;
  }

  function dispose() {
    for (const mesh of meshes) {
      mesh.geometry.dispose();
      mesh.material.map?.dispose();
      mesh.material.dispose();
    }
    meshes.length = 0;
    scene.remove(group);
  }

  return { toggle, update, dispose, get visible() { return group.visible; } };
}
