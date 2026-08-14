/**
 * Media compression utilities for ZeroChat-TS
 * Handles image compression, audio conversion, and video compression
 */

import imageCompression from 'browser-image-compression';

/**
 * Image compression options for photo mode
 */
export interface ImageCompressionOptions {
  maxWidthOrHeight: number;
  initialQuality: number;
  fileType: string;
  useWebWorker: boolean;
  preserveExif: boolean;
}

/**
 * Default compression options for photos
 */
export const DEFAULT_PHOTO_COMPRESSION_OPTIONS: ImageCompressionOptions = {
  maxWidthOrHeight: 1024,
  initialQuality: 0.8,
  fileType: 'image/jpeg',
  useWebWorker: true,
  preserveExif: false,
};

/**
 * Video compression options
 */
export interface VideoCompressionOptions {
  maxWidth: number;
  maxHeight: number;
  videoBitrate: number; // in kbps
  audioBitrate: number; // in kbps
  targetFormat: string;
}

/**
 * Default compression options for videos
 */
export const DEFAULT_VIDEO_COMPRESSION_OPTIONS: VideoCompressionOptions = {
  maxWidth: 1280, // 720p
  maxHeight: 720,
  videoBitrate: 2000, // 2 Mbps
  audioBitrate: 128, // 128 kbps
  targetFormat: 'video/mp4',
};

/**
 * Audio compression options
 */
export interface AudioCompressionOptions {
  sampleRate: number;
  kbps: number;
  channels: number;
}

/**
 * Default compression options for audio
 */
export const DEFAULT_AUDIO_COMPRESSION_OPTIONS: AudioCompressionOptions = {
  sampleRate: 44100,
  kbps: 128,
  channels: 2,
};

/**
 * Detect media type from file
 */
export function detectMediaType(file: File): 'image' | 'video' | 'audio' | 'file' {
  const mimeType = file.type.toLowerCase();

  if (mimeType.startsWith('image/')) {
    return 'image';
  }

  if (mimeType.startsWith('video/')) {
    return 'video';
  }

  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }

  // Check file extension as fallback
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
  const videoExtensions = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'];
  const audioExtensions = ['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a', 'wma'];

  if (imageExtensions.includes(extension)) {
    return 'image';
  }

  if (videoExtensions.includes(extension)) {
    return 'video';
  }

  if (audioExtensions.includes(extension)) {
    return 'audio';
  }

  return 'file';
}

/**
 * Load image from File
 */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/**
 * Canvas-based image compression fallback
 * Used when browser-image-compression is unavailable
 */
export async function compressImageFallback(
  file: File,
  options: Partial<ImageCompressionOptions> = {}
): Promise<Blob> {
  const opts = { ...DEFAULT_PHOTO_COMPRESSION_OPTIONS, ...options };
  const image = await loadImage(file);

  // Calculate new dimensions
  let { width, height } = image;
  const maxDim = opts.maxWidthOrHeight;

  if (width > maxDim || height > maxDim) {
    if (width > height) {
      height = Math.round((height * maxDim) / width);
      width = maxDim;
    } else {
      width = Math.round((width * maxDim) / height);
      height = maxDim;
    }
  }

  // Create canvas
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }

  // Draw image with white background (for JPEG)
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);

  // Revoke object URL to free memory
  URL.revokeObjectURL(image.src);

  // Convert to blob
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Canvas toBlob returned null'));
        }
      },
      opts.fileType,
      opts.initialQuality
    );
  });
}

/**
 * Compress image for sending as photo
 * Uses browser-image-compression with canvas fallback
 */
export async function compressImageForPhoto(
  file: File,
  options: Partial<ImageCompressionOptions> = {}
): Promise<Blob> {
  const opts = { ...DEFAULT_PHOTO_COMPRESSION_OPTIONS, ...options };

  // Skip compression for small images
  if (file.size < 100 * 1024) {
    // Less than 100KB
    const img = await loadImage(file);
    URL.revokeObjectURL(img.src);
    if (img.width <= opts.maxWidthOrHeight && img.height <= opts.maxWidthOrHeight) {
      return file;
    }
  }

  try {
    // Try using browser-image-compression library
    const compressedFile = await imageCompression(file, {
      maxWidthOrHeight: opts.maxWidthOrHeight,
      initialQuality: opts.initialQuality,
      fileType: opts.fileType,
      useWebWorker: opts.useWebWorker,
      preserveExif: opts.preserveExif,
    });

    return compressedFile;
  } catch (error) {
    console.warn('browser-image-compression failed, using canvas fallback:', error);
    // Fallback to canvas-based compression
    return compressImageFallback(file, opts);
  }
}

/**
 * Get video dimensions and duration
 */
export function getVideoMetadata(file: File): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      resolve({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
      });
    };

    video.onerror = () => {
      URL.revokeObjectURL(video.src);
      reject(new Error('Failed to load video metadata'));
    };

    video.src = URL.createObjectURL(file);
  });
}

/**
 * Video compression using FFmpeg.wasm (placeholder implementation)
 * This is a structure for future FFmpeg.wasm integration
 */
export async function compressVideoForSending(
  file: File,
  options: Partial<VideoCompressionOptions> = {}
): Promise<Blob> {
  const opts = { ...DEFAULT_VIDEO_COMPRESSION_OPTIONS, ...options };

  // Check if video needs compression
  const metadata = await getVideoMetadata(file);

  // If video is already small enough, return as-is
  const needsResize = metadata.width > opts.maxWidth || metadata.height > opts.maxHeight;
  const needsCompression = file.size > 10 * 1024 * 1024; // 10MB

  if (!needsResize && !needsCompression) {
    return file;
  }

  // Placeholder: In production, this would use FFmpeg.wasm
  // For now, return original file
  // TODO: Implement FFmpeg.wasm compression
  // Example structure:
  // const ffmpeg = await loadFFmpeg();
  // await ffmpeg.writeFile('input.mp4', await fetchFile(file));
  // await ffmpeg.exec([
  //   '-i', 'input.mp4',
  //   '-vf', `scale=${opts.maxWidth}:${opts.maxHeight}:force_original_aspect_ratio=decrease`,
  //   '-c:v', 'libx264',
  //   '-b:v', `${opts.videoBitrate}k`,
  //   '-c:a', 'aac',
  //   '-b:a', `${opts.audioBitrate}k`,
  //   'output.mp4'
  // ]);
  // const data = await ffmpeg.readFile('output.mp4');
  // return new Blob([data], { type: 'video/mp4' });

  return file;
}

/**
 * Decode audio file to AudioBuffer
 */
async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  return audioContext.decodeAudioData(arrayBuffer);
}

/**
 * Convert AudioBuffer to Int16Array samples
 */
function audioBufferToSamples(buffer: AudioBuffer): Int16Array {
  const length = buffer.length * buffer.numberOfChannels;
  const result = new Int16Array(length);

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < buffer.length; i++) {
      const sample = channelData[i] ?? 0;
      result[i * buffer.numberOfChannels + channel] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
  }

  return result;
}

/**
 * Convert audio file to MP3 using lamejs
 */
export async function convertAudioToMp3(
  file: File,
  options: Partial<AudioCompressionOptions> = {}
): Promise<Blob> {
  const opts = { ...DEFAULT_AUDIO_COMPRESSION_OPTIONS, ...options };

  // If already MP3, return as-is
  if (file.type === 'audio/mpeg' || file.name.endsWith('.mp3')) {
    return file;
  }

  try {
    // Dynamic import of lamejs to avoid loading it unnecessarily
    const lamejs = await import('lamejs');
    const { Mp3Encoder } = lamejs;

    // Decode audio file
    const audioBuffer = await decodeAudioFile(file);

    // Resample to target sample rate if needed
    let samples: Int16Array;
    if (audioBuffer.sampleRate !== opts.sampleRate) {
      // Simple resampling (not perfect but works)
      const ratio = opts.sampleRate / audioBuffer.sampleRate;
      const newLength = Math.floor(audioBuffer.length * ratio);
      samples = new Int16Array(newLength * audioBuffer.numberOfChannels);

      for (let i = 0; i < newLength; i++) {
        const srcIndex = Math.floor(i / ratio);
        for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
          const channelData = audioBuffer.getChannelData(channel);
          const sample = channelData[srcIndex] ?? 0;
          samples[i * audioBuffer.numberOfChannels + channel] =
            sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
      }
    } else {
      samples = audioBufferToSamples(audioBuffer);
    }

    // Encode to MP3
    const encoder = new Mp3Encoder(
      Math.min(opts.channels, audioBuffer.numberOfChannels),
      opts.sampleRate,
      opts.kbps
    );

    const mp3Data: Int8Array[] = [];
    const sampleBlockSize = 1152; // MP3 frame size

    // Convert interleaved samples to planar format for lamejs
    const numChannels = Math.min(opts.channels, audioBuffer.numberOfChannels);
    const numSamples = samples.length / audioBuffer.numberOfChannels;

    for (let i = 0; i < numSamples; i += sampleBlockSize) {
      const blockSize = Math.min(sampleBlockSize, numSamples - i);
      const left = new Int16Array(blockSize);
      const right = numChannels > 1 ? new Int16Array(blockSize) : left;

      for (let j = 0; j < blockSize; j++) {
        const idx = (i + j) * audioBuffer.numberOfChannels;
        const leftSample = samples[idx];
        left[j] = leftSample !== undefined ? leftSample : 0;
        if (numChannels > 1) {
          const rightSample = audioBuffer.numberOfChannels > 1 ? samples[idx + 1] : undefined;
          right[j] = rightSample !== undefined ? Number(rightSample) : Number(left[j]);
        }
      }

      const mp3Buffer = encoder.encodeBuffer(left, right);
      if (mp3Buffer.length > 0) {
        mp3Data.push(mp3Buffer);
      }
    }

    // Flush remaining data
    const finalBuffer = encoder.flush();
    if (finalBuffer.length > 0) {
      mp3Data.push(finalBuffer);
    }

    // Combine all MP3 data
    const totalLength = mp3Data.reduce((acc, buf) => acc + buf.length, 0);
    const mp3Blob = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of mp3Data) {
      mp3Blob.set(buf, offset);
      offset += buf.length;
    }

    return new Blob([mp3Blob], { type: 'audio/mpeg' });
  } catch (error) {
    console.error('Audio conversion failed:', error);
    // Return original file if conversion fails
    return file;
  }
}

/**
 * Get image dimensions
 */
export function getImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      resolve({ width: img.width, height: img.height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error('Failed to load image'));
    };
    img.src = URL.createObjectURL(file);
  });
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
