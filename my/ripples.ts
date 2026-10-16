/*
 * ripples: rings spreading from two drops and crossing. Made from nothing
 * but the piece contract, with no kit: `meta` says its size and speed, and
 * the default function returns the picture at t seconds, as `rows` lines of
 * `cols` characters. Every piece in the library is written this way.
 *
 * It has no colours of its own, so it is drawn in one ink: --fg sets it.
 */
import type { Frame, Meta } from "ascii.rest";

export const meta = {
  name: "ripples",
  category: "generative",
  note: "rings spreading from two drops and crossing",
  cols: 192,
  rows: 54,
  fps: 12,
} satisfies Meta;

const RAMP = " .·:-=+*#%@";

// One drop's rings at `d` columns from it: crests moving outward, fainter the further they go.
const rings = (d: number, t: number) => Math.max(0, Math.sin(d * 0.22 - t * 1.4)) ** 3 * Math.max(0, 1 - d / 120);

export default function ripples(): Frame {
  const { cols, rows } = meta;
  const lines: string[] = new Array(rows);

  return (t) => {
    for (let y = 0; y < rows; y++) {
      let line = "";
      for (let x = 0; x < cols; x++) {
        // a character is twice as tall as it is wide, so a row counts as two columns
        const a = Math.hypot(x - cols * 0.3, (y - rows * 0.42) * 2);
        const b = Math.hypot(x - cols * 0.72, (y - rows * 0.6) * 2);
        const v = Math.min(1, rings(a, t) + rings(b, t + 1.7));
        line += RAMP[Math.round(v * (RAMP.length - 1))];
      }
      lines[y] = line;
    }
    return lines.join("\n");
  };
}
