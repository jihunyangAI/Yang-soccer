import * as THREE from 'three';
import { BOX, GOAL, PITCH } from '../sim/constants';

/** Grass + markings drawn to a canvas. Covers the pitch plus a 6 m margin. */
export const PITCH_PLANE = { halfLength: PITCH.halfLength + 6, halfWidth: PITCH.halfWidth + 6 };

export function makePitchTexture(maxAniso: number): THREE.CanvasTexture {
  const PX = 16; // pixels per meter
  const W = PITCH_PLANE.halfLength * 2;
  const H = PITCH_PLANE.halfWidth * 2;
  const c = document.createElement('canvas');
  c.width = W * PX; c.height = H * PX;
  const g = c.getContext('2d')!;
  const X = (x: number) => (x + PITCH_PLANE.halfLength) * PX;
  const Z = (z: number) => (z + PITCH_PLANE.halfWidth) * PX;

  g.fillStyle = '#2f7d3b';
  g.fillRect(0, 0, c.width, c.height);
  // Mowing stripes, 5.25 m wide (20 across the pitch length).
  const stripe = (PITCH.halfLength * 2) / 20;
  for (let i = 0; i < 20; i++) {
    g.fillStyle = i % 2 ? '#368a43' : '#2c7638';
    g.fillRect(X(-PITCH.halfLength + i * stripe), Z(-PITCH.halfWidth), stripe * PX + 1, PITCH.halfWidth * 2 * PX);
  }
  // Subtle grass noise.
  const img = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);

  g.strokeStyle = 'rgba(255,255,255,0.92)';
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.lineWidth = 0.12 * PX;
  const hl = PITCH.halfLength, hw = PITCH.halfWidth;
  const rect = (x0: number, z0: number, x1: number, z1: number) =>
    g.strokeRect(X(x0), Z(z0), (x1 - x0) * PX, (z1 - z0) * PX);
  const circle = (x: number, z: number, r: number, a0 = 0, a1 = Math.PI * 2) => {
    g.beginPath(); g.arc(X(x), Z(z), r * PX, a0, a1); g.stroke();
  };
  const spot = (x: number, z: number) => {
    g.beginPath(); g.arc(X(x), Z(z), 0.2 * PX, 0, Math.PI * 2); g.fill();
  };

  rect(-hl, -hw, hl, hw);
  g.beginPath(); g.moveTo(X(0), Z(-hw)); g.lineTo(X(0), Z(hw)); g.stroke();
  circle(0, 0, 9.15);
  spot(0, 0);
  for (const s of [-1, 1]) {
    const line = s * hl;
    rect(Math.min(line, line - s * BOX.depth), -BOX.halfWidth, Math.max(line, line - s * BOX.depth), BOX.halfWidth);
    rect(Math.min(line, line - s * 5.5), -(GOAL.halfWidth + 5.5), Math.max(line, line - s * 5.5), GOAL.halfWidth + 5.5);
    const px = line - s * 11;
    spot(px, 0);
    // Penalty arc: the part of the 9.15 m circle outside the box.
    const a = Math.acos((BOX.depth - 11) / 9.15);
    if (s > 0) circle(px, 0, 9.15, Math.PI - a, Math.PI + a);
    else circle(px, 0, 9.15, -a, a);
    for (const zs of [-1, 1]) {
      const start = s > 0 ? (zs > 0 ? Math.PI : Math.PI / 2) : (zs > 0 ? Math.PI * 1.5 : 0);
      circle(line, zs * hw, 1, start, start + Math.PI / 2);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

/** Equirectangular ball texture: white with dark panels. */
export function makeBallTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f4f4f0';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#1d1f24';
  const t = (1 + Math.sqrt(5)) / 2;
  const verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  for (const [x, y, z] of verts) {
    const len = Math.hypot(x, y, z);
    const lat = Math.asin(y / len);
    const lon = Math.atan2(z, x);
    const u = ((lon / (Math.PI * 2)) + 0.5) * 256;
    const v = (0.5 - lat / Math.PI) * 128;
    const stretch = 1 / Math.max(0.35, Math.cos(lat));
    for (const du of [-256, 0, 256]) {
      g.beginPath();
      g.ellipse(u + du, v, 13 * stretch, 13, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Crowd: dense colored dots on a dark stand. */
export function makeCrowdTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2a2f3a';
  g.fillRect(0, 0, c.width, c.height);
  const colors = ['#d8dde6', '#3a6fe0', '#e04b3a', '#f0c24a', '#8d96a8', '#1f2a44', '#f5f5f5'];
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = colors[(Math.random() * colors.length) | 0];
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 2, 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}
