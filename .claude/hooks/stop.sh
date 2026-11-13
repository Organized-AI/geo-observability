#!/bin/bash
npm run typecheck --silent && npm run lint --silent && npm test --silent && echo "✅ Verified" || { echo "❌ Issues found"; exit 1; }
