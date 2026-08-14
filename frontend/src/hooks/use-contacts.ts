/**
 * useContacts Hook
 *
 * Provides UI state management for contacts functionality
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ContactRecord } from '@/lib/messages';
import { contactsService } from '@/services/contacts';

export interface UseContactsReturn {
  // State
  contacts: ContactRecord[];
  loading: boolean;
  searchQuery: string;
  
  // Actions
  setSearchQuery: (query: string) => void;
  loadContacts: () => Promise<void>;
  addContact: (userId: string) => Promise<ContactRecord>;
  updateContact: (userId: string, updates: Partial<Pick<ContactRecord, 'displayName' | 'notes' | 'isFavorite'>>) => Promise<void>;
  deleteContact: (userId: string) => Promise<void>;
  toggleFavorite: (userId: string) => Promise<void>;
  
  // Computed
  filteredContacts: ContactRecord[];
  favoriteContacts: ContactRecord[];
}

/**
 * Hook for managing contacts UI state
 */
export function useContacts(): UseContactsReturn {
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  /**
   * Load all contacts from IndexedDB
   */
  const loadContacts = useCallback(async () => {
    setLoading(true);
    try {
      const all = await contactsService.getAllContacts();
      setContacts(all);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Filter contacts by search query
   */
  const filteredContacts = useMemo(() => {
    if (!searchQuery.trim()) return contacts;
    const q = searchQuery.toLowerCase();
    return contacts.filter(c =>
      c.username.toLowerCase().includes(q) ||
      (c.displayName && c.displayName.toLowerCase().includes(q))
    );
  }, [contacts, searchQuery]);

  /**
   * Get favorite contacts
   */
  const favoriteContacts = useMemo(() => {
    return contacts.filter(c => c.isFavorite);
  }, [contacts]);

  /**
   * Add a new contact
   */
  const addContact = useCallback(async (userId: string): Promise<ContactRecord> => {
    const newContact = await contactsService.addContact(userId);
    setContacts(prev => [...prev, newContact]);
    return newContact;
  }, []);

  /**
   * Update a contact
   */
  const updateContact = useCallback(async (
    userId: string,
    updates: Partial<Pick<ContactRecord, 'displayName' | 'notes' | 'isFavorite'>>
  ): Promise<void> => {
    await contactsService.updateContactDetails(userId, updates);
    setContacts(prev => prev.map(c =>
      c.id === userId ? { ...c, ...updates, updatedAt: Date.now() } : c
    ));
  }, []);

  /**
   * Delete a contact
   */
  const deleteContact = useCallback(async (userId: string): Promise<void> => {
    await contactsService.removeContact(userId);
    setContacts(prev => prev.filter(c => c.id !== userId));
  }, []);

  /**
   * Toggle favorite status
   */
  const toggleFavorite = useCallback(async (userId: string): Promise<void> => {
    const contact = contacts.find(c => c.id === userId);
    if (contact) {
      await contactsService.toggleFavorite(userId);
      setContacts(prev => prev.map(c =>
        c.id === userId ? { ...c, isFavorite: !c.isFavorite } : c
      ));
    }
  }, [contacts]);

  /**
   * Load contacts on mount
   */
  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  return {
    contacts, // unfiltered
    loading,
    searchQuery,
    setSearchQuery,
    loadContacts,
    addContact,
    updateContact,
    deleteContact,
    toggleFavorite,
    filteredContacts,
    favoriteContacts,
  };
}

export default useContacts;
