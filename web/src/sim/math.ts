// Pure math helpers. The simulation uses meters and seconds.
// World axes: x = pitch length (home attacks +x), z = pitch width, y = up.

export interface V2 { x: number; z: number }
export interface V3 { x: number; y: number; z: number }

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Rotate angle `from` toward `to` by at most `maxStep` radians. */
export function rotateToward(from: number, to: number, maxStep: number): number {
  const d = wrapAngle(to - from);
  if (Math.abs(d) <= maxStep) return to;
  return wrapAngle(from + Math.sign(d) * maxStep);
}

/** Frame-rate independent smoothing factor for exponential approach. */
export const smooth = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);
