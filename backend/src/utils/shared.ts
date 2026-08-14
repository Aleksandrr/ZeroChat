/**
 * Shared utility functions used across multiple modules.
 *
 * Extracted to eliminate code duplication.
 */

/**
 * Format bytes into human-readable string (B, KB, MB, GB, TB).
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Create a RFC 7807 Problem Details JSON object for error responses.
 */
export function createProblemDetails(
  title: string,
  status: number,
  detail: string | undefined,
  type?: string,
): { type: string; title: string; status: number; detail: string } {
  return {
    type: type || `https://httpstatuses.com/${status}`,
    title,
    status,
    detail: detail ?? 'Unknown error',
  };
}
