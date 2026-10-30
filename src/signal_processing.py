#!/usr/bin/env python3
"""
audio_features.py

Extract normalized audio features from a .wav file and export them in the same
shape as makeFakeAudioFeatures() in audioData.js:

    { duration: seconds, samples: [{ time, volume, pitch, energy, ... }] }

Every feature is normalized to [0, 1]. On top of the required volume / pitch /
energy fields, each sample also carries MFCCs, chroma, spectral descriptors,
onset strength and a beat pulse. The extra fields are additive, so the existing
JS contract still holds.

Libraries: librosa does the DSP / feature extraction, torch does the
normalization, smoothing and resampling onto the output time grid.

Usage:
    python audio_features.py song.wav -o audioFeatures.js
    python audio_features.py song.wav -o audioFeatures.js --interval 0.1 --pitch-method yin

From Python:
    from audio_features import extract_audio_features, export_features_js
    feats = extract_audio_features("song.wav", sample_interval=0.25)
    export_features_js(feats, "audioFeatures.js")

Install:
    pip install librosa torch numpy soundfile
"""

import argparse
import json
import math
from pathlib import Path

import librosa
import numpy as np
import torch
import torch.nn.functional as F

DEFAULT_SR = 22050
N_FFT = 2048
HOP = 512
PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


# --------------------------------------------------------------------------- #
# Torch helpers: normalization, smoothing, resampling
# --------------------------------------------------------------------------- #

def normalize_percentile(x, lo=2.0, hi=98.0, ref=None):
    """Map values to [0, 1] using robust percentiles along the last axis.

    x:   tensor (T,) or (C, T)
    ref: optional tensor to compute the percentiles from (e.g. voiced frames only)
    A constant signal becomes all zeros.
    """
    x = torch.as_tensor(x, dtype=torch.float32)
    r = x if ref is None else torch.as_tensor(ref, dtype=torch.float32)
    lo_v = torch.quantile(r, lo / 100.0, dim=-1, keepdim=True)
    hi_v = torch.quantile(r, hi / 100.0, dim=-1, keepdim=True)
    rng = hi_v - lo_v
    out = (x - lo_v) / rng.clamp_min(1e-8)
    out = torch.where(rng > 1e-8, out, torch.zeros_like(out))
    return out.clamp(0.0, 1.0)


def gaussian_smooth(x, sigma):
    """Gaussian smoothing along time for a (C, T) tensor. sigma is in frames."""
    if sigma < 0.5:
        return x
    T = x.shape[-1]
    radius = min(int(math.ceil(3 * sigma)), T - 1)
    if radius < 1:
        return x
    k = torch.arange(-radius, radius + 1, dtype=x.dtype, device=x.device)
    k = torch.exp(-0.5 * (k / sigma) ** 2)
    k = k / k.sum()
    C = x.shape[0]
    w = k.view(1, 1, -1).repeat(C, 1, 1)
    xp = F.pad(x.unsqueeze(0), (radius, radius), mode="reflect")
    return F.conv1d(xp, w, groups=C).squeeze(0)


def peak_pool(x, window_frames):
    """Sliding max over time for a (C, T) tensor, so short accents survive resampling."""
    k = max(1, int(window_frames)) | 1  # force odd
    if k == 1:
        return x
    return F.max_pool1d(x.unsqueeze(0), kernel_size=k, stride=1, padding=k // 2).squeeze(0)


def resample_to_grid(x, frame_times, grid_times):
    """Linear interpolation of a (C, T) tensor from frame_times onto grid_times."""
    T = frame_times.shape[0]
    idx = torch.searchsorted(frame_times, grid_times).clamp(1, T - 1)
    a, b = idx - 1, idx
    span = (frame_times[b] - frame_times[a]).clamp_min(1e-9)
    f = ((grid_times - frame_times[a]) / span).clamp(0.0, 1.0)
    return x[:, a] * (1 - f) + x[:, b] * f


# --------------------------------------------------------------------------- #
# NumPy helpers
# --------------------------------------------------------------------------- #

def _fit(a, T):
    """Trim along the time axis to T frames (librosa features can differ by one frame)."""
    return a[..., :T]


def _beat_pulse(frame_times, beat_times, width=0.06):
    """Gaussian pulse (1.0 on a beat, falling off either side)."""
    if len(beat_times) == 0:
        return np.zeros_like(frame_times)
    idx = np.searchsorted(beat_times, frame_times)
    left = beat_times[np.clip(idx - 1, 0, len(beat_times) - 1)]
    right = beat_times[np.clip(idx, 0, len(beat_times) - 1)]
    d = np.minimum(np.abs(frame_times - left), np.abs(frame_times - right))
    return np.exp(-0.5 * (d / width) ** 2)


def _extract_pitch(y, sr, volume_frames, method):
    """Return (midi_filled, voiced_bool, voiced_confidence) per frame, or None if unpitched."""
    fmin, fmax = librosa.note_to_hz("C2"), librosa.note_to_hz("C7")
    if method == "pyin":
        f0, voiced, prob = librosa.pyin(
            y, fmin=fmin, fmax=fmax, sr=sr, frame_length=N_FFT, hop_length=HOP
        )
        prob = np.nan_to_num(prob, nan=0.0)
    elif method == "yin":
        f0 = librosa.yin(y, fmin=fmin, fmax=fmax, sr=sr, frame_length=N_FFT, hop_length=HOP)
        # yin has no voicing decision, so gate on loudness instead.
        voiced = volume_frames > 0.2
        prob = voiced.astype(np.float32)
    else:
        raise ValueError(f"Unknown pitch method: {method}")

    T = min(len(f0), len(volume_frames))
    f0, voiced, prob = f0[:T], voiced[:T], prob[:T]
    midi = librosa.hz_to_midi(np.where(f0 > 0, f0, np.nan))
    voiced = np.asarray(voiced, dtype=bool) & np.isfinite(midi)

    idx = np.flatnonzero(voiced)
    if idx.size < 2:
        return None
    filled = np.interp(np.arange(T), idx, midi[idx])  # hold pitch through unvoiced gaps
    return filled, voiced, prob


# --------------------------------------------------------------------------- #
# Main extractor
# --------------------------------------------------------------------------- #

def extract_audio_features(
    path,
    sample_interval=0.25,
    sr=DEFAULT_SR,
    n_mfcc=13,
    pitch_method="pyin",
    smooth_sec=None,
    device=None,
):
    """
    Load a .wav (any format librosa/soundfile can read) and return a dict matching
    the audioData.js contract, plus extra features.

    sample_interval: seconds between output samples (same meaning as the
                     `sampleRate` argument of makeFakeAudioFeatures()).
    pitch_method:    "pyin" (accurate, slow) or "yin" (fast, rougher).
    smooth_sec:      Gaussian smoothing window before sampling; defaults to
                     0.4 * sample_interval so the coarse grid doesn't alias.
    """
    device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
    y, sr = librosa.load(str(path), sr=sr, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))
    if duration < 0.1:
        raise ValueError("Audio is too short to analyze.")

    fps = sr / HOP
    smooth_sec = 0.4 * sample_interval if smooth_sec is None else smooth_sec
    sigma = smooth_sec * fps

    # ---- Frame-level features (librosa) ----
    S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP))
    rms = librosa.feature.rms(S=S, frame_length=N_FFT, hop_length=HOP)[0]
    zcr = librosa.feature.zero_crossing_rate(y, frame_length=N_FFT, hop_length=HOP)[0]
    centroid = librosa.feature.spectral_centroid(S=S, sr=sr)[0]
    bandwidth = librosa.feature.spectral_bandwidth(S=S, sr=sr)[0]
    rolloff = librosa.feature.spectral_rolloff(S=S, sr=sr)[0]
    flatness = librosa.feature.spectral_flatness(S=S)[0]
    contrast = librosa.feature.spectral_contrast(S=S, sr=sr)
    chroma = librosa.feature.chroma_stft(S=S ** 2, sr=sr)
    mel = librosa.feature.melspectrogram(S=S ** 2, sr=sr, n_mels=64)
    mfcc = librosa.feature.mfcc(S=librosa.power_to_db(mel), n_mfcc=n_mfcc)
    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    tempo, beat_frames = librosa.beat.beat_track(onset_envelope=onset, sr=sr, hop_length=HOP)
    tempo = float(np.atleast_1d(tempo)[0])

    # Volume: RMS in dB relative to the loudest frame, 60 dB range -> [0, 1].
    peak = float(rms.max())
    if peak <= 0:
        volume = np.zeros_like(rms)
    else:
        db = librosa.amplitude_to_db(rms, ref=peak, top_db=60.0)
        volume = (db + 60.0) / 60.0

    # Make every feature the same length.
    T = min(a.shape[-1] for a in
            (rms, zcr, centroid, bandwidth, rolloff, flatness, contrast, chroma, mfcc, onset))
    volume, zcr, centroid, bandwidth, rolloff, flatness, onset = (
        _fit(a, T) for a in (volume, zcr, centroid, bandwidth, rolloff, flatness, onset)
    )
    contrast, chroma, mfcc = (_fit(a, T) for a in (contrast, chroma, mfcc))
    frame_times = librosa.frames_to_time(np.arange(T), sr=sr, hop_length=HOP)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP)
    beat = _beat_pulse(frame_times, beat_times)

    # Pitch: log-frequency (MIDI), gaps filled, normalized over the voiced range.
    pitch_result = _extract_pitch(y, sr, volume, pitch_method)
    if pitch_result is not None:
        midi, voiced, voiced_conf = pitch_result
        midi, voiced, voiced_conf = _fit(midi, T), _fit(voiced, T), _fit(voiced_conf, T)
        midi_t = torch.as_tensor(midi, dtype=torch.float32)
        pitch = normalize_percentile(midi_t, 2, 98, ref=midi_t[torch.as_tensor(voiced)]).numpy()
        pitch_source = pitch_method
    else:  # unpitched material (noise, drums): fall back to spectral brightness
        pitch = normalize_percentile(torch.as_tensor(centroid)).numpy()
        voiced_conf = np.zeros(T, dtype=np.float32)
        pitch_source = "spectral_centroid_fallback"

    # ---- Normalize to [0, 1] (torch) ----
    n = lambda a: normalize_percentile(torch.as_tensor(np.asarray(a), dtype=torch.float32)).to(device)
    as_t = lambda a: torch.as_tensor(np.asarray(a), dtype=torch.float32, device=device)

    # Smoothed "mean" group, in a single (C, T) tensor with a layout table.
    mean_blocks = [
        ("volume", as_t(np.clip(volume, 0, 1))[None]),
        ("pitch", as_t(pitch)[None]),
        ("voiced", as_t(np.clip(voiced_conf, 0, 1))[None]),
        ("brightness", n(centroid)[None]),
        ("bandwidth", n(bandwidth)[None]),
        ("rolloff", n(rolloff)[None]),
        ("flatness", as_t(np.clip(flatness, 0, 1))[None]),
        ("zeroCrossing", n(zcr)[None]),
        ("mfcc", n(mfcc)),
        ("chroma", as_t(np.clip(chroma, 0, 1))),
        ("contrast", n(contrast)),
    ]
    # Peaky "accent" group: max-pooled instead of averaged so beats aren't smeared out.
    peak_blocks = [
        ("onset", n(onset)[None]),
        ("beat", as_t(beat)[None]),
    ]

    def stack(blocks):
        layout, start = [], 0
        for name, arr in blocks:
            layout.append((name, start, arr.shape[0]))
            start += arr.shape[0]
        return torch.cat([b[1] for b in blocks], dim=0), layout

    mean_all, mean_layout = stack(mean_blocks)
    peak_all, peak_layout = stack(peak_blocks)

    # ---- Resample onto the output grid ----
    count = math.ceil(duration / sample_interval)
    times = np.minimum(np.arange(count + 1) * sample_interval, duration)
    ft = as_t(frame_times)
    gt = as_t(times)

    window_frames = int(round(sample_interval * fps))
    mean_grid = resample_to_grid(gaussian_smooth(mean_all, sigma), ft, gt).clamp(0, 1)
    peak_grid = resample_to_grid(peak_pool(peak_all, window_frames), ft, gt).clamp(0, 1)

    grid = {}
    for src, layout in ((mean_grid.cpu().numpy(), mean_layout), (peak_grid.cpu().numpy(), peak_layout)):
        for name, start, k in layout:
            grid[name] = src[start] if (k == 1 and name != "mfcc") else src[start:start + k].T

    # Energy: loudness plus accents, same spirit as the fake generator.
    energy = np.clip(0.55 * grid["volume"] + 0.30 * grid["onset"] + 0.15 * grid["beat"], 0, 1)
    grid["energy"] = energy

    # ---- Assemble samples ----
    scalar_order = ["volume", "pitch", "energy", "voiced", "brightness", "bandwidth", "rolloff",
                    "flatness", "zeroCrossing", "onset", "beat"]
    vector_order = ["mfcc", "chroma", "contrast"]
    r = lambda v: np.round(v, 4).tolist()

    samples = []
    for i in range(len(times)):
        s = {"time": round(float(times[i]), 3)}
        for name in scalar_order:
            s[name] = round(float(grid[name][i]), 4)
        for name in vector_order:
            s[name] = r(grid[name][i])
        samples.append(s)

    chroma_mean = chroma.mean(axis=1)
    summary = {
        "tempo": round(tempo, 2),
        "meanVolume": round(float(np.mean(grid["volume"])), 4),
        "meanBrightness": round(float(np.mean(grid["brightness"])), 4),
        "dominantPitchClass": PITCH_CLASSES[int(np.argmax(chroma_mean))],
        "mfccMean": r(np.mean(grid["mfcc"], axis=0)),
    }

    return {
        "duration": round(duration, 3),
        "sampleInterval": sample_interval,
        "sourceFile": Path(path).name,
        "analysisSampleRate": sr,
        "pitchSource": pitch_source,
        "mfccCount": int(n_mfcc),
        "summary": summary,
        "beatTimes": [round(float(t), 3) for t in beat_times],
        "samples": samples,
    }


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #

def export_features_js(features, out_path, export_name="audioFeatures"):
    """Write the features as an ES module: `export const audioFeatures = {...}`."""
    compact = lambda v: json.dumps(v, separators=(",", ":"))
    head = [f"  {k}: {compact(v)}" for k, v in features.items() if k != "samples"]
    rows = ["    " + compact(s) for s in features["samples"]]
    body = ",\n".join(head) + ",\n  samples: [\n" + ",\n".join(rows) + "\n  ]"

    text = (
        "/**\n"
        f" * Audio features extracted from {features.get('sourceFile', 'audio')} by audio_features.py.\n"
        " * Contract: { duration, samples: [{ time, volume, pitch, energy, ... }] }, all features in [0, 1].\n"
        " * Auto-generated: re-run the Python script instead of editing by hand.\n"
        " */\n"
        f"export const {export_name} = {{\n{body}\n}};\n\n"
        f"export default {export_name};\n"
    )
    Path(out_path).write_text(text, encoding="utf-8")
    return out_path


def export_features_json(features, out_path):
    Path(out_path).write_text(json.dumps(features, separators=(",", ":")), encoding="utf-8")
    return out_path


def main():
    p = argparse.ArgumentParser(description="Extract audio features from a .wav and export to .js")
    p.add_argument("wav", help="input audio file (.wav)")
    p.add_argument("-o", "--output", help="output .js path (default: <wav name>.features.js)")
    p.add_argument("--json", help="also write a plain .json copy to this path")
    p.add_argument("--interval", type=float, default=0.25, help="seconds between samples (default 0.25)")
    p.add_argument("--sr", type=int, default=DEFAULT_SR, help="analysis sample rate (default 22050)")
    p.add_argument("--n-mfcc", type=int, default=13, help="number of MFCCs (default 13)")
    p.add_argument("--pitch-method", choices=["pyin", "yin"], default="pyin",
                   help="pyin is more accurate but slow on long files; yin is fast")
    p.add_argument("--smooth", type=float, default=None,
                   help="smoothing window in seconds (default 0.4 * interval)")
    p.add_argument("--export-name", default="audioFeatures", help="JS export name")
    p.add_argument("--device", default=None, help="torch device, e.g. cpu or cuda")
    args = p.parse_args()

    out = args.output or str(Path(args.wav).with_suffix("")) + ".features.js"
    feats = extract_audio_features(
        args.wav,
        sample_interval=args.interval,
        sr=args.sr,
        n_mfcc=args.n_mfcc,
        pitch_method=args.pitch_method,
        smooth_sec=args.smooth,
        device=args.device,
    )
    export_features_js(feats, out, args.export_name)
    print(f"Wrote {out}  ({len(feats['samples'])} samples, {feats['duration']}s, "
          f"tempo {feats['summary']['tempo']} BPM, pitch via {feats['pitchSource']})")
    if args.json:
        export_features_json(feats, args.json)
        print(f"Wrote {args.json}")


if __name__ == "__main__":
    main()
