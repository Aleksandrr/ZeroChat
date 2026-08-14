import { z } from 'zod';

// Auth schemas
export const loginSchema = z.object({
  username: z.string().min(1, 'Имя пользователя обязательно'),
  password: z.string().min(1, 'Пароль обязателен'),
});

const passwordSchema = z.string()
  .min(8, 'Пароль должен быть не менее 8 символов')
  .max(128, 'Пароль должен быть менее 128 символов')
  .regex(/[A-Z]/, 'Пароль должен содержать хотя бы одну заглавную букву (A-Z)')
  .regex(/[a-z]/, 'Пароль должен содержать хотя бы одну строчную букву (a-z)')
  .regex(/[0-9]/, 'Пароль должен содержать хотя бы одну цифру (0-9)')
  .regex(/[!@#$%^&*(),.?":{}|<>]/, 'Пароль должен содержать хотя бы один спецсимвол (!@#$%^&*)');

export const registerSchema = z.object({
  username: z.string()
    .min(3, 'Имя пользователя должно быть от 3 до 30 символов')
    .max(30, 'Имя пользователя должно быть от 3 до 30 символов')
    .regex(/^[a-zA-Z0-9_]+$/, 'Имя пользователя может содержать только буквы, цифры и подчёркивания'),
  displayName: z.string().max(50, 'Отображаемое имя должно быть не более 50 символов').optional(),
  password: passwordSchema,
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'Пароли не совпадают',
  path: ['confirmPassword'],
});

// Message schema
export const messageSchema = z.object({
  content: z.string()
    .min(1, 'Message cannot be empty')
    .max(10000, 'Message is too long'),
});

// User search schema
export const userSearchSchema = z.object({
  query: z.string()
    .min(2, 'Введите минимум 2 символа для поиска')
    .max(50, 'Слишком длинный запрос'),
});

// Chat schema
export const createChatSchema = z.object({
  recipientId: z.string().uuid('Invalid user ID'),
});

// Settings schema
export const settingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  notifications: z.boolean(),
  sound: z.boolean(),
  showOnlineStatus: z.boolean(),
  readReceipts: z.boolean(),
  autoSaveMedia: z.boolean(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type MessageInput = z.infer<typeof messageSchema>;
export type CreateChatInput = z.infer<typeof createChatSchema>;
export type SettingsInput = z.infer<typeof settingsSchema>;
export type UserSearchInput = z.infer<typeof userSearchSchema>;

// Password requirements for UI display
export const passwordRequirements = [
  { test: (p: string) => p.length >= 8, message: 'Минимум 8 символов' },
  { test: (p: string) => p.length <= 128, message: 'Максимум 128 символов' },
  { test: (p: string) => /[A-Z]/.test(p), message: 'Заглавная буква (A-Z)' },
  { test: (p: string) => /[a-z]/.test(p), message: 'Строчная буква (a-z)' },
  { test: (p: string) => /[0-9]/.test(p), message: 'Цифра (0-9)' },
  { test: (p: string) => /[!@#$%^&*(),.?":{}|<>]/.test(p), message: 'Спецсимвол (!@#$%)' },
];
