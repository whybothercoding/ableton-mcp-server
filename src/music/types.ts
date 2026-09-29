/** A MIDI note as get_notes returns it (ids only exist for notes already in a clip). Beats are quarter notes. */
export interface Note {
  pitch: number;
  start_time: number;
  duration: number;
  velocity: number;
  mute?: boolean;
  probability?: number;
  velocity_deviation?: number;
  release_velocity?: number;
  id?: number;
}

export const MIN_PITCH = 0;
export const MAX_PITCH = 127;
/** Notes shorter than this are refused by nothing in Live, but are inaudible; transforms never produce them. */
export const MIN_DURATION = 1 / 128;
export const EPS = 1e-6;

export const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
export const mod = (n: number, m: number): number => ((n % m) + m) % m;
