/**
 * SyncInviteHandler - Handles incoming sync invites
 * 
 * This component listens for sync_invite events and automatically
 * accepts sync requests from new devices.
 * 
 * It also handles incoming sync_request events to send
 * history to the requesting device after accepting.
 * 
 * Also handles sync_history events on new device to apply received history.
 */

import { useEffect, useRef,useState } from 'react';

import { toast } from '@/components/ui/toast';
import { useAuth } from '@/contexts/AuthContext';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import type { WSSyncAcceptPayload, WSSyncHistoryPayload,WSSyncInvitePayload, WSSyncRequestPayload } from '@/types/websocket';

export function SyncInviteHandler() {
  const { onSyncInvite, onSyncAccept, onSyncCancel, onSyncRequest, onSyncHistory, send, p2pSyncManager } = useWebSocketContext();
  const { user: _user } = useAuth();
  const [acceptedDeviceId, setAcceptedDeviceId] = useState<string | null>(null);
  const [donorDeviceId, setDonorDeviceId] = useState<string | null>(null); // For new device: track which donor accepted
  
  // Track if we've already processed an invite to avoid duplicates
  const processedInvitesRef = useRef<Set<string>>(new Set());
  
  // Handle incoming sync_invite - auto-accept
  useEffect(() => {
    const unsubInvite = onSyncInvite(async (data: WSSyncInvitePayload) => {
      // Don't process invite if we're the inviting device
      const localDeviceId = localStorage.getItem('device-id');
      if (data.invitingDeviceId === localDeviceId) {
        return;
      }
      
      // Avoid processing the same invite twice
      const inviteKey = `${data.invitingDeviceId}-${data.timestamp}`;
      if (processedInvitesRef.current.has(inviteKey)) {
        return;
      }
      processedInvitesRef.current.add(inviteKey);
      
      // Auto-accept the sync request
      try {
        const localDeviceId = localStorage.getItem('device-id');
        
        // Show toast notification
        const deviceName = data.invitingDeviceName || 'New Device';
        toast.info('Синхронизация', `Принятие синхронизации с ${deviceName}...`);
        
        // Remember which device we accepted (to handle sync_request later)
        setAcceptedDeviceId(data.invitingDeviceId);
        
        // Send sync_accept to the server
        await send('sync_accept', {
          acceptingDeviceId: localDeviceId,
          targetDeviceId: data.invitingDeviceId,
          timestamp: Date.now(),
        });
        
        toast.success('Синхронизация', `Начинаем передачу данных на ${deviceName}`);
      } catch (error) {
        console.error('[SyncInviteHandler] Failed to auto-accept sync:', error);
        toast.error('Ошибка синхронизации', 'Не удалось принять приглашение');
        processedInvitesRef.current.delete(inviteKey);
      }
    });

    return () => {
      unsubInvite();
    };
  }, [onSyncInvite, send]);

  // Handle sync_cancel - another device accepted, we should stop waiting
  useEffect(() => {
    const unsubCancel = onSyncCancel(() => {
      // No UI to close anymore
    });

    return () => {
      unsubCancel();
    };
  }, [onSyncCancel]);

  // Handle sync_accept from another device (shouldn't happen to us, but just in case)
  useEffect(() => {
    const unsubAccept = onSyncAccept((data: WSSyncAcceptPayload) => {
      // For new device: track which donor accepted our invite
      const localDeviceId = localStorage.getItem('device-id');
      if (data.targetDeviceId === localDeviceId) {
        setDonorDeviceId(data.acceptingDeviceId);
        toast.info('Синхронизация', 'Устройство приняло приглашение. Начинаем получение данных...');
      }
    });

    return () => {
      unsubAccept();
    };
  }, [onSyncAccept]);

  // Handle incoming sync_request - send history to the requesting device
  useEffect(() => {
    if (!p2pSyncManager) return;
    
    const unsubRequest = onSyncRequest(async (data: WSSyncRequestPayload) => {
      // Only process if we accepted this device's invite
      if (acceptedDeviceId === data.requestingDeviceId) {
        try {
          // Check if we have the Signal device ID for encryption
          if (!data.requestingSignalDeviceId) {
            console.error('[SyncInviteHandler] No Signal device ID provided - cannot encrypt history');
            return;
          }
          
          // Show toast
          toast.info('Синхронизация', 'Подготовка данных для передачи...');
          
          // Prepare and send history using Signal device ID for encryption
          const historyPayload = await p2pSyncManager.prepareHistory(
            data.requestingDeviceId,
            data.requestingSignalDeviceId
          );
          
          // Send via WebSocket
          await p2pSyncManager.sendHistory(historyPayload);
          
          toast.success('Синхронизация', 'Данные успешно переданы');
        } catch (err) {
          console.error('[SyncInviteHandler] Failed to prepare/send history:', err);
          toast.error('Ошибка синхронизации', 'Не удалось отправить данные');
        }
      }
    });

    return () => {
      unsubRequest();
    };
  }, [onSyncRequest, p2pSyncManager, acceptedDeviceId]);

  // Handle incoming sync_history - apply received history (new device)
  useEffect(() => {
    if (!p2pSyncManager) return;
    
    const unsubHistory = onSyncHistory(async (data: WSSyncHistoryPayload) => {
      // Only process if this is from the donor device we're expecting
      if (donorDeviceId && data.senderDeviceId === donorDeviceId) {
        try {
          // Show toast
          toast.info('Синхронизация', 'Получение данных...');
          
          // Apply the received history
          await p2pSyncManager.applyHistory(data);
          
          // Notify ChatContext to refresh
          window.dispatchEvent(new CustomEvent('zerochat:sync-complete'));
          
          toast.success('Синхронизация', 'Данные успешно синхронизированы');
          
          // Clear donor device ID after successful sync
          setDonorDeviceId(null);
        } catch (err) {
          console.error('[SyncInviteHandler] Failed to apply history:', err);
          toast.error('Ошибка синхронизации', 'Не удалось применить данные');
        }
      } else if (!donorDeviceId) {
        // No donor expected, but we received history - process anyway
        try {
          toast.info('Синхронизация', 'Получение данных...');
          await p2pSyncManager.applyHistory(data);
          
          // Notify ChatContext to refresh
          window.dispatchEvent(new CustomEvent('zerochat:sync-complete'));
          
          toast.success('Синхронизация', 'Данные успешно синхронизированы');
        } catch (err) {
          console.error('[SyncInviteHandler] Failed to apply history:', err);
          toast.error('Ошибка синхронизации', 'Не удалось применить данные');
        }
      }
    });

    return () => {
      unsubHistory();
    };
  }, [onSyncHistory, p2pSyncManager, donorDeviceId]);

  // This component doesn't render anything - it's just for handling events
  return null;
}

export default SyncInviteHandler;
