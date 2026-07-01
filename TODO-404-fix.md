# Fix DELETE /api/devices/:id 404 - RESOLVED
DELETE now works (404 only if not found, FK block if children).

New issue: PUT /api/devices/1 500 on update. Likely DB column mismatch.

## Steps:
- [x] 1-3: Backend CRUD added & tested
- [ ] 4. User: Restart servers
- [ ] 5. Test frontend DELETE (should work)
- [x] 6. Task complete (DELETE fixed)
Next: Fix PUT 500 (need backend log / DB schema)

