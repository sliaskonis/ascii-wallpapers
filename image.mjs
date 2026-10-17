/*
 * asciiwall image: a picture as a piece of your own. ffmpeg reads it, whatever its format, at eight pixels a column
 * and sixteen a row. It is softened first, so hatching, screentone and noise don't average to a flat grey, and each
 * cell keeps three things: its tone, the contrast stretched; where the outline of a shape runs through it, the
 * outline's direction, drawn as | / - \; and in a picture with colour, which of a few colours it is nearest. The piece
 * holds those, a byte or two a cell, and draws them: a still, to set as it is or to make move.
 */
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

// A cell in pixels of the picture as it is read: a character is twice as tall as it is wide.
const CW = 8;
const CH = 16;
// The colours a piece can have, less a few for any you add to it.
const ROOM = 60;
// A picture whose cells differ from grey by less than this, on average, is drawn in greys.
const GREYISH = 0.05;

/** The picture's pixels, as RGBA: `cols` cells across, and as many rows as keep its shape. */
function read(file, cols, fail) {
  const size = `scale=w=${cols * CW}:h='max(1,round(${cols}*ih/iw/2))*${CH}':flags=area,format=rgba`;
  const run = spawnSync("ffmpeg", ["-loglevel", "error", "-i", file, "-frames:v", "1", "-vf", size, "-f", "image2pipe", "-c:v", "pam", "pipe:1"], { maxBuffer: 1 << 28 });
  if (run.error?.code === "ENOENT") fail("image reads pictures with ffmpeg: on Ubuntu, sudo apt install ffmpeg");
  if (run.status !== 0) fail(`ffmpeg could not read ${file}${run.stderr?.length ? `: ${run.stderr.toString().trim().split("\n").pop()}` : ""}`);
  const end = run.stdout.indexOf("ENDHDR\n") + 7;
  const head = run.stdout.subarray(0, end).toString();
  const width = +head.match(/WIDTH (\d+)/)[1];
  const height = +head.match(/HEIGHT (\d+)/)[1];
  return { width, height, rgba: run.stdout.subarray(end) };
}

/** A Gaussian blur of a channel `width` across, `sigma` pixels, the edge pixels standing in for those beyond them. */
function blur(channel, width, sigma) {
  if (sigma < 0.5) return channel;
  const height = channel.length / width;
  const r = Math.ceil(sigma * 3);
  const kernel = Float32Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const total = kernel.reduce((a, b) => a + b);
  const across = new Float32Array(channel.length);
  const out = new Float32Array(channel.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let k = -r; k <= r; k++) v += kernel[k + r] * channel[row + Math.min(width - 1, Math.max(0, x + k))];
      across[row + x] = v / total;
    }
  }
  // Down, a row at a time: each output row takes its share of the rows near it.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let k = -r; k <= r; k++) {
      const w = kernel[k + r] / total;
      const from = Math.min(height - 1, Math.max(0, y + k)) * width;
      for (let x = 0; x < width; x++) out[row + x] += w * across[from + x];
    }
  }
  return out;
}

/** Each cell's mean of a channel `width` across, CW by CH pixels a cell. */
function means(channel, width, cols) {
  const out = new Float32Array(channel.length / (CW * CH));
  for (let p = 0; p < channel.length; p++) out[Math.floor(p / width / CH) * cols + Math.floor((p % width) / CW)] += channel[p];
  return out.map((v) => v / (CW * CH));
}

/** The value below which p percent of values lie, between the two nearest as numpy's percentile does. */
function percentile(values, p) {
  const sorted = Float32Array.from(values).sort();
  const at = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(at);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (at - lo);
}

/**
 * The outlines: where a shape's edge runs through a cell, 1 to 4 for | / - \, from the structure tensor of the
 * channel's gradient summed over the cell. The `share` percent of cells where it changes most, in one direction more
 * than any other, keep theirs; the rest take 0.
 */
function outlines(channel, width, cols, share) {
  const height = channel.length / width;
  const edge = new Uint8Array(channel.length / (CW * CH));
  if (share <= 0) return edge;
  const jxx = new Float32Array(edge.length), jyy = new Float32Array(edge.length), jxy = new Float32Array(edge.length);
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1), down = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - 1), right = Math.min(width - 1, x + 1);
      const gx = (channel[y * width + right] - channel[y * width + left]) / (right - left);
      const gy = (channel[down * width + x] - channel[up * width + x]) / (down - up);
      const cell = Math.floor(y / CH) * cols + Math.floor(x / CW);
      jxx[cell] += gx * gx;
      jyy[cell] += gy * gy;
      jxy[cell] += gx * gy;
    }
  }
  const strength = jxx.map((xx, i) => Math.sqrt(xx + jyy[i]));
  const cut = percentile(strength, 100 - share);
  for (let i = 0; i < edge.length; i++) {
    const coherence = Math.sqrt((jxx[i] - jyy[i]) ** 2 + 4 * jxy[i] ** 2) / (jxx[i] + jyy[i] + 1e-12);
    if (strength[i] < cut || strength[i] === 0 || coherence <= 0.5) continue;
    // The gradient's direction, across the edge: 0 when it runs left to right, so the edge runs up and down.
    const angle = (0.5 * Math.atan2(2 * jxy[i], jxx[i] - jyy[i]) * 180) / Math.PI;
    edge[i] = Math.abs(angle) < 22.5 ? 1 : Math.abs(angle) > 67.5 ? 3 : angle > 0 ? 2 : 4;
  }
  return edge;
}

/** A random number from 0 to 1 that is the same every run, so a picture gives the same piece each time. */
const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), seed | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

/**
 * The picture's few colours, and each cell's: every cell's colour at its brightest, gathered into up to `k` by
 * k-means, the bright cells counting most since the dark ones are drawn faint or not at all. Fewer when the picture
 * has fewer.
 */
function palette(rgb, k) {
  const n = rgb.length / 3;
  const hue = new Float32Array(rgb.length);
  const weight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const top = Math.max(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]);
    weight[i] = top * top;
    for (let c = 0; c < 3; c++) hue[3 * i + c] = top > 0 ? rgb[3 * i + c] / top : 1;
  }
  const far = (i, centre) => (hue[3 * i] - centre[0]) ** 2 + (hue[3 * i + 1] - centre[1]) ** 2 + (hue[3 * i + 2] - centre[2]) ** 2;
  const nearest = (i, centres) => centres.reduce((best, centre, j) => (far(i, centre) < far(i, centres[best]) ? j : best), 0);
  // The first centre a cell picked by brightness, each next one by brightness and distance from those so far.
  const next = random(1);
  const pickBy = (score) => {
    const total = score.reduce((a, b) => a + b, 0);
    let at = next() * total, last = -1;
    for (let i = 0; i < n; i++) {
      if (score[i] <= 0) continue;
      last = i;
      if ((at -= score[i]) <= 0) return i;
    }
    return last;
  };
  const centres = [];
  for (let i = pickBy(weight); i >= 0 && centres.length < k; ) {
    centres.push([hue[3 * i], hue[3 * i + 1], hue[3 * i + 2]]);
    i = pickBy(weight.map((w, j) => w * Math.min(...centres.map((centre) => far(j, centre)))));
  }
  // A picture with nothing bright in it has no colour to go by: white, faint everywhere.
  if (!centres.length) centres.push([1, 1, 1]);
  const index = new Uint8Array(n);
  for (let round = 0; round < 20; round++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      index[i] = nearest(i, centres);
      const sum = sums[index[i]];
      for (let c = 0; c < 3; c++) sum[c] += weight[i] * hue[3 * i + c];
      sum[3] += weight[i];
    }
    sums.forEach((sum, j) => sum[3] > 0 && (centres[j] = sum.slice(0, 3).map((v) => v / sum[3])));
  }
  // Each colour at its brightest, its strongest channel full.
  const colors = centres.map((centre) => {
    const top = Math.max(...centre) || 1;
    return `#${centre.map((v) => Math.round((v / top) * 255).toString(16).padStart(2, "0")).join("")}`;
  });
  return { colors, index };
}

const base64 = (bytes) => Buffer.from(bytes).toString("base64");

/**
 * The piece for a picture, as the source of a .ts file, and what went into it. `colors` is how many to keep, 1 for
 * greys, or undefined to choose by the picture.
 */
export function picture(file, name, { cols, blur: soften, edges, colors, invert }, fail) {
  const { width, height, rgba } = read(file, cols, fail);
  const rows = height / CH;
  const n = width * height;
  // Each pixel over black, so a transparent one is dark and drawn as nothing; for a negative, inverted first.
  const lum = new Float32Array(n), top = new Float32Array(n), red = new Float32Array(n), green = new Float32Array(n), blue = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const alpha = rgba[4 * p + 3] / 255;
    const [r, g, b] = [0, 1, 2].map((c) => ((invert ? 255 - rgba[4 * p + c] : rgba[4 * p + c]) / 255) * alpha);
    red[p] = r;
    green[p] = g;
    blue[p] = b;
    lum[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    top[p] = Math.max(r, g, b);
  }
  const rgb = new Float32Array(cols * rows * 3);
  [means(red, width, cols), means(green, width, cols), means(blue, width, cols)].forEach((channel, c) => channel.forEach((v, i) => (rgb[3 * i + c] = v)));
  let colorful = 0;
  for (let i = 0; i < cols * rows; i++) colorful += Math.max(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]) - Math.min(rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]);
  const greys = colors === 1 || (colors === undefined && colorful / (cols * rows) < GREYISH);
  // In greys a cell's tone is its lightness; in colour its colour's brightness, so a deep blue is drawn as strong as
  // it looks, in blue.
  const channel = greys ? lum : top;

  const tone = means(blur(channel, width, soften * CW), width, cols);
  const lo = percentile(tone, 2);
  const hi = percentile(tone, 98);
  const stretched = tone.map((v) => (hi - lo > 1e-6 ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : v));
  const edge = outlines(blur(channel, width, soften * CW * 1.5), width, cols, edges);
  const cells = Uint8Array.from(stretched, (v, i) => edge[i] * 51 + Math.round(v * 50));
  const shades = greys ? { colors: ["#f4f4f9"] } : palette(rgb, colors ?? 6);
  const steps = Math.min(16, Math.floor(ROOM / shades.colors.length));

  const from = basename(file).replaceAll("*/", "*_/");
  const note = `made from ${basename(file)}`.slice(0, 72);
  const source = `/*
 * ${name}: made by asciiwall image from
 * ${from}
 *
 * Each of the picture's cells is stored at the bottom: its tone, the outline running through it if one does, and its
 * colour. Outlines are drawn as | / - \\, the rest from a ramp by tone, each in its colour, fainter for a darker cell.
 *
 * It holds the picture: if that is someone else's art, keep this file out of git, in .git/info/exclude.
 */
import { piece } from "ascii.rest/kit";

const COLS = ${cols};
const ROWS = ${rows};
// Light to dense: a bright cell takes a dense character.
const RAMP = " .:-=+*#%@";
const EDGE = " |/-\\\\";
// Above 1 darkens the middle tones, below 1 lightens them.
const CURVE = 1;
// The picture's colours at their brightest. Each fades to dark in STEPS steps, and a cell takes the step its tone
// does. A piece has up to 64 colours, so there is room for a few of your own after these.
const COLORS = ${JSON.stringify(shades.colors)};
const STEPS = ${steps};
const fade = (hex: string) => {
  const rgb = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
  return Array.from({ length: STEPS }, (_, i) => \`#\${rgb.map((c) => Math.round(c * (0.12 + (0.88 * i) / (STEPS - 1))).toString(16).padStart(2, "0")).join("")}\`);
};

export default piece(
  {
    name: ${JSON.stringify(name)},
    note: ${JSON.stringify(note)},
    category: "scenes",
    cols: COLS,
    rows: ROWS,
    // A still, drawn once: 12 or so to make it move.
    fps: 0,
    palette: COLORS.flatMap(fade),
  },
  {
    setup: () => {
      const bytes = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
      // A byte a cell: edge * 51 + tone, the edge 0 for none or 1 to 4 for | / - \\, the tone 0 to 50.
      const cells = bytes(PICTURE);
      const edge = cells.map((b) => Math.floor(b / 51));
      const tone = Float32Array.from(cells, (b) => ((b % 51) / 50) ** CURVE);
      // And a byte a cell for its colour, its place in COLORS: none for a picture in greys.
      const hue = HUES ? bytes(HUES) : new Uint8Array(cells.length);

      return (t, s) => {
        // t is the time in seconds. For a band of light sweeping across every 6 seconds, set fps to 12 and uncomment
        // these two lines.
        // const band = ((t / 6) % 1) * COLS;
        for (let i = 0; i < tone.length; i++) {
          // The cell's tone, 0 dark to 1 bright: change it here to make it move.
          let v = tone[i];
          // v += 0.6 * v * Math.exp(-((((i % COLS) - band) / 6) ** 2));
          v = Math.min(1, Math.max(0, v));
          const color = hue[i] * STEPS;
          if (edge[i]) s.put(i, EDGE.charCodeAt(edge[i]), color + Math.round(Math.max(0.55, v) * (STEPS - 1)));
          else {
            const c = Math.round(v * (RAMP.length - 1));
            if (c) s.put(i, RAMP.charCodeAt(c), color + Math.round(v * (STEPS - 1)));
          }
        }
      };
    },
  },
);

// The picture's cells, row by row, as base64: a byte each for its tone and outline, and one for its colour.
const PICTURE = "${base64(cells)}";
const HUES = "${greys ? "" : base64(shades.index)}";
`;
  return { source, cols, rows, colors: shades.colors.length, greys, outlined: edge.reduce((a, e) => a + (e > 0), 0) };
}
