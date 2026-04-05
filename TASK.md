# Fix Tracker — COMPLETED

## Backend (server.js) ✅
- [x] Fix login to not load ALL users for PIN check — now uses LIMIT 20 + async/await
- [x] Add CORS origin restriction (structured, still permissive for Expo mobile)
- [x] Add rate limits to /messages (60/min), /vault/upload (15/min), /nudges (30/min)
- [x] Add message/nudge text length validation (5000 / 500 chars)
- [x] Add Cache-Control headers for /uploads static files (7-day cache)
- [x] Add DELETE /messages/:id + POST /messages/:id/unsend endpoints
- [x] Remove ALL callback-style routes - fully async/await throughout
- [x] Remove broken leftover callback code from nudge route

## Frontend — Auth ✅
- [x] Create AuthContext (hooks/auth-context.tsx)
- [x] Wire AuthProvider into _layout.tsx
- [x] Remove pin_code from AuthUser type
- [x] Rewrite login screen to use AuthContext (no more globals)

## Frontend — Chat (explore.tsx) ✅
- [x] Fix seenMessageIdsRef duplicate if/else branch
- [x] Add maxLength={5000} to chat TextInput
- [x] Consolidate 3 poll timers into 1 coordinated interval

## Frontend — Tab Badge ✅
- [x] Add unread message badge dot to Chat tab icon

## Frontend — UX Fixes ✅
- [x] Fix hardcoded 'Shafique' fallback → generic 'there'
- [x] Remove dead "Forgot PIN" button (entire login rewritten cleanly)
- [x] Fix "Contact Support" → Linking.openURL mailto
- [x] Add vault delete confirmation dialog
- [x] Add dates delete confirmation dialog
- [x] Add pull-to-refresh to vault.tsx
- [x] Add pull-to-refresh to nudges.tsx
- [x] Add pull-to-refresh to dates.tsx
- [x] Add haptics to PIN entry (index.tsx)
- [x] Add maxLength to nudge input (500)
- [x] Add maxLength to date title input (120)
- [x] Fix logout to use AuthContext.logout

## Frontend — Dark Mode ✅
- [x] index.tsx — full dark mode theming
- [x] vault.tsx — full dark mode theming
- [x] nudges.tsx — full dark mode theming
- [x] dates.tsx — full dark mode theming
- [x] settings.tsx — full dark mode theming (all text, cards, inputs)

## Frontend — Code Quality ✅
- [x] Split login from dashboard (LoginScreen now embedded in index.tsx cleanly)
- [x] Fix useEffect dependency arrays in settings.tsx
- [x] Remove duplicate imports in _layout.tsx

## Outstanding (requires more invasive work)
- [ ] Chat image attachments upload to server before sending
- [ ] Full WebSocket implementation (Socket.io)
- [ ] Push notifications (expo-notifications)
- [ ] Message pagination (LIMIT 50 + load more)
- [ ] Vault pagination
