import { FastifyRequest } from 'fastify';

export interface RegisterInput {
  username: string;
  password: string;
  displayName?: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

export type ValidationResult = { valid: boolean; errors: string[] };

function validateRegisterInput(request: FastifyRequest<{ Body: RegisterInput }>): ValidationResult {
  const { username, password, displayName } = request.body;

  const errors: string[] = [];

  // Reserved usernames that cannot be used
  const RESERVED_USERNAMES = ['ZeroChat', 'zerochat', 'zer0chat', 'Zer0Chat', 'system', 'admin', 'support'];
  
  // Validate username
  if (!username || username.trim().length === 0) {
    errors.push('Username is required');
  } else if (username.length < 3 || username.length > 30) {
    errors.push('Username must be between 3 and 30 characters');
  } else if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    errors.push('Username can only contain letters, numbers, and underscores');
  } else if (RESERVED_USERNAMES.some(reserved => 
    username.toLowerCase() === reserved.toLowerCase() ||
    username.toLowerCase().includes('zerochat')
  )) {
    errors.push('This username is reserved and cannot be used');
  }

  // Validate displayName (optional)
  if (displayName !== undefined && displayName !== null) {
    if (displayName.length > 50) {
      errors.push('Display name must be less than 50 characters');
    }
    if (displayName.toLowerCase().includes('zerochat')) {
      errors.push('Display name cannot contain "ZeroChat"');
    }
  }

  // Validate password
  if (!password || password.length === 0) {
    errors.push('Password is required');
  } else if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }

  return { valid: errors.length === 0, errors };
}

function validateLoginInput(request: FastifyRequest<{ Body: LoginInput }>): ValidationResult {
  const { username, password } = request.body;

  const errors: string[] = [];

  // Validate username
  if (!username || username.trim().length === 0) {
    errors.push('Username is required');
  }

  // Validate password
  if (!password || password.length === 0) {
    errors.push('Password is required');
  }

  return { valid: errors.length === 0, errors };
}

function validateChatInput(request: FastifyRequest<{ Body: { name?: string; type?: string } }>): ValidationResult {
  const { name, type } = request.body;

  const errors: string[] = [];

  // Validate chat type
  if (!type || !['PRIVATE', 'GROUP', 'CHANNEL'].includes(type)) {
    errors.push('Invalid chat type. Must be PRIVATE, GROUP, or CHANNEL');
  }

  // Validate name for group chats
  if (type === 'GROUP' && (!name || name.trim().length === 0)) {
    errors.push('Name is required for group chats');
  } else if (type === 'GROUP' && (name!.length < 1 || name!.length > 100)) {
    errors.push('Group name must be between 1 and 100 characters');
  }

  return { valid: errors.length === 0, errors };
}

function validateMessageInput(request: FastifyRequest<{ Body: { content?: string; type?: string } }>): ValidationResult {
  const { content, type } = request.body;

  const errors: string[] = [];

  // Validate message type
  if (!type || !['TEXT', 'IMAGE', 'FILE', 'AUDIO', 'VIDEO', 'SYSTEM'].includes(type)) {
    errors.push('Invalid message type. Must be TEXT, IMAGE, FILE, AUDIO, VIDEO, or SYSTEM');
  }

  // Validate content for text messages
  if (type === 'TEXT' && (!content || content.trim().length === 0)) {
    errors.push('Content is required for text messages');
  } else if (type === 'TEXT' && content!.length > 4000) {
    errors.push('Message content must be less than 4000 characters');
  }

  return { valid: errors.length === 0, errors };
}

export {
  validateRegisterInput,
  validateLoginInput,
  validateChatInput,
  validateMessageInput,
};
