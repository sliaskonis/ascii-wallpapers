/*
 * The page side of a wallpaper: plays one piece on a canvas sized to the
 * screen. asciiwall bundles this with a piece into each HTML file.
 *
 * The page's address can carry settings, after a "?":
 *   fit    cover (fills the screen, cropping what overflows), contain (all of
 *          it, edge to edge) or a number, the share of contain it takes: 0.6
 *          leaves a wide margin round it. Unasked, a scene fills the screen,
 *          and so does a piece made in the screen's shape; the rest take 0.8.
 *   fps    frames a second, instead of the piece's own
 *   bg     the colour behind it, as rrggbb: the piece's ground by default
 *   fg     the ink of a piece with no colours of its own, as rrggbb
 *   opts   the piece's options, as JSON: {"text":"hello"}
 */
import { mount } from "ascii.rest";

const isPiece = (v) => !!v && typeof v === "object" && !!v.meta && typeof v.default === "function";
const hex = (v) => (/^[0-9a-f]{3,8}$/i.test(v) ? `#${v}` : v);

function play(mod) {
  // A kit file's piece is its default export; a library piece's module is the piece.
  const piece = isPiece(mod.default) ? mod.default : mod;
  const { cols, rows, cell = 2, ground } = piece.meta;
  const query = new URLSearchParams(location.search);
  const asked = query.get("fit");
  if (asked && asked !== "cover" && asked !== "contain" && !(+asked > 0)) throw new Error(`fit takes cover, contain or a number above 0, not ${asked}`);
  const options = JSON.parse(query.get("opts") || "{}");
  if (query.get("fps")) options.fps = +query.get("fps");

  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.color = hex(query.get("fg") || "c9d1d9");
  document.documentElement.style.background = hex(query.get("bg") || ground || "0b0d10");

  // mount() draws at the canvas's width and keeps its shape, so placing it is setting that width.
  const shape = cols / (rows * cell);
  const place = () => {
    const w = innerWidth, h = innerHeight;
    const fit = asked || (ground || Math.abs((shape * h) / w - 1) < 0.02 ? "cover" : "0.8");
    const width = Math.round(fit === "cover" ? Math.max(w, h * shape) : Math.min(w, h * shape) * (fit === "contain" ? 1 : +fit));
    canvas.style.width = `${width}px`;
    canvas.style.left = `${Math.round((w - width) / 2)}px`;
    canvas.style.top = `${Math.round((h - width / shape) / 2)}px`;
  };
  place();
  addEventListener("resize", place);
  document.body.append(canvas);
  // A wallpaper is asked to move, so it does, whatever the desktop's animation setting.
  mount(canvas, piece, { ...options, motion: true });
}

/** What went wrong, on the page: a wallpaper that can't play says why, where a blank screen would say nothing. */
function report(error) {
  const pre = document.createElement("pre");
  pre.textContent = `${document.title}: ${error?.message ?? error}`;
  document.body.replaceChildren(pre);
  console.error(error);
}

/**
 * Plays the piece in a module once it has loaded. The module is loaded here, not imported by the page, so a piece
 * that throws as it is made, a look given a palette it does not know, is caught and reported like any other error.
 */
export const run = (load) => load().then(play).catch(report);
