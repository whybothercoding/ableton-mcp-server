/** Reads and validates a transform's or generator's parameters with messages that name the tool and the parameter. */
import { noteNameToPitch } from './theory.js';
import { parseRate } from './rhythm.js';
import { Key, parseKey } from './theory.js';

export class ParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParamError';
  }
}

export class Params {
  constructor(private readonly label: string, private readonly values: Record<string, any> = {}) {}

  private fail(name: string, expected: string): never {
    throw new ParamError(`${this.label}: ${name} must be ${expected}`);
  }

  has(name: string): boolean {
    return this.values[name] !== undefined && this.values[name] !== null;
  }

  number(name: string, fallback?: number, min?: number, max?: number): number {
    if (!this.has(name)) {
      if (fallback === undefined) this.fail(name, 'given (a number)');
      return fallback;
    }
    const value = this.values[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) this.fail(name, 'a number');
    return this.bounded(name, value, min, max);
  }

  int(name: string, fallback?: number, min?: number, max?: number): number {
    if (!this.has(name)) {
      if (fallback === undefined) this.fail(name, 'given (a whole number)');
      return fallback;
    }
    const value = this.values[name];
    if (typeof value !== 'number' || !Number.isInteger(value)) this.fail(name, 'a whole number');
    return this.bounded(name, value, min, max);
  }

  private bounded(name: string, value: number, min?: number, max?: number): number {
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
      this.fail(name, `${min !== undefined && max !== undefined ? `between ${min} and ${max}` : min !== undefined ? `at least ${min}` : `at most ${max}`}`);
    }
    return value;
  }

  bool(name: string, fallback: boolean): boolean {
    if (!this.has(name)) return fallback;
    if (typeof this.values[name] !== 'boolean') this.fail(name, 'true or false');
    return this.values[name];
  }

  oneOf<T extends string>(name: string, options: readonly T[], fallback?: T): T {
    if (!this.has(name)) {
      if (fallback === undefined) this.fail(name, `given, one of: ${options.join(', ')}`);
      return fallback;
    }
    const value = this.values[name];
    if (typeof value !== 'string' || !options.includes(value as T)) this.fail(name, `one of: ${options.join(', ')}`);
    return value as T;
  }

  string(name: string, fallback?: string): string {
    if (!this.has(name)) {
      if (fallback === undefined) this.fail(name, 'given (a string)');
      return fallback;
    }
    if (typeof this.values[name] !== 'string') this.fail(name, 'a string');
    return this.values[name];
  }

  /** A pitch as a MIDI number or an Ableton note name ('C3' is 60). */
  pitch(name: string, fallback?: number): number {
    if (!this.has(name)) {
      if (fallback === undefined) this.fail(name, "given (a MIDI number or a note name like 'C3')");
      return fallback;
    }
    try {
      return noteNameToPitch(this.values[name]);
    } catch (err) {
      throw new ParamError(`${this.label}: ${name}: ${(err as Error).message}`);
    }
  }

  /** A duration in beats: a number, or a rate such as '1/16', '1/8t' (triplet), '1/4d' (dotted). */
  rate(name: string, fallback?: number | string): number {
    const raw = this.has(name) ? this.values[name] : fallback;
    if (raw === undefined) this.fail(name, "given (beats as a number, or a rate like '1/16')");
    try {
      return parseRate(raw);
    } catch (err) {
      throw new ParamError(`${this.label}: ${name}: ${(err as Error).message}`);
    }
  }

  key(name = 'key', fallback?: string): Key {
    const raw = this.has(name) ? this.values[name] : fallback;
    if (raw === undefined) this.fail(name, "given (for example 'C minor' or {\"root\": \"F#\", \"scale\": \"dorian\"})");
    try {
      return parseKey(raw);
    } catch (err) {
      throw new ParamError(`${this.label}: ${name}: ${(err as Error).message}`);
    }
  }

  array(name: string): any[] | undefined {
    if (!this.has(name)) return undefined;
    if (!Array.isArray(this.values[name])) this.fail(name, 'a list');
    return this.values[name];
  }

  raw(name: string): any {
    return this.values[name];
  }

  /** Refuses parameters the operation does not know, so a misspelled option is not silently ignored. */
  only(...allowed: string[]): void {
    const unknown = Object.keys(this.values).filter((k) => !allowed.includes(k) && this.values[k] !== undefined && this.values[k] !== null);
    if (unknown.length) throw new ParamError(`${this.label}: unknown parameter${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}. Known: ${allowed.join(', ')}`);
  }
}
