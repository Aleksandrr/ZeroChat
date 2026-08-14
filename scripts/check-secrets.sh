#!/bin/bash

echo "=== Secrets Scanning ==="

# Patterns to search for
PATTERNS=(
    "password\s*[:=]\s*['\"][^'\"]+['\"]"
    "api_key\s*[:=]\s*['\"][^'\"]+['\"]"
    "apikey\s*[:=]\s*['\"][^'\"]+['\"]"
    "secret\s*[:=]\s*['\"][^'\"]+['\"]"
    "token\s*[:=]\s*['\"][^'\"]{20,}['\"]"
    "AWS[A-Z0-9_]*\s*[:=]\s*['\"][^'\"]+['\"]"
    "PRIVATE_KEY"
    "-----BEGIN.*KEY-----"
)

FOUND_ISSUES=0

for pattern in "${PATTERNS[@]}"; do
    echo "Checking pattern: $pattern"
    results=$(grep -r --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.json" --exclude-dir=node_modules --exclude-dir=dist -E "$pattern" /workspace 2>/dev/null | grep -v ".env.example" | grep -v "test" || true)
    
    if [ -n "$results" ]; then
        echo "⚠️  Potential secrets found:"
        echo "$results"
        FOUND_ISSUES=1
    fi
done

if [ $FOUND_ISSUES -eq 0 ]; then
    echo "✅ No obvious secrets found in source code"
fi

# Check for .env files in version control
echo ""
echo "=== Checking .env files ==="
if git ls-files | grep -q "\.env$"; then
    echo "⚠️  .env files are tracked in git! This is a security risk."
    git ls-files | grep "\.env$"
    FOUND_ISSUES=1
else
    echo "✅ No .env files tracked in git"
fi

exit $FOUND_ISSUES
