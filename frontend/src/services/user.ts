/**
 * User Service
 *
 * Manages user profile operations including updating display name.
 */

import { getAccessToken } from './auth/tokens';
import type { User } from '@/types';

// ==================== Configuration ====================

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// ==================== Types ====================

export interface UserUpdateData {
  username?: string;
  displayName?: string;
}

export interface UserServiceError {
  message: string;
  code: string;
}

export class UserApiError extends Error {
  code: string;
  statusCode?: number;

  constructor(message: string, code: string, statusCode?: number) {
    super(message);
    this.name = 'UserApiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ==================== Request Helper ====================

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const token = getAccessToken();

  const hasBody = options.body !== undefined && options.body !== null;
  const headers: Record<string, string> = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
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
    if (error instanceof UserApiError) throw error;
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new UserApiError(
        'Ошибка сети. Проверьте соединение.',
        'NETWORK_ERROR'
      );
    }
    throw error;
  }
}

async function handleError(response: Response): Promise<UserApiError> {
  const statusCode = response.status;
  let message = 'Произошла ошибка';
  let code = 'UNKNOWN_ERROR';

  try {
    const errorData = await response.json();
    message = errorData.detail || errorData.title || errorData.message || message;
    code = errorData.type?.split('/').pop() || code;
  } catch {
    const errorMessages: Record<number, { message: string; code: string }> = {
      400: { message: 'Неверный запрос.', code: 'BAD_REQUEST' },
      401: { message: 'Не авторизован.', code: 'UNAUTHORIZED' },
      403: { message: 'Доступ запрещён.', code: 'FORBIDDEN' },
      404: { message: 'Не найдено.', code: 'NOT_FOUND' },
      429: { message: 'Слишком много запросов. Попробуйте позже.', code: 'RATE_LIMITED' },
      500: { message: 'Внутренняя ошибка сервера.', code: 'INTERNAL_ERROR' },
    };
    const errorInfo = errorMessages[statusCode];
    if (errorInfo) {
      message = errorInfo.message;
      code = errorInfo.code;
    }
  }

  return new UserApiError(message, code, statusCode);
}

// ==================== API Functions ====================

/**
 * Update current user's profile
 */
export async function updateProfile(updates: UserUpdateData): Promise<User> {
  const response = await request<{ success: boolean; data: User }>('/users/me', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });

  if (!response.success || !response.data) {
    throw new UserApiError('Failed to update profile', 'UPDATE_FAILED');
  }

  return response.data;
}

// ==================== Export ====================

export const userService = {
  updateProfile,
};

export default userService;
