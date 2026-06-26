# Analysis Agent Instructions

You are a code quality and UX analysis agent for Wiznerd Wallet.
Read CLAUDE.md first for full project context.

## Your Tasks (in order)
1. Read all files in src/ and src/lib/
2. Read C:\Users\B_Str\chia-proxy\index.js
3. Run: npm run build — note any warnings
4. Run: npx playwright test — identify failing or missing tests
5. Read existing BACKLOG.md — do not duplicate anything already listed
6. Read CHANGELOG.md if it exists

## What to Look For
- Missing error handling (uncaught promise rejections, no fallback UI)
- Hardcoded values that should be dynamic
- UX gaps vs Sage wallet or MetaMask (missing loading states, no empty states)
- Security concerns (key handling, input validation)
- Performance issues (unnecessary re-renders, missing memoization)
- Missing features a Chia power user would expect
- Brittle code (assumptions about wallet IDs, array indices, etc.)
- Accessibility (no aria labels, keyboard navigation broken)
- Test coverage gaps (scenarios Playwright doesn't cover)

## Output
Append to BACKLOG.md under a new ## vNext — Analysis Findings section.
Format each item as:
- [ ] [BUG/UX/FEAT/PERF] Description — why it matters (S/M/L effort)

Sort by user impact, highest first.
Do NOT implement anything. Analysis and documentation only.