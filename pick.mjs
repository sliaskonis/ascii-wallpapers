/*
 * The picker: every piece in a list, and the one under the cursor playing
 * beside it, as ascii.rest draws it in a terminal. `asciiwall pick` opens it.
 */
import process from "node:process";
import { play } from "ascii.rest/terminal";

// The list's width in columns, and the blank ones between it and the piece.
const LIST = 24;
const GAP = 2;
// The narrowest a piece is worth playing in: with less beside the list, the list has the screen to itself.
const ROOM = 24;
// How long a piece is under the cursor before it plays, in ms, so holding an arrow scrolls past the ones on the way.
const WAIT = 90;

// The alternate screen, the cursor hidden and no wrapping, as play() sets a terminal up, and the mouse's wheel and
// clicks sent as keys are, which every terminal has off until asked.
const ENTER = "\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[2J";
const LEAVE = "\x1b[0m\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[?1049l";
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

// What a terminal sends for a key: a sequence for an arrow and its like, a character for the rest. Escape before a
// character is that key with Alt, which is no key here: only alone is it Escape.
const KEY = /\x1b\[[<\d;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b[^]|[^]/gu;
// The mouse: a button going down, with the column and the row it is over. 64 and 65 are the wheel, up and down.
const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)M$/;
const WHEEL = { 64: "up", 65: "down" };
const KEYS = {
  "\x1b[A": "up", "\x1bOA": "up", "\x1b[B": "down", "\x1bOB": "down",
  "\x1b[D": "left", "\x1bOD": "left", "\x1b[C": "right", "\x1bOC": "right",
  "\x1b[5~": "pageup", "\x1b[6~": "pagedown",
  "\x1b[H": "home", "\x1b[1~": "home", "\x1bOH": "home", "\x1b[F": "end", "\x1b[4~": "end", "\x1bOF": "end",
  "\r": "enter", "\n": "enter", "\x7f": "backspace", "\b": "backspace", "\x15": "clear", "\x1b": "escape", "\x03": "quit",
};

const to = (row, col) => `\x1b[${row};${col}H`;
const dim = (s) => `\x1b[2m${s}\x1b[22m`;
const fit = (s, width) => (width <= 0 ? "" : s.length > width ? `${s.slice(0, width - 1)}…` : s.padEnd(width));

/**
 * A part of the screen as a terminal of its own, for play() to draw on. play() takes a whole terminal, so its switches
 * to the alternate screen and back are dropped, and each place it moves the cursor to is `left` columns and `top` rows on.
 */
const pane = (left, top, columns, rows) => ({
  isTTY: true,
  columns,
  rows,
  write: (text) => process.stdout.write(text.replace(/\x1b\[\?\d+[hl]|\x1b\[2J/g, "").replace(/\x1b\[(\d+);(\d+)H/g, (_, y, x) => to(+y + top, +x + left))),
});

/**
 * Opens the picker on `pieces`, each a name and the group it is listed under, in the list's order. Resolves to the
 * name chosen, or to nothing when it is left without one.
 *
 *   load      a name's piece, to play it
 *   current   the name the list opens on, marked in it: the wallpaper as it is
 *   options   option overrides for the pieces, and `fps`, frames a second instead of their own
 */
export function pick(pieces, { load, current, options, fps }) {
  const out = process.stdout, stdin = process.stdin;
  const loaded = new Map();
  // What is typed, the pieces it leaves, the list's lines for them (a group's heading, then its pieces), the cursor's
  // place among the pieces and the first line in view.
  let query = "", shown = pieces, lines = [], at = 0, top = 0;
  let playing = new AbortController(), turn = 0, timer, over = false;

  const screen = () => {
    const W = out.columns || 80, H = out.rows || 24, wide = W - LIST - GAP >= ROOM;
    return { W, H, wide, width: wide ? LIST : W, height: Math.max(1, H - 2), left: LIST + GAP };
  };

  /** Keeps the pieces with the text in their name, or whose group starts with it, and the cursor on its piece if it is one. */
  const filter = (text) => {
    const held = shown[at], q = text.trim().toLowerCase().replace(/\s+/g, "-");
    query = text;
    shown = pieces.filter((p) => p.name.includes(q) || p.group.startsWith(q));
    lines = shown.flatMap((p, i) => (i && shown[i - 1].group === p.group ? [{ i }] : [{ group: p.group }, { i }]));
    at = Math.max(0, shown.indexOf(held));
    top = 0;
  };

  const move = (i) => (at = Math.max(0, Math.min(shown.length - 1, i)));
  /** To the first piece of the next group, or back to the first of this one and then of the one before. */
  const group = (step) => {
    const firsts = lines.flatMap((line, n) => ("group" in line ? [lines[n + 1].i] : []));
    const here = firsts.findLastIndex((i) => i <= at);
    move(firsts[step < 0 && firsts[here] < at ? here : Math.max(0, Math.min(firsts.length - 1, here + step))] ?? 0);
  };

  const list = () => {
    const { W, H, width, height } = screen();
    // The cursor's line stays in view with the line above it, its group's heading at a group's first, and the one below.
    const line = lines.findIndex((l) => l.i === at);
    top = Math.min(Math.max(Math.min(top, line - 1), line + 2 - height), line);
    top = Math.max(0, Math.min(top, lines.length - height));

    const count = String(shown.length), head = fit(`> ${query || "type to filter"}`, width - count.length - 1);
    let s = `${to(1, 1)}${query ? head : `> ${dim(head.slice(2))}`} ${dim(count)}`;
    for (let y = 0; y < height; y++) {
      const l = lines[top + y];
      s += to(2 + y, 1);
      if (!l) s += y || shown.length ? " ".repeat(width) : dim(fit("  no piece by that name", width));
      else if ("group" in l) s += dim(fit(l.group, width));
      else {
        const name = shown[l.i].name, text = fit(`${name === current ? "*" : " "} ${name}`, width);
        s += l.i === at ? `\x1b[7m${text}\x1b[27m` : text;
      }
    }
    out.write(`${s}${to(H, 1)}${dim(fit(`↑↓ move   ←→ category   enter set as wallpaper   esc ${query ? "clear" : "quit"}   * the wallpaper now`, W))}`);
  };

  /** Plays the piece under the cursor beside the list, under its name and its note. */
  const show = () => {
    playing.abort();
    clearTimeout(timer);
    const mine = ++turn, piece = shown[at];
    timer = setTimeout(async () => {
      let made;
      try {
        if (piece && !loaded.has(piece.name)) loaded.set(piece.name, load(piece.name));
        made = piece && (await loaded.get(piece.name));
      } catch (error) {
        made = error;
      }
      if (over || mine !== turn) return;
      const { W, wide, height, left } = screen(), cols = W - left;
      if (!wide) return;
      const title = fit(piece ? `${piece.name}  ${made.meta?.note ?? ""}` : "", cols), named = piece?.name.length ?? 0;
      let s = `${to(1, left + 1)}\x1b[1m${title.slice(0, named)}\x1b[22m${dim(title.slice(named))}`;
      for (let y = 0; y < height; y++) s += `${to(2 + y, left + 1)}\x1b[K`;
      out.write(s);
      if (!piece) return;
      // A piece that can't play says why where it would have played.
      const say = (error) => {
        const text = String(error?.message ?? error).split("\n").flatMap((l) => l.match(new RegExp(`.{1,${cols}}`, "g")) ?? [""]);
        out.write(`\x1b[31m${text.slice(0, height - 1).map((l, y) => to(3 + y, left + 1) + l).join("")}\x1b[39m`);
      };
      if (made instanceof Error) return say(made);
      playing = new AbortController();
      play(made, { out: pane(left, 1, cols, height), signal: playing.signal, options, fps }).catch((error) => over || mine !== turn || say(error));
    }, WAIT);
  };

  const draw = () => {
    out.write("\x1b[2J");
    list();
    show();
  };

  return new Promise((done) => {
    const restore = () => out.write(LEAVE);
    const finish = (name) => {
      if (over) return;
      over = true;
      playing.abort();
      clearTimeout(timer);
      stdin.off("data", key);
      out.off("resize", draw);
      for (const signal of SIGNALS) process.off(signal, leave);
      process.off("exit", restore);
      stdin.setRawMode(false);
      stdin.pause();
      restore();
      done(name);
    };
    const leave = () => finish();
    const key = (data) => {
      for (const k of String(data).match(KEY) ?? []) {
        const [, button, x, y] = MOUSE.exec(k)?.map(Number) ?? [];
        const name = KEYS[k] ?? WHEEL[button], { width, height } = screen(), page = Math.max(1, height - 2);
        // In raw mode Ctrl+C arrives as a key, not a signal.
        if (name === "quit" || (name === "escape" && !query)) return finish();
        if (name === "enter" && shown[at]) return finish(shown[at].name);
        if (name === "up") move(at - 1);
        else if (name === "down") move(at + 1);
        else if (name === "pageup") move(at - page);
        else if (name === "pagedown") move(at + page);
        else if (name === "home") move(0);
        else if (name === "end") move(shown.length - 1);
        else if (name === "left") group(-1);
        else if (name === "right") group(1);
        else if (name === "backspace") filter(query.slice(0, -1));
        else if (name === "escape" || name === "clear") filter("");
        // a click on a name in the list
        else if (button === 0 && x <= width && y > 1 && y <= height + 1) move(lines[top + y - 2]?.i ?? at);
        else if (!name && k >= " ") filter(query + k);
      }
      list();
      // play() ends on any key, so the piece is played again even when the cursor has not left it.
      show();
    };

    // Before the first play(), which leaves stdin as it found it: raw, and being read.
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", key);
    out.on("resize", draw);
    for (const signal of SIGNALS) process.on(signal, leave);
    // If the program exits while it is open, the terminal is put back on the way out.
    process.on("exit", restore);

    out.write(ENTER);
    filter("");
    move(pieces.findIndex((p) => p.name === current));
    draw();
  });
}
