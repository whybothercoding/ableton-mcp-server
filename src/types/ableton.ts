/**
 * Ableton Remote Script protocol types and interfaces
 */

export interface ScriptInfo {
  script_version: string;
  capabilities: string[];
}

export interface SessionInfo {
  tempo: number;
  signature_numerator: number;
  signature_denominator: number;
  track_count: number;
  return_track_count: number;
  master_track: {
    name: string;
    volume: number;
    panning: number;
  };
}

export interface ClipInfo {
  name: string;
  length: number;
  is_playing: boolean;
  is_recording: boolean;
}

export interface ClipSlotInfo {
  index: number;
  has_clip: boolean;
  clip?: ClipInfo | null;
}

export interface DeviceInfo {
  index: number;
  name: string;
  class_name: string;
  type: string;
}

export interface ArrangementClipInfo {
  name: string;
  start_time: number;
  length: number;
  muted: boolean;
  is_midi_clip?: boolean;
}

export interface TrackInfo {
  index: number;
  name: string;
  is_group: boolean;
  is_grouped: boolean;
  group_track_name?: string | null;
  is_audio_track: boolean;
  is_midi_track: boolean;
  mute: boolean;
  solo: boolean;
  can_be_armed: boolean;
  arm: boolean;
  volume: number;
  panning: number;
  clip_slots: ClipSlotInfo[];
  arrangement_clips?: ArrangementClipInfo[];
  devices: DeviceInfo[];
}

export interface MidiNote {
  pitch: number;
  start_time: number;
  duration: number;
  velocity: number;
  mute?: boolean;
}

export interface DeviceParameter {
  index: number;
  name: string;
  value: number;
  min: number;
  max: number;
}

export interface DeviceParametersResult {
  device_name: string;
  parameters: DeviceParameter[];
}

export interface BrowserItem {
  name: string;
  is_folder: boolean;
  is_device: boolean;
  is_loadable: boolean;
  uri?: string | null;
  children?: BrowserItem[];
}

export interface BrowserTreeResult {
  type: string;
  categories: BrowserItem[];
  available_categories?: string[];
}

export interface BrowserItemsAtPathResult {
  path: string;
  name?: string;
  uri?: string | null;
  is_folder?: boolean;
  is_device?: boolean;
  is_loadable?: boolean;
  items: BrowserItem[];
  error?: string;
  available_categories?: string[];
}

export interface BulkSessionStructure {
  session: SessionInfo;
  scenes: Array<{ index: number; name: string }>;
  tracks: Array<{
    index: number;
    name: string;
    is_group: boolean;
    is_grouped: boolean;
    group_track_name?: string | null;
    is_audio_track: boolean;
    is_midi_track: boolean;
    mute: boolean;
    solo: boolean;
    can_be_armed: boolean;
    arm: boolean;
    volume: number;
    panning: number;
    playing_slot_index: number;
    clips: Array<{
      slot_index: number;
      name: string;
      is_playing: boolean;
      is_recording: boolean;
    }>;
    device_count: number;
  }>;
}

export interface RemoteScriptResponse<T = any> {
  status: 'success' | 'error';
  result?: T;
  message?: string;
}

export interface RemoteScriptCommand {
  type: string;
  params?: Record<string, any>;
}
