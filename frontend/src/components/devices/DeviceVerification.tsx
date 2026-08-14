/**
 * DeviceVerification Component
 * 
 * UI for verifying new devices with 6-digit code
 * 
 * @module components/devices/DeviceVerification
 */

import { AlertTriangle, CheckCircle2, RefreshCw, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useDevices } from '@/hooks/use-devices';

// ==================== Types ====================

export interface DeviceVerificationProps {
  userId: string;
  deviceId: string;
  onVerified: () => void;
  onCancel?: () => void;
}

// ==================== Component ====================

export function DeviceVerification({
  userId: _userId,
  deviceId,
  onVerified,
  onCancel,
}: DeviceVerificationProps) {
  const [code, setCode] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isResending, setIsResending] = React.useState(false);
  const [resendCountdown, setResendCountdown] = React.useState(60);  // 60 секунд cooldown
  const [hasRequestedCode, setHasRequestedCode] = React.useState(false);
  const { verifyDevice, generateVerificationCode } = useDevices({ autoLoad: false });
  
  // Ref to track if initial code request has been attempted
  const initialRequestRef = React.useRef(false);

  // Countdown timer for resend
  React.useEffect(() => {
    if (resendCountdown > 0) {
      const timer = setTimeout(() => {
        setResendCountdown(prev => prev - 1);
      }, 1000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [resendCountdown]);

  const handleVerify = async () => {
    if (isLoading || code.length !== 6) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      const result = await verifyDevice(deviceId, code);
      
      if (result.verified) {
        onVerified();
      } else {
        // Показываем оставшиеся попытки
        if (result.attemptsRemaining !== undefined) {
          setError(`${result.message || 'Неверный код'}. Осталось попыток: ${result.attemptsRemaining}`);
        } else {
          setError(result.message || 'Неверный код');
        }
        setCode('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка верификации');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendCode = async (isAuto = false) => {
    if (!isAuto && (isResending || resendCountdown > 0)) {
      return;
    }
    
    setIsResending(true);
    setError(null);
    
    try {
      const result = await generateVerificationCode(deviceId);
      
      // Если вернулся retryAfter - используем его для таймера
      if (result.retryAfter) {
        setResendCountdown(result.retryAfter);
      } else {
        setResendCountdown(60);  // Стандартный cooldown 60 секунд
      }
    } catch (err: any) {
      console.error('[DeviceVerification] generateVerificationCode error:', err);
      // Try to extract retryAfter from structured error response first,
      // then fall back to regex parsing of the error message.
      const retryAfter = err?.retryAfter ?? err?.data?.retryAfter;
      if (retryAfter && typeof retryAfter === 'number') {
        setResendCountdown(retryAfter);
      } else if (err instanceof Error && err.message.includes('через')) {
        const match = err.message.match(/через (\d+)/);
        if (match && match[1]) {
          setResendCountdown(parseInt(match[1], 10));
        }
      }
      setError(err instanceof Error ? err.message : 'Не удалось отправить код');
      initialRequestRef.current = false;
    } finally {
      setIsResending(false);
    }
  };
  
  // Auto-request verification code on mount (first time only)
  React.useEffect(() => {
    if (!initialRequestRef.current && deviceId) {
      initialRequestRef.current = true;
      setHasRequestedCode(true);
      void handleResendCode(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      void handleVerify();
    }
  };

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Only allow numeric characters and limit to 6 digits
    const numericValue = e.target.value.replace(/\D/g, '').slice(0, 6);
    setCode(numericValue);
  };

  return (
    <Card className="w-full max-w-md mx-auto">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Верификация нового устройства</CardTitle>
        <CardDescription>
          Введите 6-значный код из системного чата
        </CardDescription>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {/* Code Input */}
        <div className="space-y-2">
          <Input
            type="text"
            value={code}
            onChange={handleCodeChange}
            onKeyDown={handleKeyDown}
            placeholder="123456"
            maxLength={6}
            disabled={isLoading}
            className="text-center text-2xl tracking-widest h-12"
          />
          
          {code.length > 0 && code.length < 6 && (
            <p className="text-sm text-yellow-600 dark:text-yellow-400 flex items-center gap-1">
              <AlertTriangle className="w-4 h-4" />
              Код должен состоять из 6 цифр
            </p>
          )}
        </div>
        
        {/* Error Message */}
        {error && (
          <div className="p-3 rounded-md border border-red-500/30 bg-red-500/10">
            <p className="text-sm font-medium text-red-800 dark:text-red-200 flex items-center gap-1">
              <AlertTriangle className="w-4 h-4" />
              {error}
            </p>
          </div>
        )}
        
        {/* Action Buttons */}
        <div className="space-y-2">
          <Button
            onClick={handleVerify}
            disabled={isLoading || code.length !== 6}
            className="w-full"
          >
            {isLoading ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                Проверка...
              </>
            ) : (
              'Подтвердить'
            )}
          </Button>
           
          <Button
            variant="outline"
            onClick={() => handleResendCode(false)}
            disabled={isResending || resendCountdown > 0}
            className="w-full"
          >
            {isResending ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                Отправка...
              </>
            ) : resendCountdown > 0 ? (
              `Отправить код через ${resendCountdown}с`
            ) : (
              'Отправить код снова'
            )}
          </Button>
          
          {onCancel && (
            <Button
              variant="ghost"
              onClick={onCancel}
              className="w-full"
            >
              <X className="w-4 h-4 mr-2" />
              Отмена
            </Button>
          )}
        </div>
        
        {/* Instructions */}
        <div className="p-3 rounded-md border border-blue-500/30 bg-blue-500/10">
          <p className="text-xs text-blue-800 dark:text-blue-200">
            <CheckCircle2 className="w-4 h-4 inline mr-1" />
            Код действует 3 минуты. Код отправлен в системный чат.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default DeviceVerification;
