export const config = {
  // Server configuration
  server: {
    port: process.env['PORT'] || 3001,
    host: process.env['HOST'] || '0.0.0.0',
    cors: {
      origin: process.env['FRONTEND_URL'] || 'http://localhost:3000',
      credentials: true,
    },
  },

  // JWT configuration
  jwt: {
    secret: process.env['JWT_SECRET'] || 'your-secret-key-change-in-production',
    expiresIn: process.env['JWT_EXPIRES_IN'] || '7d',
    refreshExpiresIn: process.env['JWT_REFRESH_EXPIRES_IN'] || '30d',
  },

  // Database configuration
  database: {
    url: process.env['DATABASE_URL'] || 'postgresql://localhost:5432/zerochat',
    ssl: process.env['NODE_ENV'] === 'production' ? { rejectUnauthorized: false } : false,
  },

  // Security configuration
  security: {
    bcryptRounds: 12,
    maxLoginAttempts: 5,
    lockoutDuration: 15 * 60 * 1000, // 15 minutes
    passwordMinLength: 8,
    passwordMaxLength: 128,
    sessionTimeout: 24 * 60 * 60 * 1000, // 24 hours
  },

  // WebSocket configuration
  websocket: {
    path: '/ws',
    heartbeatInterval: 30000, // 30 seconds
    maxConnections: 1000,
    messageSizeLimit: 1024 * 1024, // 1MB (legacy field — kept for back-compat)
    /**
     * C8: hard cap on a single WS frame. The application-level
     * message-validation layer (FILE_RATE_LIMITS.maxPayloadSize)
     * already enforces 100 MB per payload, but base64 encoding + JSON
     * envelope inflate that to ~140 MB on the wire. We set the WS
     * cap to 150 MB so legitimate traffic within the app-layer limit
     * passes through, while absurd frames (e.g. 1 GB DoS attempts)
     * are rejected at the TCP layer before parsing.
     */
    wsMaxPayload: 150 * 1024 * 1024, // 150 MB
    // Per-user concurrent device cap (C7).
    maxDevicesPerUser: 10,
  },

  // File upload configuration
  upload: {
    maxFileSize: 10 * 1024 * 1024, // 10MB
    allowedTypes: [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'text/plain',
      'application/json',
    ],
    uploadPath: process.env['UPLOAD_PATH'] || './uploads',
  },

  // Rate limiting
  rateLimit: {
    max: 100,
    timeWindow: 60000, // 1 minute
  },

  // File message rate limiting (Stage 5 - File Sharing)
  fileRateLimits: {
    maxPayloadSize: 100 * 1024 * 1024,    // 100 MB per message
    messagesPerMinute: 10,                 // 10 file messages per minute
    bytesPerHour: 500 * 1024 * 1024,       // 500 MB per hour
    sizeMismatchTolerance: 0.1,            // 10% tolerance for declared size
  },

  // Redis configuration
  redis: {
    url: process.env['REDIS_URL'] || null,
    enabled: !!process.env['REDIS_URL'],
    keyPrefix: 'zerochat:',
    sessionTTL: 3600, // 1 hour
    cacheTTL: 300, // 5 minutes
  },

  // Logging configuration
  logging: {
    level: process.env['LOG_LEVEL'] || 'info',
    format: 'json',
  },
};

export type Config = typeof config;