/** Player skeleton: bind pose in metres, facing +x, left = −z. */
export const B = {
  Root: 0, Hips: 1, Spine: 2, Chest: 3, Neck: 4, Head: 5,
  ArmL: 6, ElbowL: 7, ArmR: 8, ElbowR: 9,
  ThighL: 10, KneeL: 11, AnkleL: 12, ThighR: 13, KneeR: 14, AnkleR: 15,
} as const;

export const BONES: { parent: number; at: [number, number, number] }[] = [
  { parent: -1, at: [0, 0, 0] },
  { parent: B.Root, at: [0, 0.95, 0] },
  { parent: B.Hips, at: [0, 1.05, 0] },
  { parent: B.Spine, at: [0, 1.3, 0] },
  { parent: B.Chest, at: [0, 1.52, 0] },
  { parent: B.Neck, at: [0, 1.6, 0] },
  { parent: B.Chest, at: [0, 1.44, -0.23] },
  { parent: B.ArmL, at: [0, 1.15, -0.245] },
  { parent: B.Chest, at: [0, 1.44, 0.23] },
  { parent: B.ArmR, at: [0, 1.15, 0.245] },
  { parent: B.Hips, at: [0, 0.92, -0.1] },
  { parent: B.ThighL, at: [0, 0.5, -0.1] },
  { parent: B.KneeL, at: [0, 0.08, -0.1] },
  { parent: B.Hips, at: [0, 0.92, 0.1] },
  { parent: B.ThighR, at: [0, 0.5, 0.1] },
  { parent: B.KneeR, at: [0, 0.08, 0.1] },
];

export const HIP_Y = 0.95;
/** Thigh joint relative to the hips bone, thigh and shin lengths, ankle height when standing. */
export const LEG = { hipDrop: 0.03, hipHalf: 0.1, thigh: 0.42, shin: 0.42, ankle: 0.08 };
