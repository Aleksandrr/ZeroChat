# Media Processing AGENTS.md

> **parent documentation:** [../../../AGENTS.md](../../../AGENTS.md) - Root project documentation
> **frontend documentation:** [../../../frontend/AGENTS.md](../../../frontend/AGENTS.md) - Frontend documentation

Media processing library for ZeroChat-TS Stage 5 (file sharing).

## Overview

Provides client-side media compression and conversion before sending:
- **Image compression**: Resize to 1024px, JPEG 80% quality, EXIF removal
- **Audio conversion**: Convert to MP3 128kbps using lamejs
- **Video compression**: Placeholder for FFmpeg.wasm (720p, 2Mbps)
- **Canvas fallback**: Fallback compression when library unavailable

## Files

| File | Description |
|------|-------------|
| [`index.ts`](index.ts) | Main exports |
| [`compression.ts`](compression.ts) | Compression utilities |
| [`file-processor.ts`](file-processor.ts) | File processing based on send mode |
| [`types/lamejs.d.ts`](types/lamejs.d.ts) | Type declarations for lamejs |

## Dependencies

```bash
npm install browser-image-compression lamejs
```

## Usage

### Basic File Processing

```typescript
import { processFileForSending } from '@/lib/media';

const processed = await processFileForSending(imageFile);
console.log(`Compressed: ${processed.wasCompressed}`);
```

### Specific Send Mode

```typescript
import { processFileForSending } from '@/lib/media';

// Force photo mode
const processed = await processFileForSending(file, 'photo');
```

### Batch Processing

```typescript
import { processFilesForSending } from '@/lib/media';

const files = [image1, image2, audio1];
const processed = await processFilesForSending(files, 'photo');
```

### Direct Compression Functions

```typescript
import { 
  compressImageForPhoto, 
  convertAudioToMp3,
  detectMediaType 
} from '@/lib/media';

const compressed = await compressImageForPhoto(file);
const mp3Blob = await convertAudioToMp3(audioFile);
const type = detectMediaType(file);
```

## Send Modes

| Mode | Processing |
|------|------------|
| `photo` | Resize to 1024px, JPEG 80%, remove EXIF |
| `video` | 720p 2Mbps (FFmpeg.wasm placeholder) |
| `audio` | Convert to MP3 128kbps |
| `file` | No compression |

## Options

```typescript
const processed = await processFileForSending(file, 'photo', {
  imageOptions: { 
    maxWidthOrHeight: 2048,  // Default: 1024
    initialQuality: 0.9      // Default: 0.8
  },
  maxFileSize: 100 * 1024 * 1024,  // 100MB (default: 50MB)
  skipCompressionIfSmall: false,    // Always compress
  smallFileThreshold: 50 * 1024     // 50KB threshold
});
```
