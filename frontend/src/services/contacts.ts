/**
 * Contacts Service
 *
 * Manages the user's address book (contacts).
 * Provides CRUD operations with server synchronization for adding new contacts.
 */

import {
  addContact as dbAddContact,
  deleteContact,
  getAllContacts,
  getContact,
  getFavoriteContacts,
  searchContacts,
  toggleContactFavorite,
  updateContact,
} from '@/lib/messages';
import type { ContactRecord } from '@/lib/messages/db';
import type { UserProfile } from '@/types';

import { getAccessToken } from './auth/tokens';

// ==================== Configuration ====================

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

// ==================== Types ====================

export interface ContactsError {
  message: string;
  code: string;
}

export class ContactsApiError extends Error {
  code: string;
  statusCode?: number;

  constructor(message: string, code: string, statusCode?: number) {
    super(message);
    this.name = 'ContactsApiError';
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
    if (error instanceof ContactsApiError) throw error;
    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new ContactsApiError(
        'Ошибка сети. Проверьте соединение.',
        'NETWORK_ERROR'
      );
    }
    throw error;
  }
}

async function handleError(response: Response): Promise<ContactsApiError> {
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

  return new ContactsApiError(message, code, statusCode);
}

// ==================== API Functions ====================

/**
 * Get user profile from server by ID
 * Used when adding a new contact to fetch user data
 */
export async function getUserProfile(userId: string): Promise<UserProfile> {
  const response = await request<{ success: boolean; data: UserProfile }>(`/users/${encodeURIComponent(userId)}`, {
    method: 'GET',
  });
  if (!response.success || !response.data) {
    throw new Error('User not found');
  }
  return response.data;
}

/**
 * Add a new contact to address book
 * 1. Fetch user data from server
 * 2. Store in IndexedDB
 */
export async function addContact(userId: string): Promise<ContactRecord> {
  try {
    // Check if contact already exists locally
    const existing = await getContact(userId);
    if (existing) {
      throw new ContactsApiError('Контакт уже существует', 'CONTACT_EXISTS');
    }

    // Fetch user data from server
    const userProfile = await getUserProfile(userId);

    // Create contact record
    const now = Date.now();
    const contact: ContactRecord = {
      id: userId,
      username: userProfile.username,
      displayName: userProfile.displayName || userProfile.username,
      avatar: userProfile.avatar,
      addedAt: now,
      updatedAt: now,
      isFavorite: false,
    };

    // Store in IndexedDB
    await dbAddContact(
      userId,
      contact.username,
      contact.displayName,
      contact.avatar,
      undefined, // notes
      false // isFavorite
    );

    return contact;
  } catch (error) {
    console.error('[Contacts] Failed to add contact:', error);
    throw error;
  }
}

/**
 * Update contact details (displayName, notes, isFavorite)
 */
export async function updateContactDetails(
  userId: string,
  updates: Partial<Pick<ContactRecord, 'displayName' | 'notes' | 'isFavorite'>>
): Promise<void> {
  await updateContact(userId, updates);
}

/**
 * Remove contact from address book
 */
export async function removeContact(userId: string): Promise<void> {
  await deleteContact(userId);
}

/**
 * Search contacts by username or displayName (case-insensitive)
 * This uses the local IndexedDB search, not server search
 */
export async function searchLocalContacts(query: string): Promise<ContactRecord[]> {
  return searchContacts(query);
}

/**
 * Get all favorite contacts
 */
export async function getFavorites(): Promise<ContactRecord[]> {
  return getFavoriteContacts();
}

/**
 * Toggle contact favorite status
 */
export async function toggleFavorite(userId: string): Promise<void> {
  await toggleContactFavorite(userId);
}

// ==================== Export ====================

export const contactsService = {
  addContact,
  getUserProfile,
  updateContactDetails,
  removeContact,
  searchLocalContacts,
  getFavorites,
  toggleFavorite,
  // Expose raw DB functions for advanced use cases
  getAllContacts,
  getContact,
  updateContact,
  deleteContact,
  searchContacts,
  getFavoriteContacts,
  toggleContactFavorite,
};

export default contactsService;
