# Audio World — Three.js procedural generation demo

A Vite + Three.js prototype that builds a navigable landscape from **fake normalized audio features**. It includes audio-driven terrain elevation, a winding road, deterministic tree/rock placement, a follow camera, and a small HUD.

## Run it

Requirements: Node.js 20.19+ or 22.12+ recommended.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. To make a production build:

```bash
npm run build
npm run preview
```

## Controls

- `W` / `↑`: move forward
- `S` / `↓`: move backward
- `A`: move right; `D`: move left
- `←`: move left; `→`: move right
- `R`: reset to the start
- **Pause journey**: pause/resume the simulated traversal

The demo does not play real audio yet; its fake feature timeline drives the terrain and HUD as the player travels.

## Project structure

- `src/audioData.js`: fake feature data and interpolation. This is the interface to replace when your audio-analysis teammate's code is ready.
- `src/noise.js`: deterministic smooth value noise.
- `src/TerrainGenerator.js`: terrain grid, audio-to-height mapping, and road-side valley.
- `src/RoadGenerator.js`: road centerline and road mesh.
- `src/PropGenerator.js`: procedural tree and rock placement.
- `src/main.js`: scene setup, controls, world assembly, and camera.

## Fake audio data contract

`makeFakeAudioFeatures()` returns:

```js
{
  duration: 48,
  samples: [
    { time: 0, volume: 0.3, pitch: 0.6, energy: 0.4 },
    // ...time increases; features are normalized to [0, 1]
  ]
}
```

Each feature sample is linearly interpolated by `sampleAudioFeatures(features, time)`.

### Connecting real audio features later

Keep the object shape above if possible. If your teammate outputs a differently shaped array, adapt it once in `audioData.js`; terrain and road code should not need to change. `volume` mainly controls terrain height, `energy` controls terrain roughness and additional road bends, and `pitch` influences road curvature.

## Tuning the generator

- `src/RoadGenerator.js` → `WORLD`: world dimensions and mesh resolution.
- `TerrainGenerator.js` → `broadHeight`, `rolling`, `detail`: hill size and roughness.
- `roadCenterX()` → `base` and `audioBend`: winding and audio sensitivity.
- `roadElevationY()` → `broadHill` and `rollingHill`: the road's forward-facing rises and dips.
- `PropGenerator.js` → loop counts: density of trees and rocks.

## Notes

This is a starter implementation, not a production-optimized open world. The terrain is generated as one mesh, and scenery is intentionally simple. For a stronger final demo, consider chunking very large worlds, adding a road shoulder/edge line, improving collision and camera handling, and adding real audio playback synchronized to the world position.
