import { describe, it, expect } from 'vitest';
import { isPasswordStrong, hashPassword, verifyPassword, generateSecureRandomPassword } from '../password';

describe('Password Utils - Unit Tests', () => {
  describe('isPasswordStrong', () => {
    it('should accept a strong password', () => {
      const result = isPasswordStrong('StrongP@ss123');
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject password shorter than 8 characters', () => {
      const result = isPasswordStrong('Abc1!');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must be at least 8 characters long');
    });

    it('should reject password longer than 128 characters', () => {
      const longPassword = 'A'.repeat(129) + 'b1!';
      const result = isPasswordStrong(longPassword);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must be less than 128 characters long');
    });

    it('should reject password without uppercase letter', () => {
      const result = isPasswordStrong('lowercase123!');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one uppercase letter');
    });

    it('should reject password without lowercase letter', () => {
      const result = isPasswordStrong('UPPERCASE123!');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one lowercase letter');
    });

    it('should reject password without number', () => {
      const result = isPasswordStrong('NoNumbersHere!');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one number');
    });

    it('should reject password without special character', () => {
      const result = isPasswordStrong('NoSpecial123');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one special character');
    });

    it('should return multiple errors for weak password', () => {
      const result = isPasswordStrong('abc');
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(2);
    });
  });

  describe('hashPassword and verifyPassword', () => {
    it('should hash and verify a valid password', async () => {
      const password = 'SecureP@ssw0rd!';
      const hash = await hashPassword(password);
      
      expect(hash).toBeDefined();
      expect(hash).not.toBe(password);
      
      const isValid = await verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('should reject wrong password', async () => {
      const password = 'SecureP@ssw0rd!';
      const wrongPassword = 'WrongP@ssw0rd!';
      const hash = await hashPassword(password);
      
      const isValid = await verifyPassword(wrongPassword, hash);
      expect(isValid).toBe(false);
    });

    it('should produce different hashes for same password', async () => {
      const password = 'SameP@ssw0rd!';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);
      
      expect(hash1).not.toBe(hash2);
      
      // Both should verify correctly
      expect(await verifyPassword(password, hash1)).toBe(true);
      expect(await verifyPassword(password, hash2)).toBe(true);
    });
  });

  describe('generateSecureRandomPassword', () => {
    it('should generate password of specified length', () => {
      const password = generateSecureRandomPassword(16);
      expect(password.length).toBe(16);
    });

    it('should generate different passwords each time', () => {
      const passwords = new Set<string>();
      for (let i = 0; i < 10; i++) {
        passwords.add(generateSecureRandomPassword(12));
      }
      // All passwords should be unique
      expect(passwords.size).toBe(10);
    });

    it('should generate passwords with mixed character types', () => {
      // Generate multiple passwords and check character distribution
      const allChars = Array.from({ length: 20 }, () => generateSecureRandomPassword(50)).join('');
      
      expect(/[A-Z]/.test(allChars)).toBe(true);
      expect(/[a-z]/.test(allChars)).toBe(true);
      expect(/[0-9]/.test(allChars)).toBe(true);
      expect(/[!@#$%^&*()_+\-=\]{}|;:,.<>?]/.test(allChars)).toBe(true);
    });

    it('should generate strong passwords by default', () => {
      // Generate multiple passwords and check that most are strong
      // (there's a small chance of weak password due to randomness)
      const strongCount = Array.from({ length: 10 }, () => 
        isPasswordStrong(generateSecureRandomPassword(16)).isValid
      ).filter(Boolean).length;
      
      // At least 8 out of 10 should be strong
      expect(strongCount).toBeGreaterThanOrEqual(8);
    });
  });
});
