export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function pixelDiff(
  a: Uint8ClampedArray | Uint8Array,
  b: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts?: { threshold?: number; exact?: boolean; mask?: PixelBox[]; ignore?: Uint8Array | null },
): { diff: number; aa: number; moving: number; kinds: Uint8Array };
