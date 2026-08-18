# Textures

Files here are served from the site root: `public/textures/trail.png` is
`/textures/trail.png`.

Nothing loads textures yet — the current art is untextured neon geometry. When
you want sprites or texture maps, load them with `THREE.TextureLoader` inside
`path/src/assets.js` alongside the model loading, so they get the same
preload-and-fallback treatment.
