/**
 * Media processing library for ZeroChat-TS
 * Provides image compression, audio conversion, and video processing
 */

// Compression utilities
export {
  type AudioCompressionOptions,
  compressImageFallback,
  // Main functions
  compressImageForPhoto,
  compressVideoForSending,
  convertAudioToMp3,
  DEFAULT_AUDIO_COMPRESSION_OPTIONS,
  // Default options
  DEFAULT_PHOTO_COMPRESSION_OPTIONS,
  DEFAULT_VIDEO_COMPRESSION_OPTIONS,
  detectMediaType,
  formatBytes,
  getImageDimensions,
  getVideoMetadata,
  // Types
  type ImageCompressionOptions,
  type VideoCompressionOptions,
} from './compression';

// File processor
export {
  canProcessFile,
  FileProcessingError,
  getProcessingSummary,
  type ProcessedFile,
  // Main functions
  processFileForSending,
  processFilesForSending,
  type ProcessingOptions,
  // Types
  type SendMode,
} from './file-processor';

// Stage 5.3.4: Crypto utilities for deduplication
export {
  generateAttachmentId,
  hashFileContent,
  hashMultipleParts,
  quickHash,
} from './crypto';
