/**
 * Qwen3-ASR Speech-to-Text Client
 * Transcribes audio files via the vLLM ASR endpoint.
 * Handles AMR → WAV conversion for WeCom voice messages.
 */

import { logger } from "../logger.js";
import { existsSync } from "fs";
import { readFile, unlink } from "fs/promises";
import { basename, join, dirname } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const ASR_ENDPOINT = "http://100.115.36.67:8083/v1/audio/transcriptions";
const ASR_MODEL = "qwen3-asr";
const ASR_TIMEOUT_MS = 30_000;

// Locate ffmpeg — prefer ~/bin static build, fallback to system
const FFMPEG_PATHS = [
  join(process.env.HOME || "/home/samau", "bin", "ffmpeg"),
  "/usr/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "ffmpeg",
];

function findFfmpeg() {
  for (const p of FFMPEG_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Convert AMR/non-WAV audio to WAV for ASR processing.
 * @param {string} inputPath - Path to source audio file
 * @returns {Promise<string|null>} Path to WAV file, or null if conversion failed
 */
async function convertToWav(inputPath) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    logger.warn("[asr] ffmpeg not found, cannot convert audio");
    return null;
  }

  const wavPath = inputPath + ".wav";
  try {
    await execFileAsync(ffmpeg, [
      "-y", "-i", inputPath,
      "-ar", "16000",    // 16kHz sample rate (optimal for ASR)
      "-ac", "1",        // mono
      "-f", "wav",
      wavPath,
    ], { timeout: 10_000 });
    logger.debug("[asr] converted to WAV", { input: basename(inputPath), output: basename(wavPath) });
    return wavPath;
  } catch (err) {
    logger.error("[asr] audio conversion failed", { error: err.message, inputPath });
    return null;
  }
}

/**
 * Check if a file is WAV format by reading its magic bytes.
 */
async function isWavFormat(filePath) {
  try {
    const fd = await import("fs/promises");
    const fh = await fd.open(filePath, "r");
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    await fh.close();
    return buf.toString("ascii") === "RIFF";
  } catch {
    return false;
  }
}

/**
 * Transcribe an audio file to text via Qwen3-ASR.
 * Automatically converts AMR/other formats to WAV first.
 * @param {string} filePath - Path to saved audio file
 * @returns {Promise<string|null>} Transcribed text, or null on failure
 */
export async function transcribeAudio(filePath) {
  if (!filePath || !existsSync(filePath)) {
    logger.warn("[asr] file not found for transcription", { filePath });
    return null;
  }

  let audioPath = filePath;
  let tempWav = null;

  try {
    // Convert non-WAV formats (AMR, etc.) to WAV
    const isWav = await isWavFormat(filePath);
    if (!isWav) {
      logger.debug("[asr] non-WAV audio detected, converting", { filePath: basename(filePath) });
      const wavPath = await convertToWav(filePath);
      if (!wavPath) {
        logger.error("[asr] conversion failed, cannot transcribe");
        return null;
      }
      audioPath = wavPath;
      tempWav = wavPath;
    }

    const fileBuffer = await readFile(audioPath);
    const fileName = basename(audioPath).endsWith(".wav")
      ? basename(audioPath)
      : basename(audioPath) + ".wav";

    const blob = new Blob([fileBuffer]);
    const formData = new FormData();
    formData.append("file", blob, fileName);
    formData.append("model", ASR_MODEL);

    const res = await fetch(ASR_ENDPOINT, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error("[asr] transcription HTTP error", { status: res.status, body: errText.substring(0, 200) });
      return null;
    }

    const json = await res.json();
    const text = json.text || "";

    if (text.trim()) {
      logger.info("[asr] transcription complete", {
        filePath: basename(filePath),
        textLength: text.length,
        preview: text.substring(0, 80),
        durationSec: json.usage?.seconds,
      });
    } else {
      logger.warn("[asr] transcription returned empty text", { filePath: basename(filePath) });
    }

    return text.trim() || null;
  } catch (err) {
    logger.error("[asr] transcription failed", { filePath: basename(filePath), error: err.message });
    return null;
  } finally {
    // Clean up temp WAV
    if (tempWav) {
      unlink(tempWav).catch(() => {});
    }
  }
}
