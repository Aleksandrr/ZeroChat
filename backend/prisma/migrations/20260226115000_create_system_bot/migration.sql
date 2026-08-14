-- Create system bot user for ZeroChat system notifications
-- This user cannot authenticate and is used only for system messages

INSERT INTO users (id, username, "displayName", password, status, "createdAt", "updatedAt")
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'ZeroChat',
  'ZeroChat System',
  -- Password hash for a non-usable placeholder (will never be used)
  '$argon2id$v=19$m=65536,t=3,p=4$placeholder$placeholder',
  'OFFLINE',
  NOW(),
  NOW()
)
ON CONFLICT (username) DO NOTHING;

-- Verify the system bot was created
-- SELECT id, username, display_name, status FROM users WHERE username = 'ZeroChat';
