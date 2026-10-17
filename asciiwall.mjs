#!/usr/bin/env node
/*
 * asciiwall: ascii.rest pieces as Hidamari live wallpapers.
 *
 * Each wallpaper is one HTML file with the piece and its player inside, so it
 * needs no network and no server. They go in ~/Videos/Hidamari/ascii, the one
 * folder Hidamari's Flatpak sandbox can read. A piece is any name from
 * `asciiwall list`, or a file of your own in my/.
 *
 *   asciiwall pick
 *   asciiwall set tokyo-rain
 *   asciiwall set donut --fit 0.5 --fg f97316
 *   asciiwall dev ocean
 *   asciiwall image ~/Pictures/harbour.jpg
 */
import { context, build as bundle } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { load, names } from "ascii.rest";
import { freeze, player } from "./still.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MINE = join(ROOT, "my");
const PLAYER = join(ROOT, "player.js");
const videos = spawnSync("xdg-user-dir", ["VIDEOS"], { encoding: "utf8" }).stdout?.trim() || join(homedir(), "Videos");
const OUT = join(videos, "Hidamari", "ascii");
// Hidamari's config: the Flatpak's, or a native install's.
const CONFIG = [join(homedir(), ".var/app/io.github.jeffshee.Hidamari/config/hidamari/config.json"), join(homedir(), ".config/hidamari/config.json")].find(existsSync);
const BUS = "io.github.jeffshee.Hidamari";
const EXTENSIONS = [".ts", ".js", ".mjs"];
// The library's categories, in the order ascii.rest lists them.
const ORDER = ["scenes", "ui", "data", "type", "logos", "companies", "distros", "shapes", "space", "physics", "nature", "creatures", "objects", "generative", "effects"];

const HELP = `asciiwall: ascii.rest pieces as Hidamari live wallpapers.

  asciiwall pick                  the list, each piece playing beside it as you go
                                  down it: enter makes the one you are on the wallpaper
  asciiwall list                  every piece by category, and your own; or ls
  asciiwall set <piece>           builds it and makes it the wallpaper
  asciiwall dev <piece>           sets one of your own, and again each time you save it
  asciiwall build [piece...]      writes the HTML files; all of them with no names
  asciiwall update                the library's newest pieces from GitHub, and every
                                  HTML file written again with them
  asciiwall image <file> [name]   a picture as a piece of your own in my/, named
                                  for the file unless named: png, jpg, webp, gif,
                                  avif, svg or anything else ffmpeg reads

  set, dev and pick:
  --fit <how>       cover (fills the screen, cropping what overflows), contain
                    (all of it, edge to edge) or a number, the share of contain
                    it takes: 0.6. Unasked, a scene fills the screen, and so
                    does a piece made in the screen's shape; the rest take 0.8.
  --fps <n>         frames a second, instead of the piece's own
  --bg <hex>        the colour behind it, like 0b0d10: the piece's ground by default
  --fg <hex>        the ink of a piece with no colours of its own, like c9d1d9
  --opts <json>     the piece's options: '{"text":"hello"}'

  image:
  --cols <n>        its width in characters: 240 by default, the height
                    following the picture's shape. More for finer detail
  --blur <n>        how much the picture is softened first, in characters: 0.75
                    by default. More smooths away hatching, screentone and
                    noise; 0 keeps the finest detail
  --edges <n>       the share of characters, in percent, drawn as | / - \\ along
                    the outlines of shapes: 7 by default, 0 for none
  --colors <n>      how many colours it keeps, up to 10, 1 for greys: unasked,
                    6, or greys for a picture with hardly any colour
  --invert          a negative of it, for a dark drawing on a light page
  --force           writes over a piece of yours with the same name

  A piece is a name from the list, or a file of your own in
  ${MINE}
  The HTML files go in ${OUT}`;

class Fail extends Error {}
const fail = (message) => {
  throw new Fail(message);
};

const mine = () => (existsSync(MINE) ? readdirSync(MINE).filter((f) => EXTENSIONS.includes(extname(f))) : []);
const nameOf = (file) => basename(file, extname(file));
const fileOf = (name) => join(OUT, `${name}.html`);

/** Where a piece comes from: a file in my/ before a library piece of the same name. */
function find(name) {
  const own = mine().find((f) => nameOf(f) === name);
  if (own) return { spec: join(MINE, own), own: true };
  if (names.includes(name)) return { spec: `ascii.rest/pieces/${name}`, own: false };
  const near = [...names, ...mine().map(nameOf)].filter((n) => n.includes(name));
  fail(`no piece called ${name}${near.length ? `: did you mean ${near.slice(0, 6).join(", ")}?` : ", see asciiwall list"}`);
}

const settings = (name, { spec }) => ({
  stdin: { contents: `import { run } from ${JSON.stringify(PLAYER)};\nrun(() => import(${JSON.stringify(spec)}));\n`, resolveDir: ROOT, sourcefile: `${name}.wallpaper.js` },
  bundle: true,
  format: "iife",
  minify: true,
  charset: "utf8",
  legalComments: "none",
  write: false,
  logLevel: "error",
});

/** The wallpaper: one page with the piece and its player inside. */
function write(name, { own }, js) {
  const credit = own ? `${name}: made with ascii.rest` : `${name}: a piece from ascii.rest`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<!-- ${credit} by @bas3line (https://github.com/bas3line/ascii), MIT licensed. Built by asciiwall. -->
<title>${name}</title>
<style>
html, body { margin: 0; height: 100%; overflow: hidden; background: #0b0d10; }
pre { position: absolute; inset: 0; margin: 0; padding: 48px; font: 16px/1.5 monospace; color: #ff7b72; background: #0b0d10; white-space: pre-wrap; }
</style>
</head>
<body>
<script>${js.replaceAll("</script", "<\\/script")}</script>
</body>
</html>
`;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(fileOf(name), html);
}

async function build(name) {
  const from = find(name);
  let result;
  try {
    result = await bundle(settings(name, from));
  } catch {
    fail(`${name} did not build`);
  }
  write(name, from, result.outputFiles[0].text);
}

/** The settings a command line gave, as a page's address carries them: after a "?", or nothing for none. */
function search(flags) {
  const query = new URLSearchParams();
  const { fit, fps, bg, fg, opts } = flags;
  if (fit !== undefined) {
    if (fit !== "cover" && fit !== "contain" && !(+fit > 0)) fail(`--fit takes cover, contain or a number above 0, not ${fit}`);
    query.set("fit", fit);
  }
  if (fps !== undefined) {
    if (!(+fps > 0 && +fps <= 60)) fail(`--fps takes a number up to 60, not ${fps}`);
    query.set("fps", fps);
  }
  for (const [key, value] of [["bg", bg], ["fg", fg]]) {
    if (value === undefined) continue;
    if (!/^#?[0-9a-f]{6}$/i.test(value)) fail(`--${key} takes a colour as rrggbb, like 0b0d10, not ${value}`);
    query.set(key, value.replace("#", ""));
  }
  if (opts !== undefined) {
    try {
      query.set("opts", JSON.stringify(JSON.parse(opts)));
    } catch {
      fail(`--opts takes JSON, like '{"text":"hello"}', not ${opts}`);
    }
  }
  return query.size ? `?${query}` : "";
}

const address = (name, flags) => pathToFileURL(fileOf(name)).href + search(flags);

const hidamari = () => JSON.parse(readFileSync(CONFIG, "utf8"));
const gdbus = (who, ...args) => spawnSync("gdbus", ["call", "--session", "--dest", `${BUS}.${who}`, "--object-path", `/io/github/jeffshee/Hidamari/${who}`, ...args], { encoding: "utf8" }).status === 0;
const quoted = (s) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/**
 * Makes a page the wallpaper. Hidamari's player reads the page from the config file when it starts, so the file is
 * written first, as Hidamari's own window does, and then the server is asked to start a player. False if Hidamari
 * is not running: it shows the page when it next starts.
 */
function show(url) {
  if (!CONFIG) fail("Hidamari has no config yet: open Hidamari once, then run this again");
  const config = hidamari();
  config.mode = "MODE_WEBPAGE";
  config.data_source = { ...config.data_source, Default: url };
  // Written whole and moved into place: Hidamari resets a config it reads half written.
  writeFileSync(`${CONFIG}.tmp`, `${JSON.stringify(config, null, 3)}\n`);
  renameSync(`${CONFIG}.tmp`, CONFIG);
  return gdbus("server", "--method", "io.github.jeffshee.hidamari.server.webpage", quoted(url));
}

/** Loads the page again in the player that is running, without starting a new one; show() if there is none. */
const reload = (url) => gdbus("player", "--method", "org.freedesktop.DBus.Properties.Set", "io.github.jeffshee.hidamari.player", "data_source", `<${quoted(url)}>`) || show(url);

const shown = (name, live) => console.log(live ? `${name} is the wallpaper` : `${name} is saved as the wallpaper. Hidamari is not running: it shows when Hidamari starts`);
const say = (line) => line && console.log(line);

async function set(name, flags) {
  if (!name) fail("set takes a piece: asciiwall set tokyo-rain");
  const url = address(name, flags);
  await build(name);
  // GNOME's overview gets a still of it, from the player Hidamari starts for it.
  const replacing = player();
  const live = show(url);
  shown(name, live);
  if (live) say(await freeze(hidamari(), replacing));
}

async function dev(name, flags) {
  if (!name) fail("dev takes one of your own pieces: asciiwall dev ocean");
  const from = find(name);
  if (!from.own) fail(`dev is for a piece of your own in ${MINE}: use asciiwall set ${name}`);
  const url = address(name, flags);
  let first = true;
  // A still for GNOME's overview after each save, one at a time: saves that come while one is made get one more after it.
  let replacing, freezing = false, again = false;
  const refreeze = async () => {
    if (freezing) return void (again = true);
    freezing = true;
    do {
      again = false;
      say(await freeze(hidamari(), replacing));
      replacing = undefined;
    } while (again);
    freezing = false;
  };
  const watch = await context({
    ...settings(name, from),
    plugins: [
      {
        name: "wallpaper",
        setup(b) {
          b.onEnd((result) => {
            // A file that does not build leaves the last wallpaper up; esbuild has said what is wrong.
            if (result.errors.length) return;
            write(name, from, result.outputFiles[0].text);
            if (first) replacing = player();
            const live = first ? show(url) : reload(url);
            console.log(`${new Date().toLocaleTimeString()}  ${name} ${first ? "set" : "reloaded"}${live ? "" : " (Hidamari is not running)"}`);
            first = false;
            if (live) refreeze();
          });
        },
      },
    ],
  });
  await watch.watch();
  console.log(`watching ${from.spec}: save it to see it on the desktop, Ctrl+C to stop`);
}

async function buildAll(wanted) {
  const all = wanted.length ? wanted : [...new Set([...names, ...mine().map(nameOf)])];
  const failed = [];
  for (const name of all) {
    try {
      await build(name);
    } catch (error) {
      if (!(error instanceof Fail) || wanted.length) throw error;
      failed.push(name);
    }
  }
  console.log(`${all.length - failed.length} wallpaper${all.length - failed.length === 1 ? "" : "s"} in ${OUT}`);
  if (failed.length) fail(`did not build: ${failed.join(", ")}`);
}

/** The library's commit package-lock.json pins, as npm resolved it from GitHub. */
function pinned() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")).packages["node_modules/ascii.rest"].resolved;
  } catch {
    return undefined;
  }
}

/**
 * The library's newest commit on GitHub, and every wallpaper file written again with it. npm moves the commit
 * package-lock.json pins; a library linked from a clone of your own is updated in the clone instead.
 */
async function update() {
  const library = join(ROOT, "node_modules", "ascii.rest");
  if (existsSync(library) && lstatSync(library).isSymbolicLink()) fail(`ascii.rest is linked to ${realpathSync(library)}: update it there with git pull && npm install, then asciiwall build`);
  const before = pinned();
  const npm = spawnSync("npm", ["update", "ascii.rest", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit" });
  if (npm.status !== 0) fail(`npm did not update ascii.rest${npm.error ? `: ${npm.error.message}` : ""}`);
  const after = pinned();
  if (after === before) return console.log("ascii.rest is up to date");
  // This process has the library it started with loaded, so the updated one is asked in a new one: for its pieces, and to build.
  const now = spawnSync(process.execPath, ["--input-type=module", "-e", 'console.log(JSON.stringify((await import("ascii.rest")).names))'], { cwd: ROOT, encoding: "utf8" });
  const added = JSON.parse(now.stdout || "[]").filter((name) => !names.includes(name));
  console.log(`ascii.rest is at ${after?.split("#")[1]?.slice(0, 7) ?? "its newest"}: ${added.length ? `new, ${added.join(", ")}` : "no new pieces"}`);
  const built = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "build"], { stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

/** A number from a flag, or its default when unasked; whole if `whole`, and from `min` to `max`. */
function number(flag, value, fallback, min, max, whole = false) {
  if (value === undefined) return fallback;
  const n = +value;
  if (!(value.trim() !== "" && n >= min && n <= max && (!whole || Number.isInteger(n)))) fail(`--${flag} takes ${whole ? "a whole number" : "a number"} from ${min} to ${max}, not ${value}`);
  return n;
}

/** A picture as a piece of your own: my/<name>.ts, its name the file's unless given. */
async function image(file, wanted, flags) {
  if (!file) fail("image takes a picture: asciiwall image ~/Pictures/harbour.jpg");
  if (!existsSync(file)) fail(`no file at ${file}`);
  const name = (wanted ?? nameOf(file)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) fail(`give it a name of letters and digits: asciiwall image ${file} harbour`);
  const there = mine().find((f) => nameOf(f) === name);
  if (there && (!flags.force || extname(there) !== ".ts")) fail(`my/${there} is there already: give this another name${extname(there) === ".ts" ? ", or --force to write over it" : ""}`);
  if (!there && names.includes(name) && !flags.force) fail(`ascii.rest has a piece called ${name}, and yours would play in its place: give yours another name, or --force`);
  const settings = {
    cols: number("cols", flags.cols, 240, 16, 480, true),
    blur: number("blur", flags.blur, 0.75, 0, 10),
    edges: number("edges", flags.edges, 7, 0, 100),
    colors: number("colors", flags.colors, undefined, 1, 10, true),
    invert: !!flags.invert,
  };
  const { picture } = await import("./image.mjs");
  const made = picture(file, name, settings, fail);
  mkdirSync(MINE, { recursive: true });
  writeFileSync(join(MINE, `${name}.ts`), made.source);
  console.log(`my/${name}.ts: ${made.cols} by ${made.rows}, in ${made.greys ? "greys" : `${made.colors} colour${made.colors === 1 ? "" : "s"}`}, ${made.outlined} characters of outline`);
  console.log(`asciiwall set ${name} makes it the wallpaper; asciiwall dev ${name} shows it each time it changes`);
}

/** Every piece and the group it is listed under: yours first, then the library's by category. */
async function catalog() {
  const own = mine().map(nameOf);
  const library = await Promise.all(names.filter((name) => !own.includes(name)).map(async (name) => ({ name, group: (await load[name]()).meta.category })));
  // A category the library has gained since goes after the ones known here.
  const place = (p) => (ORDER.indexOf(p.group) + 1 || ORDER.length + 1);
  library.sort((a, b) => place(a) - place(b) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  return [...own.sort().map((name) => ({ name, group: "yours" })), ...library];
}

/** The piece that is the wallpaper now, if asciiwall set it. */
function current() {
  try {
    const { mode, data_source } = hidamari();
    const path = fileURLToPath(data_source.Default);
    return mode === "MODE_WEBPAGE" && dirname(path) === OUT ? basename(path, ".html") : undefined;
  } catch {
    return undefined;
  }
}

async function list() {
  const all = await catalog(), now = current();
  const width = Math.min(process.stdout.columns || 80, 100), pad = 12;
  for (const group of new Set(all.map((p) => p.group))) {
    let line = group.padEnd(pad);
    for (const { name } of all.filter((p) => p.group === group)) {
      const word = name === now ? `${name}*` : name;
      if (line.length > pad && line.length + 2 + word.length > width) {
        console.log(line);
        line = " ".repeat(pad);
      }
      line += (line.length > pad ? "  " : "") + word;
    }
    console.log(line);
  }
  if (!all.some((p) => p.group === "yours")) console.log(`\nNone of your own yet: add a file to ${MINE}`);
  console.log(`\n${all.length} pieces${now ? `, * the wallpaper now` : ""}. asciiwall pick plays them as you go down the list, asciiwall set <piece> sets one.`);
}

const isPiece = (v) => !!v && typeof v === "object" && !!v.meta && typeof v.default === "function";

/** A piece for Node to play, in the picker: a library piece as it is, one of your own bundled first, as its page is. */
async function made(name) {
  const from = find(name);
  if (!from.own) return load[name]();
  const result = await bundle({ entryPoints: [from.spec], bundle: true, format: "esm", platform: "node", write: false, logLevel: "silent" });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
  // A kit file's piece is its default export; a file with meta and a default function is the piece.
  const piece = isPiece(mod.default) ? mod.default : mod;
  if (!isPiece(piece)) fail(`${name} has no piece: export one as its default, export default sea()`);
  return piece;
}

async function pick(flags) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("pick takes a terminal to play the pieces in: asciiwall list prints their names");
  search(flags);
  const picker = await import("./pick.mjs");
  const name = await picker.pick(await catalog(), { load: made, current: current(), options: flags.opts && JSON.parse(flags.opts), fps: flags.fps && +flags.fps });
  if (name) await set(name, flags);
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      fit: { type: "string" },
      fps: { type: "string" },
      bg: { type: "string" },
      fg: { type: "string" },
      opts: { type: "string" },
      cols: { type: "string" },
      blur: { type: "string" },
      edges: { type: "string" },
      colors: { type: "string" },
      invert: { type: "boolean" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) console.log(HELP);
  else if (command === "list" || command === "ls") await list();
  else if (command === "pick") await pick(values);
  else if (command === "set") await set(rest[0], values);
  else if (command === "dev") await dev(rest[0], values);
  else if (command === "build") await buildAll(rest);
  else if (command === "update") await update();
  else if (command === "image") await image(rest[0], rest[1], values);
  else fail(`no command called ${command}: asciiwall --help lists them`);
} catch (error) {
  if (!(error instanceof Fail) && error?.code !== "ERR_PARSE_ARGS_UNKNOWN_OPTION") throw error;
  console.error(`asciiwall: ${error.message}`);
  process.exit(1);
}
