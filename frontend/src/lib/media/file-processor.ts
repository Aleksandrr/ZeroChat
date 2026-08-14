/**
 * File processor for ZeroChat-TS
 * Handles file processing based on send mode (photo, video, audio, file)
 */

import {
  type AudioCompressionOptions,
  compressImageForPhoto,
  compressVideoForSending,
  convertAudioToMp3,
  DEFAULT_AUDIO_COMPRESSION_OPTIONS,
  DEFAULT_PHOTO_COMPRESSION_OPTIONS,
  DEFAULT_VIDEO_COMPRESSION_OPTIONS,
  detectMediaType,
  formatBytes,
  getImageDimensions,
  getVideoMetadata,
  type ImageCompressionOptions,
  type VideoCompressionOptions,
} from './compression';

/**
 * Send mode for file processing
 */
export type SendMode = 'photo' | 'video' | 'audio' | 'file';

/**
 * Result of file processing
 */
export interface ProcessedFile {
  /** Processed blob */
  blob: Blob;
  /** Original file name (may be modified for extension) */
  fileName: string;
  /** MIME type of processed file */
  mimeType: string;
  /** Original file size in bytes */
  originalSize: number;
  /** Compressed file size in bytes */
  compressedSize: number;
  /** Whether compression was applied */
  wasCompressed: boolean;
  /** Image/video dimensions (if applicable) */
  dimensions?: { width: number; height: number };
  /** Media duration in seconds (if applicable) */
  duration?: number;
  /** Compression ratio (0-1) */
  compressionRatio?: number;
}

/**
 * Processing options
 */
export interface ProcessingOptions {
  /** Override detected send mode */
  mode?: SendMode;
  /** Custom image compression options */
  imageOptions?: Partial<ImageCompressionOptions>;
  /** Custom video compression options */
  videoOptions?: Partial<VideoCompressionOptions>;
  /** Custom audio compression options */
  audioOptions?: Partial<AudioCompressionOptions>;
  /** Maximum file size in bytes (default: 50MB) */
  maxFileSize?: number;
  /** Whether to skip compression for small files */
  skipCompressionIfSmall?: boolean;
  /** Threshold for small files in bytes (default: 100KB) */
  smallFileThreshold?: number;
}

/**
 * Processing error types
 */
export class FileProcessingError extends Error {
  constructor(
    message: string,
    public readonly code: 'SIZE_EXCEEDED' | 'INVALID_TYPE' | 'COMPRESSION_FAILED' | 'UNKNOWN'
  ) {
    super(message);
    this.name = 'FileProcessingError';
  }
}

/**
 * Get appropriate file extension for MIME type
 */
function getExtensionForMimeType(mimeType: string, originalName: string): string {
  const mimeToExt: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/aac': 'aac',
  };

  const ext = mimeToExt[mimeType];
  if (ext) {
    return ext;
  }

  // Fallback to original extension
  const originalExt = originalName.split('.').pop();
  return originalExt || 'bin';
}

/**
 * Update file name with new extension
 */
function updateFileName(originalName: string, newMimeType: string): string {
  const baseName = originalName.replace(/\.[^/.]+$/, '');
  const newExt = getExtensionForMimeType(newMimeType, originalName);
  return `${baseName}.${newExt}`;
}

/**
 * Validate file before processing
 */
function validateFile(file: File, maxSize: number): void {
  if (file.size > maxSize) {
    throw new FileProcessingError(
      `File size ${formatBytes(file.size)} exceeds maximum allowed size ${formatBytes(maxSize)}`,
      'SIZE_EXCEEDED'
    );
  }
}

/**
 * Process image file for photo mode
 */
async function processImageFile(
  file: File,
  options: ProcessingOptions
): Promise<ProcessedFile> {
  const originalSize = file.size;
  const imageOptions = { ...DEFAULT_PHOTO_COMPRESSION_OPTIONS, ...options.imageOptions };

  // Get original dimensions
  let dimensions: { width: number; height: number } | undefined;
  try {
    dimensions = await getImageDimensions(file);
  } catch {
    // Ignore dimension errors
  }

  // Skip compression for small images if enabled
  if (
    options.skipCompressionIfSmall !== false &&
    file.size < (options.smallFileThreshold ?? 100 * 1024)
  ) {
    const needsResize = dimensions
      ? dimensions.width > imageOptions.maxWidthOrHeight ||
        dimensions.height > imageOptions.maxWidthOrHeight
      : false;

    if (!needsResize) {
      return {
        blob: file,
        fileName: file.name,
        mimeType: file.type || 'image/jpeg',
        originalSize,
        compressedSize: originalSize,
        wasCompressed: false,
        dimensions,
        compressionRatio: 1,
      };
    }
  }

  // Compress image
  try {
    const compressedBlob = await compressImageForPhoto(file, imageOptions);
    const wasCompressed = compressedBlob.size < originalSize;

    return {
      blob: compressedBlob,
      fileName: updateFileName(file.name, imageOptions.fileType),
      mimeType: imageOptions.fileType,
      originalSize,
      compressedSize: compressedBlob.size,
      wasCompressed,
      dimensions: wasCompressed
        ? {
            width: Math.min(dimensions?.width ?? imageOptions.maxWidthOrHeight, imageOptions.maxWidthOrHeight),
            height: Math.min(dimensions?.height ?? imageOptions.maxWidthOrHeight, imageOptions.maxWidthOrHeight),
          }
        : dimensions,
      compressionRatio: originalSize > 0 ? compressedBlob.size / originalSize : 1,
    };
  } catch (error) {
    console.error('Image compression failed:', error);
    throw new FileProcessingError(
      'Failed to compress image',
      'COMPRESSION_FAILED'
    );
  }
}

/**
 * Process video file
 */
async function processVideoFile(
  file: File,
  options: ProcessingOptions
): Promise<ProcessedFile> {
  const originalSize = file.size;

  // Get video metadata
  let metadata: { width: number; height: number; duration: number } | undefined;
  try {
    metadata = await getVideoMetadata(file);
  } catch {
    // Ignore metadata errors
  }

  // For now, video compression is a placeholder
  // In production, this would use FFmpeg.wasm
  const videoOptions = { ...DEFAULT_VIDEO_COMPRESSION_OPTIONS, ...options.videoOptions };

  try {
    const processedBlob = await compressVideoForSending(file, videoOptions);
    const wasCompressed = processedBlob.size < originalSize;

    return {
      blob: processedBlob,
      fileName: file.name,
      mimeType: file.type || videoOptions.targetFormat,
      originalSize,
      compressedSize: processedBlob.size,
      wasCompressed,
      dimensions: metadata ? { width: metadata.width, height: metadata.height } : undefined,
      duration: metadata?.duration,
      compressionRatio: originalSize > 0 ? processedBlob.size / originalSize : 1,
    };
  } catch (error) {
    console.error('Video processing failed:', error);
    // Return original file on error
    return {
      blob: file,
      fileName: file.name,
      mimeType: file.type || videoOptions.targetFormat,
      originalSize,
      compressedSize: originalSize,
      wasCompressed: false,
      dimensions: metadata ? { width: metadata.width, height: metadata.height } : undefined,
      duration: metadata?.duration,
      compressionRatio: 1,
    };
  }
}

/**
 * Process audio file
 */
async function processAudioFile(
  file: File,
  options: ProcessingOptions
): Promise<ProcessedFile> {
  const originalSize = file.size;
  const audioOptions = { ...DEFAULT_AUDIO_COMPRESSION_OPTIONS, ...options.audioOptions };

  // Skip if already MP3 and small enough
  if (
    (file.type === 'audio/mpeg' || file.name.endsWith('.mp3')) &&
    options.skipCompressionIfSmall !== false &&
    file.size < (options.smallFileThreshold ?? 100 * 1024)
  ) {
    return {
      blob: file,
      fileName: file.name,
      mimeType: 'audio/mpeg',
      originalSize,
      compressedSize: originalSize,
      wasCompressed: false,
      compressionRatio: 1,
    };
  }

  // Convert to MP3
  try {
    const convertedBlob = await convertAudioToMp3(file, audioOptions);
    const wasCompressed = convertedBlob.size < originalSize || file.type !== 'audio/mpeg';

    return {
      blob: convertedBlob,
      fileName: updateFileName(file.name, 'audio/mpeg'),
      mimeType: 'audio/mpeg',
      originalSize,
      compressedSize: convertedBlob.size,
      wasCompressed,
      compressionRatio: originalSize > 0 ? convertedBlob.size / originalSize : 1,
    };
  } catch (error) {
    console.error('Audio conversion failed:', error);
    // Return original file on error
    return {
      blob: file,
      fileName: file.name,
      mimeType: file.type || 'audio/mpeg',
      originalSize,
      compressedSize: originalSize,
      wasCompressed: false,
      compressionRatio: 1,
    };
  }
}

/**
 * Process file without compression
 */
function processAsFile(file: File): ProcessedFile {
  return {
    blob: file,
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    originalSize: file.size,
    compressedSize: file.size,
    wasCompressed: false,
    compressionRatio: 1,
  };
}

/**
 * Main file processing function
 * Processes file based on send mode or auto-detects type
 *
 * @param file - File to process
 * @param mode - Send mode (auto-detected if not provided)
 * @param options - Processing options
 * @returns Processed file information
 *
 * @example
 * ```typescript
 * // Process as photo (compresses image)
 * const processed = await processFileForSending(imageFile, 'photo');
 *
 * // Auto-detect type
 * const processed = await processFileForSending(file);
 *
 * // With options
 * const processed = await processFileForSending(file, 'photo', {
 *   imageOptions: { maxWidthOrHeight: 2048, initialQuality: 0.9 }
 * });
 * ```
 */
export async function processFileForSending(
  file: File,
  mode?: SendMode,
  options: ProcessingOptions = {}
): Promise<ProcessedFile> {
  // Validate file
  const maxSize = options.maxFileSize ?? 50 * 1024 * 1024; // 50MB default
  validateFile(file, maxSize);

  // Detect or use provided mode
  const sendMode = mode ?? (() => {
    const mediaType = detectMediaType(file);
    switch (mediaType) {
      case 'image':
        return 'photo';
      case 'video':
        return 'video';
      case 'audio':
        return 'audio';
      default:
        return 'file';
    }
  })();

  // Process based on mode
  switch (sendMode) {
    case 'photo':
      if (detectMediaType(file) !== 'image') {
        throw new FileProcessingError(
          'File is not an image but photo mode was specified',
          'INVALID_TYPE'
        );
      }
      return processImageFile(file, options);

    case 'video':
      if (detectMediaType(file) !== 'video') {
        throw new FileProcessingError(
          'File is not a video but video mode was specified',
          'INVALID_TYPE'
        );
      }
      return processVideoFile(file, options);

    case 'audio':
      if (detectMediaType(file) !== 'audio') {
        throw new FileProcessingError(
          'File is not audio but audio mode was specified',
          'INVALID_TYPE'
        );
      }
      return processAudioFile(file, options);

    case 'file':
    default:
      return processAsFile(file);
  }
}

/**
 * Batch process multiple files
 *
 * @param files - Array of files to process
 * @param mode - Send mode (applied to all files)
 * @param options - Processing options
 * @returns Array of processed files
 */
export async function processFilesForSending(
  files: File[],
  mode?: SendMode,
  options: ProcessingOptions = {}
): Promise<ProcessedFile[]> {
  const results: ProcessedFile[] = [];
  const errors: { file: string; error: Error }[] = [];

  for (const file of files) {
    try {
      const processed = await processFileForSending(file, mode, options);
      results.push(processed);
    } catch (error) {
      console.error(`Failed to process file ${file.name}:`, error);
      errors.push({ file: file.name, error: error as Error });
    }
  }

  if (errors.length > 0) {
    console.warn(`Failed to process ${errors.length} files:`, errors);
  }

  return results;
}

/**
 * Check if file can be processed
 *
 * @param file - File to check
 * @param mode - Optional send mode to validate against
 * @returns Validation result
 */
export function canProcessFile(
  file: File,
  mode?: SendMode
): { valid: boolean; reason?: string } {
  // Check file size (50MB max)
  const maxSize = 50 * 1024 * 1024;
  if (file.size > maxSize) {
    return {
      valid: false,
      reason: `File too large: ${formatBytes(file.size)} (max ${formatBytes(maxSize)})`,
    };
  }

  // If mode is specified, validate file type matches
  if (mode) {
    const mediaType = detectMediaType(file);
    const typeMap: Record<SendMode, 'image' | 'video' | 'audio' | 'file'> = {
      photo: 'image',
      video: 'video',
      audio: 'audio',
      file: 'file',
    };

    if (mode !== 'file' && mediaType !== typeMap[mode]) {
      return {
        valid: false,
        reason: `File type ${mediaType} does not match send mode ${mode}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Get processing summary for UI display
 *
 * @param processed - Processed file
 * @returns Human-readable summary
 */
export function getProcessingSummary(processed: ProcessedFile): string {
  const parts: string[] = [];

  if (processed.wasCompressed) {
    const savings = ((1 - processed.compressionRatio!) * 100).toFixed(1);
    parts.push(`Compressed: ${savings}% smaller`);
    parts.push(`${formatBytes(processed.originalSize)} → ${formatBytes(processed.compressedSize)}`);
  } else {
    parts.push(`No compression: ${formatBytes(processed.originalSize)}`);
  }

  if (processed.dimensions) {
    parts.push(`${processed.dimensions.width}x${processed.dimensions.height}`);
  }

  if (processed.duration) {
    const minutes = Math.floor(processed.duration / 60);
    const seconds = Math.floor(processed.duration % 60);
    parts.push(`${minutes}:${seconds.toString().padStart(2, '0')}`);
  }

  return parts.join(' | ');
}
