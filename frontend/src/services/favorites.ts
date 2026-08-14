/**
 * Favorites (Saved Messages) API Service
 * 
 * Provides API functions for managing favorites chat:
 * - Get favorites chat info
 * - Get user devices for multi-device sync
 */

import type { Chat, Device } from '@/types';

import { getAccessToken } from './auth/tokens';

// ==================== Configuration ====================

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// ==================== Types ====================

export interface FavoritesChatResponse {
  chat: Chat;
}

export interface UserDevicesResponse {
  devices: {
    id: string;
    userId: string;
    deviceId: string;
    signalDeviceId?: number;
    name: string;
    type: string;
    isActive: boolean;
    isCurrentDevice?: boolean;
    lastSeen?: string;
    createdAt: string;
  }[];
  currentDeviceId: string;
}

export interface FavoritesError {
  message: string;
  code: string;
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
    if (error instanceof FavoritesApiError) throw error;
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new FavoritesApiError(
        'Ошибка сети. Проверьте соединение.',
        'NETWORK_ERROR'
      );
    }
    throw error;
  }
}

async function handleError(response: Response): Promise<FavoritesApiError> {
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

  return new FavoritesApiError(message, code, statusCode);
}

export class FavoritesApiError extends Error {
  code: string;
  statusCode?: number;

  constructor(message: string, code: string, statusCode?: number) {
    super(message);
    this.name = 'FavoritesApiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ==================== API Functions ====================

/**
 * Get favorites chat for current user
 * Returns the FAVORITES type chat created during registration
 */
export async function getFavoritesChat(): Promise<Chat | null> {
  try {
    // Get all chats and find favorites
    const response = await request<{ chats: Chat[] }>('/chats', {
      method: 'GET',
    });

    const favoritesChat = response.chats?.find(chat => chat.type === 'favorites');
    return favoritesChat || null;
  } catch (error) {
    console.error('[Favorites] Failed to get favorites chat:', error);
    return null;
  }
}

/**
 * Get all user devices for multi-device encryption
 * Used when sending favorites messages to encrypt for other devices
 */
export async function getUserDevices(): Promise<UserDevicesResponse> {
  return request<UserDevicesResponse>('/devices', {
    method: 'GET',
  });
}

/**
 * Get other devices (excluding current device)
 * Used for encrypting favorites messages
 */
export async function getOtherDevices(): Promise<UserDevicesResponse['devices']> {
  const response = await getUserDevices();
  return response.devices.filter(device => !device.isCurrentDevice);
}

// ==================== Export ====================

export const favoritesService = {
  getFavoritesChat,
  getUserDevices,
  getOtherDevices,
};

export default favoritesService;
