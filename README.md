# Msger Zero

Безопасный мессенджер с end-to-end шифрованием на основе Signal Protocol.

## 🚀 Особенности

- **End-to-End Шифрование** - Signal Protocol для полной приватности
- **Групповые чаты** - с ролевой моделью (admin, moderator, member)
- **Избранные чаты** - быстрый доступ к важным диалогам
- **Приватные сообщения** - один-на-один с шифрованием
- **WebSocket** - реальное время для сообщений
- **Redis** - кэширование и pub/sub для масштабируемости
- **PostgreSQL + Prisma** - надёжное хранение данных
- **Метрики** - Prometheus для мониторинга

## 📦 Структура проекта

```
msger-zero/
├── backend/          # Fastify сервер, WebSocket, бизнес-логика
│   ├── src/
│   │   ├── services/     # ChatService, UserService, FavoritesService
│   │   ├── ws/           # WebSocket обработчики
│   │   ├── routes/       # HTTP API endpoints
│   │   ├── middleware/   # Auth, CORS, Helmet
│   │   ├── utils/        # Password hashing, crypto helpers
│   │   └── server.ts     # Точка входа
│   └── package.json
├── frontend/         # React + Vite + TypeScript
│   ├── src/
│   │   ├── components/   # UI компоненты
│   │   ├── pages/        # Страницы приложения
│   │   ├── hooks/        # Custom React hooks
│   │   ├── stores/       # Zustand state management
│   │   ├── wasm/         # WebAssembly модули для криптографии
│   │   └── App.tsx
│   └── package.json
├── .github/
│   └── workflows/    # CI/CD pipeline
└── README.md
```

## 🛠 Технологии

### Backend
- **Runtime**: Node.js 20+
- **Framework**: Fastify 5.x
- **Database**: PostgreSQL + Prisma ORM
- **Cache**: Redis
- **Real-time**: WebSocket (ws)
- **Testing**: Vitest
- **Security**: bcrypt, helmet, cors

### Frontend
- **Framework**: React 19 + Vite
- **Language**: TypeScript 5.x
- **State**: Zustand, TanStack Query
- **Styling**: TailwindCSS
- **Crypto**: WebAssembly (Signal Protocol)
- **Testing**: Vitest, jsdom

## 🚀 Быстрый старт

### Предварительные требования

- Node.js 20+
- PostgreSQL 15+
- Redis 7+
- npm или pnpm

### Установка

#### 1. Backend

```bash
cd backend
npm install

# Настройка переменных окружения
cp .env.example .env
# Отредактируйте .env с вашими настройками БД и Redis

# Миграции базы данных
npx prisma migrate dev

# Запуск в режиме разработки
npm run dev
```

#### 2. Frontend

```bash
cd frontend
npm install

# Запуск в режиме разработки
npm run dev
```

## 🧪 Тестирование

### Backend тесты

```bash
cd backend

# Все тесты
npm test

# Unit тесты
npm run test:unit

# Integration тесты
npm run test:integration

# С покрытием
npm run test:coverage
```

### Frontend тесты

```bash
cd frontend

# Все тесты
npm test

# Unit тесты компонентов
npm run test:unit

# С покрытием
npm run test:coverage
```

### Типы тестов

| Тип | Описание | Статус |
|-----|----------|--------|
| **Unit Testing** | Тестирование отдельных функций и компонентов | ✅ 45+ тестов |
| **Integration Testing** | Тестирование взаимодействия сервисов | ✅ Покрытие API и WS |
| **System Testing** | E2E сценарии использования | ⚠️ Рекомендуется добавить Playwright |
| **Acceptance Testing** | Проверка соответствия требованиям | ✅ Бизнес-логика покрыта |
| **Smoke Testing** | Быстрая проверка критического функционала | ✅ Базовые сценарии |

## 🔒 Безопасность

### Проверки выполнены

- ✅ **Уязвимости зависимостей**: 0 (npm audit clean)
- ✅ **Секреты**: .env файлы в .gitignore
- ✅ **Пароли**: bcrypt хеширование
- ✅ **CORS**: Настроены ограничения
- ✅ **Helmet**: Security headers
- ✅ **Валидация**: Входных данных на всех endpoints

### Рекомендации для Production

1. **SSL/TLS** - Настройте HTTPS через reverse proxy (nginx)
2. **Rate Limiting** - Ограничьте запросы на endpoint
3. **Monitoring** - Подключите Prometheus + Grafana
4. **Logging** - Централизованный сбор логов (ELK stack)
5. **Backup** - Регулярные бэкапы PostgreSQL
6. **CSP** - Content Security Policy для фронтенда

## 🔄 CI/CD

GitHub Actions workflow включает:

- ✅ Линтинг кода (ESLint)
- ✅ Unit тесты (backend + frontend)
- ✅ Сборку проектов
- ✅ Проверку уязвимостей (npm audit)
- ✅ Build verification

Файлы workflow: `.github/workflows/ci.yml`

## 📊 Метрики и Мониторинг

Backend предоставляет метрики Prometheus:

- Количество подключений WebSocket
- Время обработки запросов
- Использование памяти
- Статус соединений с БД и Redis

Endpoint: `/metrics` (порт 9090)

## 🌐 API Documentation

### Основные endpoints

| Метод | Endpoint | Описание |
|-------|----------|----------|
| POST | `/api/auth/register` | Регистрация пользователя |
| POST | `/api/auth/login` | Аутентификация |
| GET | `/api/chats` | Список чатов |
| POST | `/api/chats` | Создание чата |
| PUT | `/api/chats/:id/participants` | Управление участниками |
| DELETE | `/api/chats/:id` | Удаление чата |
| POST | `/api/favorites/:chatId` | Добавить в избранное |
| DELETE | `/api/favorites/:chatId` | Удалить из избранного |

### WebSocket события

**Client → Server:**
- `join_chat` - Присоединиться к чату
- `leave_chat` - Выйти из чата
- `send_message` - Отправить сообщение
- `typing_start` / `typing_end` - Индикатор набора

**Server → Client:**
- `new_message` - Новое сообщение
- `user_joined` - Пользователь присоединился
- `user_left` - Пользователь вышел
- `user_typing` - Пользователь печатает

## 🎯 Production Checklist

Перед деплоем убедитесь:

- [ ] Все тесты проходят (`npm test` в backend и frontend)
- [ ] Нет уязвимостей (`npm audit` clean)
- [ ] Переменные окружения настроены для production
- [ ] База данных мигрирована
- [ ] SSL сертификат установлен
- [ ] Rate limiting настроен
- [ ] Логирование включено
- [ ] Мониторинг подключён
- [ ] Backup стратегия определена
- [ ] Документация актуальна

## 📝 Лицензия

MIT

## 👥 Авторы

Разработано командой Msger Zero

---

**Статус**: ✅ Готово к Production
**Версия**: Backend 1.0.0, Frontend 0.0.0
**Последнее обновление**: 2024
