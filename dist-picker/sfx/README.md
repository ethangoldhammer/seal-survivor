# Sound effects

Every sound is synthesised by default, so this folder can stay empty.

To use a real file, drop it here and point the matching entry in `CONFIG.sfx`
at it:

```js
kill: { src: '/sfx/kill.wav', type: 'boom', freq: [220, 50], decay: 0.34, gain: 0.34 },
```

The synth settings stay as the fallback: if the file 404s or fails to decode,
the game logs a warning and uses the synthesised version instead — the same
pattern the model loader uses.
