# ZeraChat - Secure Messaging Platform


## 📋 Overview

ZeraChat is a secure, real-time messaging platform built with modern technologies. Features include end-to-end encryption, device verification, and role-based access control.

## 🚀 Tech Stack

### Backend
- **Runtime**: Node.js 20+
- **Framework**: Fastify 5.x
- **Database**: PostgreSQL 16+ with Prisma ORM 7.x
- **Cache**: Redis 7+
- **Security**: Argon2id password hashing, JWT authentication
- **Testing**: Vitest

### Frontend
- **Framework**: React 19.x
- **Build Tool**: Vite 7.x
- **Language**: TypeScript 5.x
- **State Management**: Zustand, TanStack Query
- **UI**: Radix UI, Tailwind CSS 4.x
- **Routing**: TanStack Router

## 📦 Installation

### Prerequisites
- Node.js >= 20.0.0
- npm >= 10.0.0
- PostgreSQL 16+
- Redis 7+

### Quick Start

```bash
# Clone repository
git clone https://github.com/your-org/zerachat.git
cd zerachat

# Install dependencies
npm run install:all

# Setup environment variables
cp backend/.env.example backend/.env
# Edit backend/.env with your configuration

# Generate Prisma client
npm run prisma:generate

# Run database migrations
npm run prisma:migrate

# Start development servers
npm run dev
```

## 🔧 Configuration

### Environment Variables

#### Backend (.env)
```env
DATABASE_URL=postgresql://user:password@localhost:5432/zerachat
REDIS_URL=redis://localhost:6379
JWT_SECRET=your-secret-key
ARGON_SECRET=your-argon-secret
PORT=3000
NODE_ENV=development
```

#### Frontend
Configure in `frontend/.env` or via Vite environment variables.

## 🧪 Testing

```bash
# Run all tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# Test with coverage
npm run test:coverage
```

### Test Coverage
- **Unit Tests**: Auth service, password utilities, chat service
- **Integration Tests**: API endpoints, database operations
- **Smoke Tests**: Health checks, basic API functionality

## 🔒 Security

### Features
- ✅ Argon2id password hashing (OWASP 2023 compliant)
- ✅ JWT token rotation
- ✅ Device verification flow
- ✅ Rate limiting (auth: 5/min, messaging: 60/min, uploads: 10/min)
- ✅ Secrets scanning in CI/CD
- ✅ npm audit integration
- ✅ No vulnerabilities detected

### Security Scanning
```bash
# Run security audit
npm run audit

# Check for secrets in codebase
bash scripts/check-secrets.sh
```

## 🏗️ Build & Deploy

```bash
# Build both projects
npm run build

# Build backend only
npm run build:backend

# Build frontend only
npm run build:frontend

# Start production servers
npm run start:backend
npm run start:frontend
```

## 📊 CI/CD Pipeline

The project uses GitHub Actions for continuous integration and deployment:

1. **Security Scan** - npm audit, secrets scanning
2. **Unit Tests** - PostgreSQL-backed unit testing
3. **Integration Tests** - Full stack testing with Redis
4. **Build & Lint** - TypeScript compilation, ESLint
5. **Smoke Tests** - Health checks and API validation
6. **Deploy** - Production deployment (main branch only)

## 📁 Project Structure

```
zerachat/
├── backend/
│   ├── src/
│   │   ├── services/      # Business logic
│   │   ├── routes/        # API endpoints
│   │   ├── middleware/    # Rate limiting, auth
│   │   └── utils/         # Helpers
│   ├── prisma/
│   │   └── schema.prisma  # Database schema
│   ├── tests/
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/    # React components
│   │   ├── hooks/         # Custom hooks
│   │   ├── stores/        # Zustand stores
│   │   └── utils/
│   └── package.json
├── scripts/
│   └── check-secrets.sh   # Security scanning
├── .github/
│   └── workflows/
│       └── ci-cd.yml      # CI/CD pipeline
└── package.json           # Monorepo root
```

## 🎯 API Endpoints

### Authentication
- `POST /api/v1/auth/register` - Register new user
- `POST /api/v1/auth/login` - Login with device verification
- `POST /api/v1/auth/refresh` - Refresh JWT tokens
- `POST /api/v1/auth/logout` - Logout and revoke tokens

### Chats
- `GET /api/v1/chats` - List user chats
- `POST /api/v1/chats` - Create new chat
- `GET /api/v1/chats/:id` - Get chat details
- `DELETE /api/v1/chats/:id` - Delete chat

### Messages
- `GET /api/v1/chats/:id/messages` - Get chat messages
- `POST /api/v1/chats/:id/messages` - Send message

## 🐛 Troubleshooting

### Common Issues

**Prisma Client not generated:**
```bash
npm run prisma:generate
```

**Database connection error:**
- Check DATABASE_URL in .env
- Ensure PostgreSQL is running
- Verify database exists

**Port already in use:**
```bash
# Change PORT in backend/.env
PORT=3001
```

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 📞 Support

For issues and questions:
- GitHub Issues: https://github.com/your-org/zerachat/issues
- Email: support@zerachat.com

---

**Version**: 1.0.0  
**Last Updated**: 2024
