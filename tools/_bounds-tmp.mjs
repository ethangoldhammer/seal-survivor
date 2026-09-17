import './dom-stub.mjs';
import { bounds, updateBounds, seabedTopY } from '../path/src/arena.js';
updateBounds();
console.log(JSON.stringify({left:bounds.left,right:bounds.right,top:bounds.top,bottom:bounds.bottom,surfaceY:bounds.surfaceY}, null, 0));
console.log('width', (bounds.right-bounds.left).toFixed(1), 'height', (bounds.surfaceY-bounds.bottom).toFixed(1));
console.log('corner-to-corner', Math.hypot(bounds.right-bounds.left, bounds.surfaceY-bounds.bottom).toFixed(1));
