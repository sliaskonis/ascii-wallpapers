/*
 * GNOME's overview and lock screen draw GNOME's own background, not Hidamari's
 * window, so they show whatever picture was there before the live wallpaper.
 * For a video, Hidamari makes a still of it GNOME's background; for a page it
 * does not, so asciiwall does: Hidamari's window captured as it plays, blurred
 * by Hidamari's blur radius, as its video stills are. Hidamari's "Static
 * wallpaper" switch and "Blur radius" set it, as they do for a video. With the
 * switch off, the background that was there before is put back.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const DATA = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "asciiwall");
// The background there was before the first still, as gsettings gave it, to be put back.
const BEFORE = join(DATA, "background.json");
const SCHEMA = "org.gnome.desktop.background";
const KEYS = ["picture-uri", "picture-uri-dark"];
const STILL = /^still-\d+\.png$/;
// How long Hidamari has to start a player and draw the page, and how long the page then plays before it is captured,
// in ms: long enough for a piece that builds its picture up to show something of it.
const START = 15000;
const PLAY = 1500;

const gnome = () => (process.env.XDG_CURRENT_DESKTOP ?? "").toUpperCase().includes("GNOME");
const get = (key) => spawnSync("gsettings", ["get", SCHEMA, key], { encoding: "utf8" }).stdout?.trim() ?? "";
const put = (key, value) => spawnSync("gsettings", ["set", SCHEMA, key, value]).status === 0;
const quoted = (s) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
// A still, asciiwall's or one Hidamari made of a video: never the background to put back.
const still = (value) => value.includes(pathToFileURL(DATA).href) || /\/hidamari\/static-\d+\.png/.test(value);

/**
 * Who has Hidamari's player's name on the bus: a new name each time Hidamari starts a player, which no other will have.
 * Its window is no help, as a new player's window may get the old one's id.
 */
export const player = () =>
  spawnSync("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.GetNameOwner", "io.github.jeffshee.Hidamari.player"], { encoding: "utf8" }).stdout?.trim() || undefined;

/** Hidamari's wallpaper window, the largest when there is one a screen: its X id. */
function wallpaperWindow() {
  const tree = spawnSync("xwininfo", ["-root", "-tree"], { encoding: "utf8" }).stdout ?? "";
  const found = [...tree.matchAll(/(0x[0-9a-f]+) "hidamari": \("hidamari" "Hidamari"\)\s+(\d+)x(\d+)/g)];
  return found.sort((a, b) => b[2] * b[3] - a[2] * a[3])[0]?.[1];
}

const capture = (id) => spawnSync("xwd", ["-silent", "-id", id], { maxBuffer: 1 << 27 }).stdout;

/** True when a window as xwd captured it has more than one colour in it: a page that has drawn. */
function drawn(xwd) {
  if (!xwd || xwd.length < 100) return false;
  const pixels = xwd.subarray(xwd.readUInt32BE(0) + xwd.readUInt32BE(76) * 12);
  for (let i = 4; i + 4 <= pixels.length; i += 4) if (pixels.readUInt32BE(i) !== pixels.readUInt32BE(0)) return true;
  return false;
}

/** Puts back the background there was before the first still, where a still is the background now. */
function thaw() {
  if (!existsSync(BEFORE)) return;
  const before = JSON.parse(readFileSync(BEFORE, "utf8"));
  for (const key of KEYS) if (still(get(key)) && before[key]) put(key, before[key]);
  for (const f of readdirSync(DATA)) if (STILL.test(f)) rmSync(join(DATA, f));
  rmSync(BEFORE);
  return "GNOME's own background is back: Hidamari's static wallpaper is off";
}

/**
 * Makes a still of the wallpaper GNOME's background, as Hidamari's settings in `config` ask, once Hidamari's window
 * shows the page. `replacing` is the player() Hidamari had before it was asked to start a new one, which will not show
 * the page. Resolves to a line to tell, if there is one: what went wrong, say. Nothing here fails the command, as the
 * wallpaper is set either way.
 */
export async function freeze(config, replacing) {
  if (!gnome()) return;
  if (!config.is_static_wallpaper) return thaw();
  let xwd;
  for (const end = Date.now() + START; Date.now() < end && !xwd; await sleep(300)) {
    const now = player(), id = now && now !== replacing && wallpaperWindow();
    if (!id || !drawn(capture(id))) continue;
    await sleep(PLAY);
    xwd = capture(id);
  }
  if (!drawn(xwd)) return "the overview shows GNOME's background still: Hidamari's window did not show the page in time";

  mkdirSync(DATA, { recursive: true });
  const file = join(DATA, `still-${Date.now()}.png`);
  const blur = config.static_wallpaper_blur_radius > 0 ? ["-vf", `gblur=sigma=${config.static_wallpaper_blur_radius}`] : [];
  const made = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "xwd_pipe", "-i", "pipe:0", ...blur, "-frames:v", "1", "-pix_fmt", "rgb24", file], { input: xwd });
  if (made.status !== 0) return `the overview shows GNOME's background still: ffmpeg did not make the still${made.error ? `, ${made.error.message}` : ""}`;

  const now = Object.fromEntries(KEYS.map((key) => [key, get(key)]));
  if (!KEYS.some((key) => still(now[key]))) writeFileSync(BEFORE, `${JSON.stringify(now, null, 2)}\n`);
  if (!KEYS.every((key) => put(key, quoted(pathToFileURL(file).href)))) return "the overview shows GNOME's background still: gsettings did not take the still";
  // GNOME has the new one; the ones before it are no one's.
  for (const f of readdirSync(DATA)) if (STILL.test(f) && join(DATA, f) !== file) rmSync(join(DATA, f));
}
