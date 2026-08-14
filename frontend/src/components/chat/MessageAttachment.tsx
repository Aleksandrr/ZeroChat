/**
 * MessageAttachment - Component for displaying attachments in messages
 * Handles images, videos, audio, and files with decryption support
 */

import {
  AlertCircle,
  Download,
  File,
  FileText,
  Image,
  Loader2,
  Music,
  Pause,
  Play,
  Video,
} from 'lucide-react';
import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/media';
import { cn } from '@/lib/utils';
import { fileLogger } from '@/lib/utils/file-logger';
import type { Attachment } from '@/types';
import { useImageGallery } from '@/contexts/ImageGalleryContext';
import { useIsMobile } from '@/hooks/use-mobile';

interface MessageAttachmentProps {
  attachment: Attachment;
  decryptedData?: Uint8Array | null;
  isDecrypting?: boolean;
  decryptError?: string;
  className?: string;
  onClick?: () => void;
}

// Helper to convert Uint8Array to Blob safely
function uint8ArrayToBlob(data: Uint8Array, mimeType: string): Blob {
  const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return new Blob([arrayBuffer as ArrayBuffer], { type: mimeType });
}

// Get icon based on attachment type
function getAttachmentIcon(type: string) {
  switch (type) {
    case 'image':
      return Image;
    case 'video':
      return Video;
    case 'audio':
      return Music;
    case 'file':
      return FileText;
    default:
      return File;
  }
}

// Image attachment thumbnail
function ImageAttachment({
  attachment,
  decryptedData,
  isDecrypting,
  decryptError,
  onClick,
}: MessageAttachmentProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const { openGallery } = useImageGallery();
  const isMobile = useIsMobile();

  // Create src from decryptedData or attachment.data
  useEffect(() => {
    let url: string | null = null;

    if (decryptedData) {
      const blob = uint8ArrayToBlob(decryptedData, attachment.mimeType);
      url = URL.createObjectURL(blob);
      fileLogger.logDisplayRendered(attachment.id, 'image', attachment.fileName, decryptedData.byteLength);
    } else if (attachment.data) {
      url = `data:${attachment.mimeType};base64,${attachment.data}`;
      fileLogger.logDisplayRendered(attachment.id, 'image', attachment.fileName, attachment.data.length);
    }

    if (url) {
      setSrc(url);
    } else {
      setLoadError(true);
    }

    return () => {
      if (url && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    };
  }, [decryptedData, attachment.data, attachment.mimeType, attachment.id, attachment.fileName]);

  const handleDownload = useCallback(() => {
    let url = src;
    if (!url && attachment.data) {
      url = `data:${attachment.mimeType};base64,${attachment.data}`;
    }
    if (url) {
      fileLogger.logDownloadStart(attachment.id, attachment.fileName, attachment.size);
      const a = document.createElement('a');
      a.href = url;
      a.download = attachment.fileName;
      a.click();
      fileLogger.logDownloadComplete(attachment.id, attachment.fileName, 0);
    }
  }, [src, attachment.data, attachment.mimeType, attachment.fileName, attachment.size, attachment.id]);

  const handleClick = () => {
    onClick?.();
  };

  if (isDecrypting) {
    return (
      <div className={cn(
        "relative w-full rounded-lg bg-muted flex items-center justify-center",
        isMobile ? "h-[150px]" : "max-w-[300px] h-[200px]"
      )}>
        <Loader2 className={cn(isMobile ? "h-6 w-6" : "h-8 w-8")} animate-spin text-muted-foreground />
      </div>
    );
  }

  if (decryptError || loadError) {
    return (
      <div className={cn(
        "relative w-full rounded-lg bg-muted flex flex-col items-center justify-center gap-2 p-4",
        isMobile ? "h-[150px]" : "max-w-[300px] h-[200px]"
      )}>
        <AlertCircle className={cn(isMobile ? "h-6 w-6" : "h-8 w-8")} text-destructive />
        <p className={cn("text-muted-foreground text-center", isMobile ? "text-xs" : "text-xs")}>{decryptError || 'Не удалось загрузить изображение'}</p>
      </div>
    );
  }

  if (!src) {
    return (
      <div className={cn(
        "relative w-full rounded-lg bg-muted flex items-center justify-center",
        isMobile ? "h-[150px]" : "max-w-[300px] h-[200px]"
      )}>
        <Loader2 className={cn(isMobile ? "h-6 w-6" : "h-8 w-8")} animate-spin text-muted-foreground />
      </div>
    );
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className={cn(
          "relative w-full rounded-lg overflow-hidden cursor-pointer group focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
          isMobile ? "max-w-[85vw]" : "max-w-[300px]"
        )}
        onClick={() => onClick?.()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick?.();
          }
        }}
      >
        <img
          src={src}
          alt={attachment.fileName}
          loading="lazy"
          className="w-full h-auto object-cover bg-muted animate-pulse"
          style={isMobile ? { maxHeight: '180px' } : { maxHeight: '300px' }}
          onLoad={(e) => {
            e.currentTarget.classList.remove('animate-pulse', 'bg-muted');
          }}
          onError={() => {
            setLoadError(true);
            fileLogger.logDisplayError(attachment.id, 'image', attachment.fileName, 'Image load failed');
          }}
        />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
        <div className={cn(
          "absolute bottom-2 right-2 transition-opacity",
          isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        )}>
          <Button
            variant="secondary"
            size="icon"
            className={cn(
              "bg-white/90 hover:bg-white",
              isMobile ? "h-10 w-10" : "h-8 w-8"
            )}
            onClick={(e) => {
              e.stopPropagation();
              handleDownload();
            }}
          >
            <Download className={isMobile ? "h-5 w-5" : "h-4 w-4"} />
          </Button>
        </div>
      </div>
    </>
  );
}

// Video attachment
function VideoAttachment({
  attachment,
  decryptedData,
  isDecrypting,
  decryptError,
}: MessageAttachmentProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const isMobile = useIsMobile();

  const fileName = attachment.fileName;

  useEffect(() => {
    let url: string | null = null;

    if (decryptedData) {
      const blob = uint8ArrayToBlob(decryptedData, attachment.mimeType);
      url = URL.createObjectURL(blob);
      fileLogger.logDisplayRendered(attachment.id, 'video', fileName, decryptedData.byteLength);
    } else if (attachment.data) {
      url = `data:${attachment.mimeType};base64,${attachment.data}`;
      fileLogger.logDisplayRendered(attachment.id, 'video', fileName, attachment.data.length);
    }

    if (url) {
      setSrc(url);
    } else {
      setLoadError(true);
    }

    return () => {
      if (url && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    };
  }, [decryptedData, attachment.data, attachment.mimeType, attachment.id, fileName]);

  const handleDownload = useCallback(() => {
    let url = src;
    if (!url && attachment.data) {
      url = `data:${attachment.mimeType};base64,${attachment.data}`;
    }
    if (url) {
      fileLogger.logDownloadStart(attachment.id, fileName, attachment.size);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      fileLogger.logDownloadComplete(attachment.id, fileName, 0);
    }
  }, [src, attachment.data, attachment.mimeType, fileName, attachment.size, attachment.id]);

  if (isDecrypting) {
    return (
      <div className={cn(
        "relative w-full rounded-lg bg-muted flex items-center justify-center",
        isMobile ? "h-[150px]" : "max-w-[300px] h-[200px]"
      )}>
        <Loader2 className={cn(isMobile ? "h-6 w-6" : "h-8 w-8")} animate-spin text-muted-foreground />
      </div>
    );
  }

  if (decryptError || loadError) {
    return <FileAttachment {...{ attachment, decryptedData, isDecrypting, decryptError }} />;
  }

  if (!src) {
    return (
      <div className={cn(
        "relative w-full rounded-lg bg-muted flex items-center justify-center",
        isMobile ? "h-[150px]" : "max-w-[300px] h-[200px]"
      )}>
        <Loader2 className={cn(isMobile ? "h-6 w-6" : "h-8 w-8")} animate-spin text-muted-foreground />
      </div>
    );
  }

  return (
    <div className={cn(
      "relative w-full rounded-lg overflow-hidden bg-black",
      isMobile ? "max-w-[85vw]" : "max-w-[300px]"
    )}>
      <video
        src={src}
        className="w-full h-auto"
        style={isMobile ? { maxHeight: '180px' } : { maxHeight: '300px' }}
        controls
        onError={() => {
          setLoadError(true);
          fileLogger.logDisplayError(attachment.id, 'video', fileName, 'Video load failed');
        }}
      >
        <track kind="captions" label="Captions not available" />
      </video>
      <div className={cn(
        "absolute top-2 right-2",
        isMobile ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      )}>
        <Button
          variant="secondary"
          size="icon"
          className={cn(
            "bg-white/90 hover:bg-white",
            isMobile ? "h-10 w-10" : "h-8 w-8"
          )}
          onClick={handleDownload}
        >
          <Download className={isMobile ? "h-5 w-5" : "h-4 w-4"} />
        </Button>
      </div>
    </div>
  );
}

// Video message attachment (compact, autoplay, loop — like Telegram)
function VideoMessageAttachment({
  attachment,
  decryptedData,
  isDecrypting,
  decryptError,
}: MessageAttachmentProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    let url: string | null = null;
    if (decryptedData) {
      const blob = uint8ArrayToBlob(decryptedData, attachment.mimeType);
      url = URL.createObjectURL(blob);
    } else if (attachment.data) {
      url = `data:${attachment.mimeType};base64,${attachment.data}`;
    }
    if (url) setSrc(url);
    else setLoadError(true);
    return () => {
      if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
    };
  }, [decryptedData, attachment.data, attachment.mimeType, attachment.id]);

  if (isDecrypting) {
    return (
      <div className={cn("relative rounded-lg bg-muted flex items-center justify-center", isMobile ? "w-[200px] h-[150px]" : "w-[240px] h-[180px]")}>
        <Loader2 className={cn(isMobile ? "h-5 w-5" : "h-6 w-6", "animate-spin text-muted-foreground")} />
      </div>
    );
  }

  if (decryptError || loadError || !src) {
    return <FileAttachment {...{ attachment, decryptedData, isDecrypting, decryptError }} />;
  }

  return (
    <div className={cn(
      "relative rounded-lg overflow-hidden bg-black cursor-pointer",
      isMobile ? "w-[200px] h-[150px]" : "w-[240px] h-[180px]"
    )}>
      <video
        src={src}
        className="w-full h-full object-cover"
        autoPlay
        loop
        muted
        playsInline
        onError={() => setLoadError(true)}
      />
    </div>
  );
}

// Audio attachment
function AudioAttachment({
  attachment,
  decryptedData,
  isDecrypting,
  decryptError,
}: MessageAttachmentProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const isMobile = useIsMobile();

  const fileName = attachment.fileName;

  // Round to 1 decimal place to avoid floating point precision issues
  const roundTo1Decimal = (num: number) => Math.round(num * 10) / 10;

  useEffect(() => {
    let url: string | null = null;

    if (decryptedData) {
      const blob = uint8ArrayToBlob(decryptedData, attachment.mimeType);
      url = URL.createObjectURL(blob);
      fileLogger.logDisplayRendered(attachment.id, 'audio', fileName, decryptedData.byteLength);
    } else if (attachment.data) {
      url = `data:${attachment.mimeType};base64,${attachment.data}`;
      fileLogger.logDisplayRendered(attachment.id, 'audio', fileName, attachment.data.length);
    }

    if (url) {
      setSrc(url);
    }

    return () => {
      if (url && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    };
  }, [decryptedData, attachment.data, attachment.mimeType, attachment.id, fileName]);

  const togglePlay = async () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        try {
          await audioRef.current.play();
        } catch (error) {
          console.error('Failed to play audio:', error);
        }
      }
    }
  };

  const formatTime = (time: number) => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  if (isDecrypting) {
    return (
      <div className={cn(
        "flex items-center rounded-lg bg-muted w-full",
        isMobile ? "gap-2 p-2 h-[50px]" : "gap-3 p-3 max-w-[300px] h-[70px]"
      )}>
        <Loader2 className={cn(isMobile ? "h-4 w-4" : "h-5 w-5", "animate-spin", "text-muted-foreground")} />
        <span className={cn(isMobile ? "text-xs" : "text-sm", "text-muted-foreground")}>Загрузка аудио...</span>
      </div>
    );
  }

  if (decryptError) {
    return (
      <div className={cn(
        "flex items-center rounded-lg bg-destructive/10 w-full",
        isMobile ? "gap-2 p-2 h-[50px]" : "gap-3 p-3 max-w-[300px] h-[70px]"
      )}>
        <AlertCircle className={cn(isMobile ? "h-4 w-4" : "h-5 w-5", "text-destructive")} />
        <span className={cn(isMobile ? "text-xs" : "text-sm", "text-destructive")}>{decryptError}</span>
      </div>
    );
  }

  if (!src) {
    return (
      <div className={cn(
        "flex items-center rounded-lg bg-muted w-full",
        isMobile ? "gap-2 p-2 h-[50px]" : "gap-3 p-3 max-w-[300px] h-[70px]"
      )}>
        <Loader2 className={cn(isMobile ? "h-4 w-4" : "h-5 w-5", "animate-spin", "text-muted-foreground")} />
        <span className={cn(isMobile ? "text-xs" : "text-sm", "text-muted-foreground")}>Загрузка аудио...</span>
      </div>
    );
  }

  return (
    <div className={cn(
      "flex rounded-lg bg-muted w-full",
      isMobile ? "gap-1.5 p-2 max-w-[90vw] h-auto" : "gap-3 p-3 max-w-[300px] h-auto"
    )}>
      <Button
        variant="secondary"
        size="icon"
        className={cn(
          "rounded-full shrink-0",
          isMobile ? "h-8 w-8" : "h-10 w-10"
        )}
        onClick={togglePlay}
      >
        {isPlaying ? <Pause className={cn(isMobile ? "h-4 w-4" : "h-4 w-4")} /> : <Play className={cn(isMobile ? "h-4 w-4" : "h-4 w-4")} />}
      </Button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <p className={cn(isMobile ? "text-xs" : "text-sm", "font-medium", "truncate", "text-foreground", "flex-1", "mr-2", "break-words")}>{fileName}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const rates = [1, 1.5, 2];
                const next = rates[(rates.indexOf(playbackRate) + 1) % rates.length];
                setPlaybackRate(next);
                if (audioRef.current) audioRef.current.playbackRate = next;
              }}
              className={cn("text-muted-foreground hover:text-foreground transition-colors", isMobile ? "text-[10px]" : "text-xs")}
              title="Скорость воспроизведения"
            >
              {playbackRate}x
            </button>
            <span className={cn("text-muted-foreground whitespace-nowrap", isMobile ? "text-[10px]" : "text-xs")}>
              {formatTime(currentTime)} / {formatTime(duration || 0)}
            </span>
          </div>
        </div>
        <input
          type="range"
          min={0}
          max={roundTo1Decimal(duration) || 100}
          step="0.1"
          value={roundTo1Decimal(currentTime)}
          onChange={(e) => {
            const time = parseFloat(e.target.value);
            const roundedTime = roundTo1Decimal(time);
            setCurrentTime(roundedTime);
            if (audioRef.current) {
              audioRef.current.currentTime = roundedTime;
            }
          }}
          className={cn("w-full accent-primary", isMobile ? "h-1 mt-1" : "h-1 mt-2")}
        />
      </div>

      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onTimeUpdate={() => {
          if (audioRef.current) {
            const now = audioRef.current.currentTime;
            const dur = audioRef.current.duration;
            setCurrentTime(roundTo1Decimal(now));
            // Ensure slider reaches end when audio ends
            if (audioRef.current.ended) {
              setCurrentTime(roundTo1Decimal(dur));
            }
          }
        }}
        onLoadedMetadata={() => {
          if (audioRef.current) {
            const dur = audioRef.current.duration;
            if (!isNaN(dur) && dur > 0) {
              setDuration(roundTo1Decimal(dur));
            }
          }
        }}
        onLoadedData={() => {
          // Fallback for some browsers that don't fire onLoadedMetadata reliably
          if (audioRef.current && duration === 0) {
            const dur = audioRef.current.duration;
            if (!isNaN(dur) && dur > 0) {
              setDuration(roundTo1Decimal(dur));
            }
          }
        }}
        onCanPlay={() => {
          // Another fallback: when audio can be played, duration should be available
          if (audioRef.current) {
            const dur = audioRef.current.duration;
            if (!isNaN(dur) && dur > 0 && duration !== dur) {
              setDuration(roundTo1Decimal(dur));
            }
          }
        }}
        onPlay={() => {
          // Ensure duration is set when playback starts
          if (audioRef.current && duration === 0) {
            const dur = audioRef.current.duration;
            if (!isNaN(dur) && dur > 0) {
              setDuration(roundTo1Decimal(dur));
            }
          }
          setIsPlaying(true);
        }}
        onPlaying={() => {
          // Additional check when actually playing (after buffering)
          if (audioRef.current && duration === 0) {
            const dur = audioRef.current.duration;
            if (!isNaN(dur) && dur > 0) {
              setDuration(roundTo1Decimal(dur));
            }
          }
        }}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          // Ensure we show full duration when ended
          if (audioRef.current) {
            setCurrentTime(roundTo1Decimal(audioRef.current.duration));
          }
        }}
        onError={(e) => {
          console.error('Audio error:', e);
          fileLogger.logDisplayError(attachment.id, 'audio', fileName, 'Audio load failed');
        }}
        className="hidden"
      >
        <track kind="captions" label="Captions not available" />
      </audio>
    </div>
  );
}

// File attachment
function FileAttachment({
  attachment,
  decryptedData: _decryptedData,
  isDecrypting,
  decryptError,
}: MessageAttachmentProps) {
  const FileIcon = getAttachmentIcon(attachment.type);
  const fileName = attachment.fileName;
  const isMobile = useIsMobile();

  const handleDownload = useCallback(() => {
    const url = attachment.data ? `data:${attachment.mimeType};base64,${attachment.data}` : null;
    if (url) {
      fileLogger.logDownloadStart(attachment.id, fileName, attachment.size);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      fileLogger.logDownloadComplete(attachment.id, fileName, 0);
    }
  }, [attachment.data, attachment.mimeType, fileName, attachment.size, attachment.id]);

  if (isDecrypting) {
    return (
      <div className={cn(
        "flex items-center rounded-lg bg-muted w-full",
        isMobile ? "gap-2 p-2 h-[50px]" : "gap-3 p-3 max-w-[300px] h-[70px]"
      )}>
        <div className={cn(
          "rounded-lg bg-primary/10 flex items-center justify-center shrink-0",
          isMobile ? "w-8 h-8" : "w-10 h-10"
        )}>
          <Loader2 className={cn(isMobile ? "h-4 w-4" : "h-5 w-5", "animate-spin", "text-primary")} />
        </div>
        <div className="flex-1 min-w-0">
          <p className={cn(isMobile ? "text-[10px]" : "text-sm", "font-medium", "truncate", "text-foreground")}>{fileName}</p>
          <p className={cn("text-muted-foreground", isMobile ? "text-[10px]" : "text-xs")}>Расшифровка...</p>
        </div>
      </div>
    );
  }

  if (decryptError) {
    return (
      <div className={cn(
        "flex items-center rounded-lg bg-destructive/10 w-full",
        isMobile ? "gap-2 p-2 h-[50px]" : "gap-3 p-3 max-w-[300px] h-[70px]"
      )}>
        <div className={cn(
          "rounded-lg bg-destructive/20 flex items-center justify-center shrink-0",
          isMobile ? "w-8 h-8" : "w-10 h-10"
        )}>
          <AlertCircle className={cn(isMobile ? "h-4 w-4" : "h-5 w-5", "text-destructive")} />
        </div>
        <div className="flex-1 min-w-0">
          <p className={cn(isMobile ? "text-xs" : "text-sm", "font-medium", "truncate")}>{fileName}</p>
          <p className="text-xs text-destructive">{decryptError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={cn(
      "flex items-center rounded-lg bg-muted w-full",
      isMobile ? "gap-2 p-2 max-w-[90vw]" : "gap-3 p-3 max-w-[300px]"
    )}>
      <div className={cn(
        "rounded-lg bg-primary/10 flex items-center justify-center shrink-0",
        isMobile ? "w-8 h-8" : "w-10 h-10"
      )}>
        <FileIcon className={cn(isMobile ? "h-4 w-4" : "h-5 w-5", "text-primary")} />
      </div>
        <div className="flex-1 min-w-0">
          <p className={cn(isMobile ? "text-[10px]" : "text-sm", "font-medium", "truncate", "text-foreground")}>{fileName}</p>
          <p className={cn("text-muted-foreground", isMobile ? "text-[10px]" : "text-xs")}>{formatBytes(attachment.size)}</p>
        </div>
      <Button
        variant="ghost"
        size="icon"
        className={cn("shrink-0", isMobile ? "h-8 w-8" : "h-8 w-8")}
        onClick={handleDownload}
        disabled={!attachment.data}
      >
        <Download className={isMobile ? "h-4 w-4" : "h-4 w-4"} />
      </Button>
    </div>
  );
}

// Voice attachment - compact design for voice messages
  function VoiceAttachment({
    attachment,
    decryptedData,
    isDecrypting,
    decryptError,
  }: MessageAttachmentProps) {
    const [src, setSrc] = useState<string | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
    const audioRef = React.useRef<HTMLAudioElement>(null);
    const isMobile = useIsMobile();

    const fileName = attachment.fileName;

    // Round to 1 decimal place to avoid floating point precision issues
    const roundTo1Decimal = (num: number) => Math.round(num * 10) / 10;

    useEffect(() => {
      let url: string | null = null;

      if (decryptedData) {
        const blob = uint8ArrayToBlob(decryptedData, attachment.mimeType);
        url = URL.createObjectURL(blob);
        fileLogger.logDisplayRendered(attachment.id, 'voice', fileName, decryptedData.byteLength);
      } else if (attachment.data) {
        url = `data:${attachment.mimeType};base64,${attachment.data}`;
        fileLogger.logDisplayRendered(attachment.id, 'voice', fileName, attachment.data.length);
      }

      if (url) {
        setSrc(url);
      }

      return () => {
        if (url && url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      };
    }, [decryptedData, attachment.data, attachment.mimeType, attachment.id, fileName]);

    const togglePlay = async () => {
      if (audioRef.current) {
        if (isPlaying) {
          audioRef.current.pause();
        } else {
          try {
            await audioRef.current.play();
          } catch (error) {
            console.error('Failed to play voice message:', error);
          }
        }
      }
    };

    const formatTime = (time: number) => {
      const minutes = Math.floor(time / 60);
      const seconds = Math.floor(time % 60);
      return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

  if (isDecrypting) {
    return (
      <div className="flex items-center gap-2 p-2 rounded-lg bg-muted w-full max-w-full sm:max-w-[250px]">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Загрузка...</span>
      </div>
    );
  }

  if (decryptError) {
    return (
      <div className="flex items-center gap-2 p-2 rounded-lg bg-destructive/10 w-full max-w-full sm:max-w-[250px]">
        <AlertCircle className="h-4 w-4 text-destructive" />
        <span className="text-xs text-destructive">{decryptError}</span>
      </div>
    );
  }

  if (!src) {
    return (
      <div className="flex items-center gap-2 p-2 rounded-lg bg-muted w-full max-w-full sm:max-w-[250px]">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Загрузка...</span>
      </div>
    );
  }

  return (
    <div className={cn(
      "flex items-center rounded-lg bg-muted w-full",
      isMobile ? "gap-2 p-2 max-w-[90vw]" : "gap-2 p-2 max-w-[250px]"
    )}>
      <Button
        variant="secondary"
        size="icon"
        className={cn(
          "rounded-full shrink-0",
          isMobile ? "h-8 w-8" : "h-8 w-8"
        )}
        onClick={togglePlay}
      >
        {isPlaying ? <Pause className={cn(isMobile ? "h-4 w-4" : "h-3 w-3")} /> : <Play className={cn(isMobile ? "h-4 w-4" : "h-3 w-3")} />}
      </Button>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {formatTime(currentTime)} / {formatTime(duration || 0)}
          </span>
          <button
            type="button"
            onClick={() => {
              const rates = [1, 1.5, 2];
              const next = rates[(rates.indexOf(playbackRate) + 1) % rates.length];
              setPlaybackRate(next);
              if (audioRef.current) audioRef.current.playbackRate = next;
            }}
            className="text-muted-foreground hover:text-foreground transition-colors text-[10px] sm:text-xs"
            title="Скорость воспроизведения"
          >
            {playbackRate}x
          </button>
        </div>
        <input
          type="range"
          min={0}
          max={roundTo1Decimal(duration) || 100}
          step="0.1"
          value={roundTo1Decimal(currentTime)}
          onChange={(e) => {
            const time = parseFloat(e.target.value);
            const roundedTime = roundTo1Decimal(time);
            setCurrentTime(roundedTime);
            if (audioRef.current) {
              audioRef.current.currentTime = roundedTime;
            }
          }}
          className="w-full h-1 accent-primary"
        />
      </div>

      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onTimeUpdate={() => {
          if (audioRef.current) {
            const now = audioRef.current.currentTime;
            const dur = audioRef.current.duration;
            setCurrentTime(roundTo1Decimal(now));
            // Ensure slider reaches end when audio ends
            if (audioRef.current.ended) {
              setCurrentTime(roundTo1Decimal(dur));
            }
          }
        }}
        onLoadedMetadata={() => {
          if (audioRef.current) {
            const dur = audioRef.current.duration;
            if (!isNaN(dur) && dur > 0) {
              setDuration(roundTo1Decimal(dur));
            }
          }
        }}
        onLoadedData={() => {
          // Fallback for some browsers that don't fire onLoadedMetadata reliably
          if (audioRef.current && duration === 0) {
            const dur = audioRef.current.duration;
            if (!isNaN(dur) && dur > 0) {
              setDuration(roundTo1Decimal(dur));
            }
          }
        }}
        onCanPlay={() => {
          // Another fallback: when audio can be played, duration should be available
          if (audioRef.current) {
            const dur = audioRef.current.duration;
            if (!isNaN(dur) && dur > 0 && duration !== dur) {
              setDuration(roundTo1Decimal(dur));
            }
          }
        }}
        onPlay={() => {
          // Ensure duration is set when playback starts
          if (audioRef.current && duration === 0) {
            const dur = audioRef.current.duration;
            if (!isNaN(dur) && dur > 0) {
              setDuration(roundTo1Decimal(dur));
            }
          }
          setIsPlaying(true);
        }}
        onPlaying={() => {
          // Additional check when actually playing (after buffering)
          if (audioRef.current && duration === 0) {
            const dur = audioRef.current.duration;
            if (!isNaN(dur) && dur > 0) {
              setDuration(roundTo1Decimal(dur));
            }
          }
        }}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          // Ensure we show full duration when ended
          if (audioRef.current) {
            setCurrentTime(roundTo1Decimal(audioRef.current.duration));
          }
        }}
        onError={(e) => {
          console.error('Voice audio error:', e);
          fileLogger.logDisplayError(attachment.id, 'voice', fileName, 'Voice message load failed');
        }}
        className="hidden"
      >
        <track kind="captions" label="Captions not available" />
      </audio>
    </div>
  );
}

// Main component
export function MessageAttachment(props: MessageAttachmentProps) {
  const { attachment } = props;

  switch (attachment.type) {
    case 'image':
      return <ImageAttachment {...props} />;
    case 'video':
      // Video messages (recorded in-app) vs video files (uploaded)
      // Heuristic: if fileName starts with "video-" and no separate caption,
      // treat as a compact video message (autoplay, loop, no controls bar).
      // Otherwise, full video player with download.
      if (attachment.fileName?.startsWith('video-')) {
        return <VideoMessageAttachment {...props} />;
      }
      return <VideoAttachment {...props} />;
    case 'audio':
      return <AudioAttachment {...props} />;
    case 'voice':
      return <VoiceAttachment {...props} />;
    case 'file':
    default:
      return <FileAttachment {...props} />;
  }
}

// List of attachments
interface MessageAttachmentsProps {
  attachments: Attachment[];
  /** Map of contentHash to decrypted data (Stage 5.3.4 deduplication) */
  decryptedData?: Map<string, Uint8Array>;
  /** Set of attachment IDs currently being decrypted */
  decryptingAttachments?: Set<string>;
  /** Map of attachment ID to error message */
  decryptErrors?: Map<string, string>;
  className?: string;
  /**
   * Callback when an image is clicked - opens the global gallery
   */
  onImageClick?: (attachment: Attachment) => void;
  /**
   * When true, uses contentHash for lookup instead of attachment ID.
   * This enables deduplication - same file content is reused across messages.
   */
  useContentHash?: boolean;
}

export function MessageAttachments({
  attachments,
  decryptedData,
  decryptingAttachments,
  decryptErrors,
  className,
  onImageClick,
  useContentHash = true,
}: MessageAttachmentsProps) {
  if (!attachments || attachments.length === 0) return null;

  // Filter only image attachments for gallery
  const imageAttachments = attachments.filter(a => a.type === 'image');

  return (
    <div className={cn('space-y-2', className)}>
      {attachments.map((attachment) => {
        const lookupKey = useContentHash && attachment.contentHash
          ? attachment.contentHash
          : attachment.id;

        return (
          <MessageAttachment
            key={attachment.id}
            attachment={attachment}
            decryptedData={decryptedData?.get(lookupKey)}
            isDecrypting={decryptingAttachments?.has(attachment.id)}
            decryptError={decryptErrors?.get(attachment.id)}
            onClick={attachment.type === 'image' && onImageClick
              ? () => onImageClick(attachment)
              : undefined
            }
          />
        );
      })}
    </div>
  );
}

export default MessageAttachment;
