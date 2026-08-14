/**
 * Sync API Module
 * 
 * Provides API functions for synchronization:
 * - POST /api/sync - Full sync (push + pull)
 * - POST /api/sync/push - Push only
 * - POST /api/sync/pull - Pull only
 * 
 * @module sync/api
 */

import { getAccessToken } from '../auth/tokens';
import type {
  SyncRequest,
  SyncResponse,
} from './types';
import { SyncError } from './types';

// ==================== Configuration ====================

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// ==================== Request Helper ====================

/**
 * Make authenticated API request
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const token = getAccessToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
    });

    if (!response.ok) {
      throw await handleError(response);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : ({} as T);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new SyncError(
        'Ошибка сети. Проверьте соединение.',
        'NETWORK_ERROR'
      );
    }
    throw error;
  }
}

/**
 * Handle HTTP error response
 */
async function handleError(response: Response): Promise<SyncError> {
  const statusCode = response.status;
  let message = 'Произошла ошибка';
  let code = 'UNKNOWN_ERROR';

  try {
    const errorData = await response.json();
    message = errorData.detail || errorData.title || message;
    code = errorData.type?.split('/').pop() || code;
  } catch {
    const errorMessages: Record<number, { message: string; code: string }> = {
      400: { message: 'Неверный запрос.', code: 'BAD_REQUEST' },
      401: { message: 'Не авторизован.', code: 'UNAUTHORIZED' },
      403: { message: 'Доступ запрещён.', code: 'FORBIDDEN' },
      404: { message: 'Ресурс не найден.', code: 'NOT_FOUND' },
      500: { message: 'Ошибка сервера.', code: 'INTERNAL_ERROR' },
    };

    const mapped = errorMessages[statusCode];
    if (mapped) {
      message = mapped.message;
      code = mapped.code;
    }
  }

  return new SyncError(message, code, statusCode);
}

// ==================== Sync API ====================

/**
 * Perform full sync (push + pull)
 * 
 * @param syncRequest - Sync request with vector clock and optional events to push
 * @returns Sync response with updated vector clock and events
 */
export async function sync(syncRequest: SyncRequest): Promise<SyncResponse> {
  return request<SyncResponse>('/sync', {
    method: 'POST',
    body: JSON.stringify(syncRequest),
  });
}

/**
 * Push events to server
 * 
 * @param events - Events to push
 * @returns Empty response
 */
export async function pushEvents(events: SyncRequest['events']): Promise<void> {
  await request<void>('/sync/push', {
    method: 'POST',
    body: JSON.stringify({ events }),
  });
}

/**
 * Pull events from server
 * 
 * @param vectorClock - Current vector clock
 * @returns Sync response with events and updated vector clock
 */
export async function pullEvents(vectorClock: SyncRequest['vectorClock']): Promise<SyncResponse> {
  return request<SyncResponse>('/sync/pull', {
    method: 'POST',
    body: JSON.stringify({ vectorClock }),
  });
}

// ==================== Exports ====================

export type {
  SyncEvent,
  SyncRequest,
  SyncResponse,
  VectorClock,
} from './types';
export { SyncError } from './types';
