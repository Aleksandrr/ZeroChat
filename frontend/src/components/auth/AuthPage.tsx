import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from '@tanstack/react-router';
import { Eye, EyeOff, Loader2, Lock, User } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';

import { DeviceVerification } from '@/components/devices';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { useAuth } from '@/contexts';
import {
  type LoginInput,
  loginSchema,
  passwordRequirements,
  type RegisterInput,
  registerSchema,
} from '@/lib/validation';
import { getDeviceId } from '@/services/auth';

export function AuthPage() {
  const navigate = useNavigate();
  const { login, register, setDeviceVerified, user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const [pendingDeviceId, setPendingDeviceId] = useState<string | null>(null);

  // Состояния для показа/скрытия пароля
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Login form
  const {
    register: registerLoginField,
    handleSubmit: handleLoginSubmit,
    formState: { errors: loginErrors, isSubmitting: isLoginSubmitting },
    reset: resetLoginForm,
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      username: '',
      password: '',
    },
  });

  // Register form
  const {
    register: registerRegisterField,
    handleSubmit: handleRegisterSubmit,
    formState: { errors: registerErrors, isSubmitting: isRegisterSubmitting },
    watch: watchRegister,
    reset: resetRegisterForm,
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      username: '',
      displayName: '',
      password: '',
      confirmPassword: '',
    },
  });

  const passwordValue = watchRegister('password');

   // Обработчик входа
   const onLoginSubmit = async (data: LoginInput) => {
     setError(null);
     try {
       const needsVerification = await login({ username: data.username, password: data.password });

       if (needsVerification) {
         // Получаем deviceId из localStorage
         const deviceId = getDeviceId();
         if (deviceId) {
           setPendingDeviceId(deviceId);
         }
         return; // Stay on verification page
       }

       await navigate({ to: '/' });
     } catch (err) {
       const errorMessage = err instanceof Error ? err.message : 'Ошибка входа';
       setError(errorMessage);
     }
   };

   // Обработчик регистрации
   const onRegisterSubmit = async (data: RegisterInput) => {
     setError(null);
     try {
       await register({
         username: data.username,
         password: data.password,
         displayName: data.displayName || undefined,
       });
       await navigate({ to: '/' });
     } catch (err) {
       const errorMessage = err instanceof Error ? err.message : 'Ошибка регистрации';
       setError(errorMessage);
     }
   };

  // Сброс форм при переключении табов
  const handleTabChange = (value: string) => {
    setActiveTab(value as 'login' | 'register');
    setError(null);
    if (value === 'login') {
      resetRegisterForm();
    } else {
      resetLoginForm();
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background theme-transition p-4 sm:p-6">
      <Card className="w-full max-w-md shadow-xl border-0 bg-card/80 backdrop-blur-sm">
        <CardHeader className="text-center pb-2">
          <div className="flex justify-center mb-3">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <span className="text-xl font-bold text-primary">Z</span>
            </div>
          </div>
          <h1 className="text-xl font-semibold">ZeroChat</h1>
          <p className="text-sm text-muted-foreground">
            Безопасный мессенджер
          </p>
        </CardHeader>

        <CardContent className="pt-2">
          {error && (
            <div className="mb-4 p-3 rounded bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}
          
           {/* Экран верификации устройства */}
           {pendingDeviceId && user ? (
             <DeviceVerification
               userId={user.id}
               deviceId={pendingDeviceId}
               onVerified={async () => {
                 await setDeviceVerified();
                 setPendingDeviceId(null);
                 await navigate({ to: '/' });
               }}
               onCancel={() => {
                 setPendingDeviceId(null);
                 setError('Верификация отклонена. Для продолжения необходимо подтвердить устройство.');
               }}
             />
          ) : (
          <Tabs
            value={activeTab}
            onValueChange={handleTabChange}
            className="w-full"
          >
            <TabsList className="grid w-full grid-cols-2 mb-4">
              <TabsTrigger value="login">Вход</TabsTrigger>
              <TabsTrigger value="register">Регистрация</TabsTrigger>
            </TabsList>

            {/* Форма входа */}
            <TabsContent value="login" className="mt-2">
              <form onSubmit={handleLoginSubmit(onLoginSubmit)} className="flex flex-col space-y-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="login-username" className="w-full">Имя пользователя</Label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="login-username"
                      type="text"
                      placeholder="Введите username"
                      className={`pl-10 ${loginErrors.username ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      {...registerLoginField('username')}
                      disabled={isLoginSubmitting}
                    />
                  </div>
                  {loginErrors.username && (
                    <span className="text-xs text-destructive">{loginErrors.username.message}</span>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="login-password" className="w-full">Пароль</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Введите пароль"
                      className={`pl-10 pr-10 ${loginErrors.password ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      {...registerLoginField('password')}
                      disabled={isLoginSubmitting}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {loginErrors.password && (
                    <span className="text-xs text-destructive">{loginErrors.password.message}</span>
                  )}
                </div>

                <Button type="submit" className="w-full" disabled={isLoginSubmitting}>
                  {isLoginSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Вход...
                    </>
                  ) : (
                    'Войти'
                  )}
                </Button>
              </form>
            </TabsContent>

            {/* Форма регистрации */}
            <TabsContent value="register" className="mt-2">
              <form onSubmit={handleRegisterSubmit(onRegisterSubmit)} className="flex flex-col space-y-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reg-username" className="w-full">Имя пользователя</Label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="reg-username"
                      type="text"
                      placeholder="Придумайте username"
                      className={`pl-10 ${registerErrors.username ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      {...registerRegisterField('username')}
                      disabled={isRegisterSubmitting}
                    />
                  </div>
                  {registerErrors.username && (
                    <span className="text-xs text-destructive">{registerErrors.username.message}</span>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="displayName" className="w-full">Отображаемое имя (опционально)</Label>
                  <div className="relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="displayName"
                      type="text"
                      placeholder="Как вас видят другие"
                      className={`pl-10 ${registerErrors.displayName ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      {...registerRegisterField('displayName')}
                      disabled={isRegisterSubmitting}
                    />
                  </div>
                  {registerErrors.displayName && (
                    <span className="text-xs text-destructive">{registerErrors.displayName.message}</span>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="reg-password" className="w-full">Пароль</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="reg-password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Минимум 8 символов: A-Z, a-z, 0-9, !@#$%"
                      className={`pl-10 pr-10 ${registerErrors.password ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      {...registerRegisterField('password')}
                      disabled={isRegisterSubmitting}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {registerErrors.password ? (
                    <span className="text-xs text-destructive">{registerErrors.password.message}</span>
                  ) : (
                    <div className="space-y-1 mt-2">
                      <p className="text-xs text-muted-foreground font-medium">Требования к паролю:</p>
                      <div className="grid grid-cols-2 gap-1 text-xs">
                        {passwordRequirements.map((req, index) => (
                          <div
                            key={index}
                            className={`flex items-center gap-1 ${
                              passwordValue && passwordValue.length > 0
                                ? req.test(passwordValue)
                                  ? 'text-green-500'
                                  : 'text-destructive'
                                : 'text-muted-foreground'
                            }`}
                          >
                            <span className="w-3 h-3 rounded-full border flex items-center justify-center text-[8px]">
                              {passwordValue && passwordValue.length > 0 && req.test(passwordValue) ? '✓' : '○'}
                            </span>
                            {req.message}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirm-password" className="w-full">Подтвердите пароль</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="confirm-password"
                      type={showConfirmPassword ? 'text' : 'password'}
                      placeholder="Повторите пароль"
                      className={`pl-10 pr-10 ${registerErrors.confirmPassword ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      {...registerRegisterField('confirmPassword')}
                      disabled={isRegisterSubmitting}
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {registerErrors.confirmPassword && (
                    <span className="text-xs text-destructive">{registerErrors.confirmPassword.message}</span>
                  )}
                </div>

                <Button type="submit" className="w-full" disabled={isRegisterSubmitting}>
                  {isRegisterSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Регистрация...
                    </>
                  ) : (
                    'Создать аккаунт'
                  )}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
