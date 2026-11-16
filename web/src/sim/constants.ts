// Real-world dimensions in meters.
export const PITCH = { halfLength: 52.5, halfWidth: 34 } as const;
export const GOAL = { halfWidth: 3.66, height: 2.44, depth: 2.0, postRadius: 0.06 } as const;
export const BOX = { depth: 16.5, halfWidth: 20.16 } as const;

export const BALL_RADIUS = 0.11;
export const GRAVITY = 9.81;
/** Simulation tick. Rendering runs at whatever rate the device allows. */
export const DT = 1 / 60;
