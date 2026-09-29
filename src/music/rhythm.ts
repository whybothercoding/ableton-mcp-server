/** Rates and rhythm patterns. Beats are quarter notes. */
import { mod } from './types.js';

const BASE: Record<string, number> = { '1': 4, '2': 2, '4': 1, '8': 0.5, '16': 0.25, '32': 0.125, '64': 0.0625 };

/** '1/16' = a sixteenth (0.25 beats), '1/8t' = eighth-note triplet, '1/4d' = dotted quarter, '2 bars'-style is not supported: use beats. */
export function parseRate(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new Error('a rate in beats must be greater than 0');
    return value;
  }
  if (typeof value !== 'string') throw new Error("a rate must be beats (a number) or a string like '1/16'");
  const match = /^\s*(?:1\/)?(\d+)\s*([td]?)\s*$/i.exec(value.replace(/th|nd|st|rd/gi, '').replace(/note/i, ''));
  if (!match || !(match[1] in BASE)) throw new Error(`'${value}' is not a rate: use 1/1, 1/2, 1/4, 1/8, 1/16, 1/32 or 1/64, with t (triplet) or d (dotted) after it`);
  const beats = BASE[match[1]];
  return match[2].toLowerCase() === 't' ? (beats * 2) / 3 : match[2].toLowerCase() === 'd' ? beats * 1.5 : beats;
}

/** Euclidean rhythm (Bjorklund): `pulses` hits spread as evenly as possible over `steps`, starting on a hit, then rotated. */
export function euclid(steps: number, pulses: number, rotation = 0): boolean[] {
  if (!Number.isInteger(steps) || steps < 1) throw new Error('steps must be a whole number from 1');
  if (!Number.isInteger(pulses) || pulses < 0) throw new Error('pulses must be a whole number from 0');
  if (pulses === 0) return Array(steps).fill(false);
  if (pulses >= steps) return Array(steps).fill(true);
  const counts: number[] = [];
  const remainders: number[] = [pulses];
  let divisor = steps - pulses;
  let level = 0;
  for (;;) {
    counts.push(Math.floor(divisor / remainders[level]));
    remainders.push(divisor % remainders[level]);
    divisor = remainders[level];
    level += 1;
    if (remainders[level] <= 1) break;
  }
  counts.push(divisor);
  const pattern: boolean[] = [];
  const build = (lvl: number): void => {
    if (lvl === -1) pattern.push(false);
    else if (lvl === -2) pattern.push(true);
    else {
      for (let i = 0; i < counts[lvl]; i += 1) build(lvl - 1);
      if (remainders[lvl] !== 0) build(lvl - 2);
    }
  };
  build(level);
  const first = pattern.indexOf(true);
  const start = pattern.slice(first).concat(pattern.slice(0, first));
  const shift = mod(rotation, steps);
  return start.slice(steps - shift).concat(start.slice(0, steps - shift));
}

/** 'x..x..x.' style patterns: x hit, X accent, o ghost note, anything else a rest. */
export type Hit = 'normal' | 'accent' | 'ghost';
export function parsePattern(text: string): (Hit | null)[] {
  const out: (Hit | null)[] = [];
  for (const ch of text.replace(/[\s|]/g, '')) {
    out.push(ch === 'x' ? 'normal' : ch === 'X' ? 'accent' : ch === 'o' ? 'ghost' : null);
  }
  return out;
}
