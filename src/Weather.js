import * as THREE from 'three';

/**
 * Falling particles around the camera: snow, rain and blowing dust. Each kind has an intensity (0..1) set by the
 * biome the car is in, so weather changes as the music's biome does: the intensity decides how many of the layer's
 * particles are showing, and it fades gradually.
 *
 * Each kind is drawn so it reads as itself: snow is small soft round flakes drifting down, rain is thin fast
 * streaks, dust is a faint warm haze blowing sideways.
 */
const LAYERS = {
  snow: { count: 2400, size: 0.22, color: 0xffffff, opacity: 0.95, fall: 3.5, wind: 1.5, sway: 1.4, soft: true },
  rain: { count: 5000, color: 0xb9d0e0, opacity: 0.5, fall: 32, wind: -5, sway: 0, streak: 0.035 },  // streak: seconds of travel drawn as a line
  dust: { count: 1500, size: 1.6, color: 0xd9bd88, opacity: 0.1, fall: -0.2, wind: 13, sway: 0.8, soft: true },
};
const BOX = { x: 120, y: 50, z: 140, below: 17 }; // particles live in this box around the camera and wrap around it

// A small soft round dot, so flakes and haze aren't hard-edged squares. (No texture where there is no canvas, e.g. in tests.)
function softDot() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return null;
  canvas.width = canvas.height = 32;
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.7)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(canvas);
}

export function createWeather(scene) {
  const dot = softDot();
  const layers = {};
  for (const [name, spec] of Object.entries(LAYERS)) {
    const positions = new Float32Array(spec.count * 3); // where each particle is
    for (let i = 0; i < spec.count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * BOX.x;
      positions[i * 3 + 1] = Math.random() * BOX.y - BOX.below;
      positions[i * 3 + 2] = (Math.random() - 0.5) * BOX.z;
    }
    const geometry = new THREE.BufferGeometry();
    let vertices = null, object;
    if (spec.streak) {
      // Rain: each drop is a short line from its tail (where it just was) to its head.
      vertices = new Float32Array(spec.count * 6);
      geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      object = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: spec.color, transparent: true, opacity: spec.opacity, depthWrite: false }));
    } else {
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      object = new THREE.Points(geometry, new THREE.PointsMaterial({
        color: spec.color, size: spec.size, transparent: true, opacity: spec.opacity, depthWrite: false, sizeAttenuation: true,
        map: spec.soft ? dot : null,
      }));
    }
    object.frustumCulled = false; // the particles move with the camera, so a fixed bounding box would be wrong
    object.visible = false;
    scene.add(object);
    layers[name] = { spec, points: object, geometry, positions, vertices, level: 0 };
  }

  let clock = 0;
  return {
    // `target` = { snow, rain, dust }, each 0..1
    update(dt, camera, target) {
      clock += dt;
      for (const name in layers) {
        const layer = layers[name], { spec, positions, vertices } = layer;
        layer.level += (Math.min(1, Math.max(0, target[name] ?? 0)) - layer.level) * (1 - Math.exp(-dt * 0.8));
        const shown = Math.floor(spec.count * layer.level);
        layer.points.visible = shown > 20;
        if (!layer.points.visible) continue;
        layer.geometry.setDrawRange(0, spec.streak ? shown * 2 : shown);
        layer.points.position.copy(camera.position);
        for (let i = 0; i < shown; i++) {
          const k = i * 3;
          let x = positions[k] + (spec.wind + spec.sway * Math.sin(clock * 0.7 + i)) * dt;
          let y = positions[k + 1] - spec.fall * dt;
          let z = positions[k + 2] + spec.sway * 0.5 * Math.cos(clock * 0.5 + i * 1.3) * dt;
          if (y < -BOX.below) y += BOX.y; else if (y > BOX.y - BOX.below) y -= BOX.y;
          if (x < -BOX.x / 2) x += BOX.x; else if (x > BOX.x / 2) x -= BOX.x;
          if (z < -BOX.z / 2) z += BOX.z; else if (z > BOX.z / 2) z -= BOX.z;
          positions[k] = x; positions[k + 1] = y; positions[k + 2] = z;
          if (vertices) {
            const v = i * 6; // head, then tail one streak-length back along the drop's path
            vertices[v] = x; vertices[v + 1] = y; vertices[v + 2] = z;
            vertices[v + 3] = x - spec.wind * spec.streak; vertices[v + 4] = y + spec.fall * spec.streak; vertices[v + 5] = z;
          }
        }
        layer.geometry.getAttribute('position').needsUpdate = true;
      }
    },
  };
}
