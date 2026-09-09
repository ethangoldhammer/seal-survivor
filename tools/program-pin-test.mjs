#!/usr/bin/env node
// ---------------------------------------------------------------------------
// npm run test:pin
//
// three refcounts compiled programs and DELETES one the moment the last
// material using it is disposed, so a family of materials that all die together
// takes its shader with it and the next one of that kind re-links on the frame
// it appears. `npm run perf` measured that as roughly half of every mid-run
// program link in a real run — 113 rebuilds against 130 distinct keys.
//
// systems/programPin.js keeps the last material of each family alive instead.
// This file guards the three ways that goes wrong, all of them silent:
//
//   PINNING NOTHING     a material no renderer ever claimed owns no program,
//                       so pinning it fills the family's one slot with a
//                       decoy and leaves the churn exactly where it was.
//   PINNING EVERYTHING  a family key that varies per instance pins every
//                       material ever made, which is a leak with no error.
//   PINNING TOO COARSE  two genuinely different programs sharing one slot
//                       means one of them still churns.
//
//   node --import ./tools/vite-loader.mjs tools/program-pin-test.mjs
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import {
  retireMaterial, materialFamily, pinnedProgramCount, clearProgramPins,
} from '../path/src/systems/programPin.js';

let failures = 0;
const section = (n) => console.log(`\n${n}`);
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

// What three does the first time it builds a program for a material: hangs its
// own 'dispose' listener on it. That listener is the only signal a teardown
// path has that there is a compiled program to protect, so the fake renderer
// here is exactly one line long.
const claim = (m) => { m.addEventListener('dispose', () => {}); return m; };

// Wraps the METHOD rather than listening for the event, because a listener is
// the very thing `claim` above is faking — a spy that subscribed would make
// every material it watched look like one the renderer had claimed, and the
// "never drawn" case would then pass for the wrong reason.
const disposed = (m) => {
  let hit = false;
  const real = m.dispose.bind(m);
  m.dispose = () => { hit = true; real(); };
  return () => hit;
};

// ===========================================================================
section('It keeps the first of a family and disposes the rest');
clearProgramPins();
{
  const make = () => claim(new THREE.MeshBasicMaterial({
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));

  const first = make();
  const wasDisposed = disposed(first);
  check('first is kept', retireMaterial(first) === false);
  check('...and really was not disposed', !wasDisposed());
  check('one family pinned', pinnedProgramCount() === 1, `${pinnedProgramCount()}`);

  // Nine more bombs' worth. Every one of these is the case that used to re-link.
  let allDisposed = true;
  for (let i = 0; i < 9; i++) {
    const m = make();
    const gone = disposed(m);
    if (retireMaterial(m) !== true || !gone()) allDisposed = false;
  }
  check('the other nine are disposed', allDisposed);
  check('still one family pinned', pinnedProgramCount() === 1, `${pinnedProgramCount()}`);
}

// ===========================================================================
section('A material no renderer claimed is disposed, never pinned');
clearProgramPins();
{
  // No `claim` — this is every Node harness, and a material built and thrown
  // away before it was ever drawn.
  const m = new THREE.MeshBasicMaterial({ transparent: true });
  const gone = disposed(m);
  check('disposed', retireMaterial(m) === true && gone());
  check('nothing pinned', pinnedProgramCount() === 0, `${pinnedProgramCount()}`);

  // ...and the slot is still free for one that IS worth pinning.
  const real = claim(new THREE.MeshBasicMaterial({ transparent: true }));
  check('a claimed one of the same family still pins', retireMaterial(real) === false);
  check('one family pinned', pinnedProgramCount() === 1, `${pinnedProgramCount()}`);
}

// ===========================================================================
section('Families that three would compile separately are pinned separately');
clearProgramPins();
{
  const variants = [
    new THREE.MeshBasicMaterial({}),
    new THREE.MeshBasicMaterial({ transparent: true }),
    new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending }),
    new THREE.MeshBasicMaterial({ vertexColors: true }),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    new THREE.MeshBasicMaterial({ alphaTest: 0.5 }),
    new THREE.MeshBasicMaterial({ map: new THREE.Texture() }),
    new THREE.MeshStandardMaterial({}),
    new THREE.MeshLambertMaterial({}),
  ];
  const keys = new Set(variants.map(materialFamily));
  check('every variant is its own family', keys.size === variants.length,
    `${keys.size} of ${variants.length}`);

  for (const v of variants) retireMaterial(claim(v));
  check('all pinned', pinnedProgramCount() === variants.length, `${pinnedProgramCount()}`);
}

// ===========================================================================
section('customProgramCacheKey splits a family, as it does in three');
clearProgramPins();
{
  // The tags the game actually installs — bioSkin, grassSway, hotSpotSkin and
  // the rest. Two materials of the same type with different tags are two
  // programs, and a pin that lumped them would leave one of them re-linking.
  const tagged = (tag) => {
    const m = new THREE.MeshBasicMaterial({ transparent: true });
    m.customProgramCacheKey = () => tag;
    return claim(m);
  };
  retireMaterial(tagged('hotSpotSkin'));
  retireMaterial(tagged('grassSway'));
  check('two tags, two pins', pinnedProgramCount() === 2, `${pinnedProgramCount()}`);
  check('the same tag again is disposed', retireMaterial(tagged('grassSway')) === true);
  check('still two', pinnedProgramCount() === 2, `${pinnedProgramCount()}`);

  // A tag that throws must not take a teardown path down with it.
  const angry = new THREE.MeshBasicMaterial({});
  angry.customProgramCacheKey = () => { throw new Error('nope'); };
  let threw = false;
  try { retireMaterial(claim(angry)); } catch { threw = true; }
  check('a throwing tag is survivable', !threw);
}

// ===========================================================================
section('ShaderMaterials are split by their source, not lumped as one type');
clearProgramPins();
{
  const shader = (frag) => claim(new THREE.ShaderMaterial({
    vertexShader: 'void main(){gl_Position=vec4(position,1.0);}',
    fragmentShader: frag,
  }));
  retireMaterial(shader('void main(){gl_FragColor=vec4(1.0);}'));
  retireMaterial(shader('void main(){gl_FragColor=vec4(0.5);}'));
  check('two sources, two pins', pinnedProgramCount() === 2, `${pinnedProgramCount()}`);
  check('the same source again is disposed',
    retireMaterial(shader('void main(){gl_FragColor=vec4(0.5);}')) === true);
}

// ===========================================================================
section('A pinned material lets go of its textures');
clearProgramPins();
{
  // The cost of a pin is one material forever, and a pinned boss hide holding a
  // 1024-square compressed map for the session would be a worse bug than the
  // one being fixed. The SLOT has to stay filled — three keys the program on
  // whether there was a map — but the image does not.
  const tex = new THREE.Texture();
  const m = claim(new THREE.MeshStandardMaterial({ map: tex, normalMap: new THREE.Texture() }));
  const family = materialFamily(m);
  retireMaterial(m);
  check('the texture is released', m.map !== tex && m.normalMap !== null);
  check('the slot is still filled', !!m.map && !!m.normalMap);
  check('so the family it stands for is unchanged', materialFamily(m) === family);
}

// ===========================================================================
section('An array of materials is handled, not silently skipped');
clearProgramPins();
{
  // A multi-material mesh is exactly the case where forgetting this leaves half
  // the programs churning and nothing says so.
  const a = claim(new THREE.MeshBasicMaterial({ transparent: true }));
  const b = claim(new THREE.MeshLambertMaterial({}));
  retireMaterial([a, b]);
  check('both pinned', pinnedProgramCount() === 2, `${pinnedProgramCount()}`);
  check('null and undefined are no-ops',
    retireMaterial(null) === false && retireMaterial(undefined) === false);
}

console.log(`\n${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
