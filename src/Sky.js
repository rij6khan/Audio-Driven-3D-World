import * as THREE from 'three';

/**
 * The sun, the moon and the stars.
 *
 * They are fixed in the world relative to the starting point: their directions are measured from the start of the road,
 * facing down it. They are also so far away that driving never brings you closer, so the sky group follows the camera's
 * POSITION but never its ROTATION. They don't slide across the screen with the camera; they turn with the terrain, so a
 * bend in the road swings the sun across the view exactly as it swings the landscape.
 *
 * Day has the sun, night the moon and stars. Weather, fog and forest cover can hide them (`clear`, 0..1), but whether the
 * sky looks like day or night never depends on whether they can be seen (that is set by the caller from day/night alone).
 */
export const SKY = {
  radius: 1100,                                    // inside the camera's far plane, beyond all terrain that can occlude it
  sun: { azimuth: 40, elevation: 40, size: 15.6 }, // degrees; azimuth is positive to the right of the road's starting direction
  moon: { azimuth: -35, elevation: 42, size: 15.6 },
  stars: { count: 1600, minElevation: 8 },
};

// Direction (unit vector) of a point at the given azimuth and elevation, in world coordinates (the road starts out along +z, left is +x).
export function skyDirection(azimuthDeg, elevationDeg) {
  const a = (azimuthDeg * Math.PI) / 180, e = (elevationDeg * Math.PI) / 180;
  return { x: -Math.sin(a) * Math.cos(e), y: Math.sin(e), z: Math.cos(a) * Math.cos(e) };
}

// A radial gradient texture from [position 0..1, css color] stops (null where there is no canvas to draw it on).
function radialTexture(stops) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const g = canvas.getContext('2d');
  if (!g) return null;
  const gradient = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  stops.forEach(([at, color]) => gradient.addColorStop(at, color));
  g.fillStyle = gradient;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

export function createSky(scene) {
  const group = new THREE.Group();
  const body = (spec, color, toneMapped = true) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(spec.size, 24, 16), new THREE.MeshBasicMaterial({ color, fog: false, transparent: true, toneMapped }));
    const d = skyDirection(spec.azimuth, spec.elevation);
    mesh.position.set(d.x * SKY.radius, d.y * SKY.radius, d.z * SKY.radius);
    group.add(mesh);
    return mesh;
  };
  const moon = body(SKY.moon, 0xe8eefc);

  // The sun as an ordinary photo shows it: a flat, clipped-white disk (no color, no detail) with a soft bloom just outside
  // its edge. GLOW is how far the bloom reaches beyond the disk, as a share of the disk's diameter.
  const GLOW = 0.5;
  const DISK = 1 / (1 + 2 * GLOW); // the disk's radius as a share of the sprite's
  const along = f => DISK + (1 - DISK) * f; // a point f of the way from the disk's edge to the bloom's end
  const sunMap = radialTexture([
    [0, 'rgba(255,255,255,1)'], [DISK - 0.01, 'rgba(255,255,255,1)'], [DISK + 0.01, 'rgba(255,255,255,0.75)'],
    [along(0.3), 'rgba(255,255,255,0.4)'], [along(0.65), 'rgba(255,255,255,0.14)'], [1, 'rgba(255,255,255,0)'],
  ]);
  const disk = sunMap && new THREE.Sprite(new THREE.SpriteMaterial({ map: sunMap, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
  if (disk) {
    const d = skyDirection(SKY.sun.azimuth, SKY.sun.elevation), size = (SKY.sun.size / DISK) * 2;
    disk.position.set(d.x * SKY.radius, d.y * SKY.radius, d.z * SKY.radius);
    disk.scale.set(size, size, 1);
    group.add(disk);
  }

  // Stars: the same ones every time, spread evenly over the part of the sky above the horizon haze.
  let state = 20241031;
  const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
  const positions = new Float32Array(SKY.stars.count * 3), colors = new Float32Array(SKY.stars.count * 3);
  const lowest = Math.sin((SKY.stars.minElevation * Math.PI) / 180);
  for (let i = 0; i < SKY.stars.count; i++) {
    const y = lowest + (1 - lowest) * random(), ring = Math.sqrt(1 - y * y), phi = random() * Math.PI * 2;
    positions.set([ring * Math.cos(phi) * SKY.radius, y * SKY.radius, ring * Math.sin(phi) * SKY.radius], i * 3);
    const b = 0.5 + 0.5 * random(), tint = 0.9 + 0.2 * random();
    colors.set([b, b, b * tint], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const stars = new THREE.Points(geometry, new THREE.PointsMaterial({
    size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, fog: false,
  }));
  stars.frustumCulled = false;
  group.add(stars);
  scene.add(group);

  const show = (object, opacity) => { object.visible = opacity > 0.02; object.material.opacity = opacity; };
  return {
    group,
    // night: 0 = day .. 1 = night (fractional only while one piece of a compilation hands over to the next).
    // clear: how much of the sky can be seen (weather, fog and forest cover lower it).
    update(camera, { night, clear }) {
      group.position.copy(camera.position); // follow the camera's position only; never its rotation
      if (disk) show(disk, (1 - night) * clear);
      show(moon, night * clear);
      show(stars, night * clear);
    },
  };
}
