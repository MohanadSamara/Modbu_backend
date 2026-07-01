# TODO: Connect Modbus Backend to مودبس D-500 Frontend

## Information Gathered:
- Backend: Modbus/ (current dir, Node.js + Oracle + Modbus TCP)
- Frontend: مودبس D-500/modbu/ (React/Vite, mock data: mockModbusDevices.js etc.)

## Plan:
1. Backend: Add CORS to index.js for frontend origin
2. Backend: New API endpoints matching frontend expectations (devices list, real-time registers, events from DB)
3. Frontend: Replace mock data with API calls to backend (localhost:3000)
4. Frontend: Add real WebSocket or polling for live data

## Dependent Files:
**Backend:**
- index.js (CORS + new endpoints /api/registers, /api/events)
**Frontend:**
- modbu/src/hooks/useMockData.js → useRealData.js
- modbu/src/data/mock* → API services

## Followup:
- npm install cors in backend
- npm run dev in frontend

Approve plan? What specific frontend screens need data first?

