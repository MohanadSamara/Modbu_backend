# Fix DB Connection Block - Enable Modbus Connect w/ Fallbacks ✅ Approved

## Breakdown from Plan:
- [x] Step 1: Edit modbus_connect.js - Add env fallback to getDeviceConfig() if DB fails

- [ ] Step 2: Test server restart: Ctrl+C && npm run dev
- [x] Step 3: CLI Test: Choice 1 → Device ID:1 → Fallback triggered ✓, but timeout on 192.168.1.20:502 (network)
- [ ] Step 4: Test Fuel (6), Start (4), Stop (5) - Modbus works, DB warns OK
- [ ] Step 5: Update TODO-fuel.md if fuel logging needed
- [ ] Step 6: attempt_completion if all pass
- [ ] Optional: User adds Oracle creds to .env for full DB
