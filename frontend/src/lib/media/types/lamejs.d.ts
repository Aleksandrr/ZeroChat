/**
 * Type declarations for lamejs
 * Since @types/lamejs doesn't exist in npm registry
 */

declare module 'lamejs' {
  /**
   * MP3 Encoder class
   */
  export class Mp3Encoder {
    /**
     * @param channels - Number of channels (1 or 2)
     * @param sampleRate - Sample rate in Hz (e.g., 44100)
     * @param kbps - Bitrate in kbps (e.g., 128)
     */
    constructor(channels: number, sampleRate: number, kbps: number);

    /**
     * Encode PCM buffer to MP3
     * @param left - Left channel samples (or mono)
     * @param right - Right channel samples (optional for mono)
     * @returns Encoded MP3 data
     */
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;

    /**
     * Flush remaining data
     * @returns Remaining MP3 data
     */
    flush(): Int8Array;
  }

  /**
   * MPEG mode constants
   */
  export const MPEGMode: {
    STEREO: number;
    JOINT_STEREO: number;
    DUAL_CHANNEL: number;
    MONO: number;
  };

  /**
   * WAV file header parser (if available in the library)
   */
  export namespace WavHeader {
    function readHeader(buffer: ArrayBuffer): {
      channels: number;
      sampleRate: number;
      dataOffset: number;
      dataLen: number;
    } | null;
  }
}
