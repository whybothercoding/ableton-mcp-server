import { spawn } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';

const SAMPLE_RATE = 22050;
const ANALYSIS_SECONDS = 60;
const FFT_SIZE = 4096;

interface FfprobeResult {
  format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    sample_rate?: string;
    channels?: number;
    channel_layout?: string;
    bits_per_sample?: number;
    bits_per_raw_sample?: string;
  }>;
}

function runProcess(command: string, args: string[], maxBytes = 64 * 1024 * 1024): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`${command} exceeded the 120 second audio analysis timeout`));
    }, 120_000);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutLength += chunk.length;
      if (stdoutLength > maxBytes) {
        child.kill('SIGKILL');
        fail(new Error(`Audio analysis output exceeded the ${maxBytes} byte safety limit`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrLength < 1024 * 1024) {
        stderr.push(chunk);
        stderrLength += chunk.length;
      }
    });
    child.on('error', (error) => fail(error));
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${command} failed${signal ? ` (${signal})` : ` with exit code ${code}`}: ${Buffer.concat(stderr).toString('utf8').trim()}`));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

function fft(real: Float64Array, imaginary: Float64Array): void {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let weightReal = 1;
      let weightImaginary = 0;
      const half = size >> 1;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const oddReal = real[odd] * weightReal - imaginary[odd] * weightImaginary;
        const oddImaginary = real[odd] * weightImaginary + imaginary[odd] * weightReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextWeightReal = weightReal * stepReal - weightImaginary * stepImaginary;
        weightImaginary = weightReal * stepImaginary + weightImaginary * stepReal;
        weightReal = nextWeightReal;
      }
    }
  }
}

function pcmMetrics(pcm: Buffer, channelCount: number) {
  // Interleaved f32le. Peak/RMS span every channel so out-of-phase content isn't cancelled by a mono mix.
  const frameCount = Math.floor(pcm.length / (4 * channelCount));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));
  let peak = 0;
  let sumSquares = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = pcm.readFloatLE((frame * channelCount + channel) * 4);
      channels[channel][frame] = sample;
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
      sumSquares += sample * sample;
    }
  }
  const sampleCount = frameCount * channelCount;

  const bandDefinitions = [
    { name: 'sub_bass', minHz: 20, maxHz: 60 },
    { name: 'bass', minHz: 60, maxHz: 250 },
    { name: 'low_mid', minHz: 250, maxHz: 500 },
    { name: 'mid', minHz: 500, maxHz: 2000 },
    { name: 'high_mid', minHz: 2000, maxHz: 6000 },
    { name: 'high', minHz: 6000, maxHz: SAMPLE_RATE / 2 }
  ];
  const bandPower = new Array(bandDefinitions.length).fill(0);
  const windowCount = Math.max(1, Math.floor(frameCount / FFT_SIZE));
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  const binWidth = SAMPLE_RATE / FFT_SIZE;

  for (const samples of channels) {
    for (let window = 0; window < windowCount; window += 1) {
      const offset = window * FFT_SIZE;
      for (let i = 0; i < FFT_SIZE; i += 1) {
        const sample = offset + i < frameCount ? samples[offset + i] : 0;
        const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
        real[i] = sample * hann;
        imaginary[i] = 0;
      }
      fft(real, imaginary);
      for (let bin = 1; bin <= FFT_SIZE / 2; bin += 1) {
        const frequency = bin * binWidth;
        const bandIndex = bandDefinitions.findIndex((band) => frequency >= band.minHz && frequency < band.maxHz);
        if (bandIndex >= 0) {
          bandPower[bandIndex] += real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
        }
      }
    }
  }

  const totalBandPower = bandPower.reduce((total, value) => total + value, 0);
  return {
    sample_rate_hz: SAMPLE_RATE,
    analyzed_duration_seconds: frameCount / SAMPLE_RATE,
    peak_linear: peak,
    peak_dbfs: peak > 0 ? 20 * Math.log10(peak) : null,
    rms_linear: sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0,
    rms_dbfs: sampleCount > 0 && sumSquares > 0 ? 10 * Math.log10(sumSquares / sampleCount) : null,
    frequency_bands: bandDefinitions.map((band, index) => ({
      name: band.name,
      min_hz: band.minHz,
      max_hz: band.maxHz,
      relative_energy_percent: totalBandPower > 0 ? Math.round((10000 * bandPower[index]) / totalBandPower) / 100 : 0
    }))
  };
}

export async function analyzeAudioFile(filePath: string) {
  if (!filePath || typeof filePath !== 'string') throw new Error('The Live clip did not provide a source audio file path');
  const resolvedPath = filePath.trim();
  const fileStat = await stat(resolvedPath).catch(() => null);
  if (!fileStat?.isFile()) throw new Error(`Audio source file is unavailable on the MCP host: ${resolvedPath}`);
  await access(resolvedPath, constants.R_OK).catch((err: NodeJS.ErrnoException) => {
    throw new Error(`Audio source file is not readable by the MCP host (${err.code}): ${resolvedPath}`);
  });

  const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const probe = await runProcess(ffprobe, [
    '-v', 'error', '-show_entries', 'format=format_name,duration,size,bit_rate:stream=codec_type,codec_name,sample_rate,channels,channel_layout,bits_per_sample,bits_per_raw_sample',
    '-of', 'json', resolvedPath
  ]);
  const probeData = JSON.parse(probe.stdout.toString('utf8')) as FfprobeResult;
  const audioStream = probeData.streams?.find((stream) => stream.codec_type === 'audio');
  if (!audioStream) throw new Error('The clip source contains no audio stream');

  const loudnessRun = await runProcess(ffmpeg, [
    '-hide_banner', '-nostats', '-i', resolvedPath, '-filter_complex', 'ebur128=framelog=verbose', '-f', 'null', '-'
  ], 1024);
  const loudnessMatches = Array.from(loudnessRun.stderr.matchAll(/\bI:\s*(-?inf|-?\d+(?:\.\d+)?)\s*LUFS\b/gi));
  const loudnessValue = loudnessMatches.at(-1)?.[1];
  const channelCount = Math.max(1, audioStream.channels ?? 1);
  const pcmRun = await runProcess(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-i', resolvedPath, '-t', String(ANALYSIS_SECONDS),
    '-vn', '-ac', String(channelCount), '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'
  ]);

  return {
    file_path: resolvedPath,
    format: probeData.format?.format_name || null,
    duration_seconds: probeData.format?.duration ? Number(probeData.format.duration) : null,
    file_size_bytes: probeData.format?.size ? Number(probeData.format.size) : fileStat.size,
    bit_rate_bps: probeData.format?.bit_rate ? Number(probeData.format.bit_rate) : null,
    codec: audioStream.codec_name || null,
    source_sample_rate_hz: audioStream.sample_rate ? Number(audioStream.sample_rate) : null,
    channels: audioStream.channels ?? null,
    channel_layout: audioStream.channel_layout || null,
    bit_depth: audioStream.bits_per_raw_sample ? Number(audioStream.bits_per_raw_sample) : (audioStream.bits_per_sample || null),
    integrated_loudness_lufs: loudnessValue && !/inf/i.test(loudnessValue) ? Number(loudnessValue) : null,
    signal: pcmMetrics(pcmRun.stdout, channelCount),
    analysis_notes: [`Signal statistics and frequency bands use the first ${ANALYSIS_SECONDS} seconds, resampled to ${SAMPLE_RATE} Hz. Peak and RMS span all channels; bands sum per-channel spectra.`, 'Integrated loudness is measured over the full source file using the EBU R128 filter.']
  };
}
