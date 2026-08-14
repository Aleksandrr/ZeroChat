/**
 * Date Utilities for ZeroChat-TS
 * 
 * Provides functions for formatting dates and times in the chat interface.
 * All functions are pure and unit-test friendly with no external dependencies.
 * 
 * @module date
 */

/**
 * Formats a date as a time string (HH:MM).
 * Uses Russian locale by default for consistency.
 * 
 * @param date - Date object or ISO string to format
 * @returns Formatted time string (e.g., "14:30")
 * 
 * @example
 * ```typescript
 * formatMessageTime('2024-01-15T14:30:00Z');
 * // Returns: "14:30"
 * ```
 */
export function formatMessageTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Formats a date as a short date string (day month).
 * Used for older messages in chat list.
 * 
 * @param date - Date object or ISO string to format
 * @returns Formatted date string (e.g., "15 Jan")
 * 
 * @example
 * ```typescript
 * formatMessageDate('2024-01-15T14:30:00Z');
 * // Returns: "15 Jan"
 * ```
 */
export function formatMessageDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Formats a date relative to the current time.
 * Returns different formats based on how recent the date is:
 * - Today: "HH:MM" (time only)
 * - Within 7 days: "Mon", "Tue", etc. (short weekday)
 * - Older: "15 Jan" (day and month)
 * 
 * @param date - Date object or ISO string to format
 * @returns Appropriately formatted date/time string
 * 
 * @example
 * ```typescript
 * // Today at 14:30
 * formatRelativeTime(new Date());
 * // Returns: "14:30"
 * 
 * // Yesterday
 * const yesterday = new Date(Date.now() - 86400000);
 * formatRelativeTime(yesterday);
 * // Returns: "Mon" (or current weekday)
 * 
 * // Two weeks ago
 * const old = new Date(Date.now() - 14 * 86400000);
 * formatRelativeTime(old);
 * // Returns: "1 Jan"
 * ```
 */
export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  
  // Check if today
  if (isSameDay(d, now)) {
    return d.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000); // 86400000 = ms in a day
  
  // Within 7 days - show weekday
  if (diffDays < 7) {
    return d.toLocaleDateString('ru-RU', { weekday: 'short' });
  }
  
  // Older than 7 days - show date
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Checks if two dates are on the same calendar day.
 * 
 * @param date1 - First date to compare
 * @param date2 - Second date to compare
 * @returns true if both dates are on the same day
 * 
 * @example
 * ```typescript
 * const today1 = new Date('2024-01-15T10:00:00');
 * const today2 = new Date('2024-01-15T18:00:00');
 * isSameDay(today1, today2); // true
 * 
 * const yesterday = new Date('2024-01-14T10:00:00');
 * isSameDay(today1, yesterday); // false
 * ```
 */
export function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

/**
 * Checks if a date is today.
 * 
 * @param date - Date to check
 * @returns true if the date is today
 * 
 * @example
 * ```typescript
 * isToday(new Date()); // true
 * isToday(new Date('2024-01-01')); // false (unless today)
 * ```
 */
export function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

/**
 * Checks if a date was yesterday.
 * 
 * @param date - Date to check
 * @returns true if the date was yesterday
 * 
 * @example
 * ```typescript
 * const yesterday = new Date(Date.now() - 86400000);
 * isYesterday(yesterday); // true
 * ```
 */
export function isYesterday(date: Date): boolean {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return isSameDay(date, yesterday);
}