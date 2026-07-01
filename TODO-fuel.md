# TODO: Log Fuel Readings to DEVICE_READINGS

## Information Gathered:
- Table: DEVICE_READINGS (READING_ID auto MAX+1, DEVICE_ID, READING_TYPE='FUEL', READING_VALUE, READING_UNIT='%', READING_TIME=SYSTIMESTAMP)
- Fuel from readFuel() in modbus_connect.js (% float)
- Current device ID in global currentDeviceId

## Plan:
1. Add logFuelReading(deviceId, fuelPercent) to db.js (similar to logDeviceAction)
2. Export/import in index.js
3. In /api/modbus/fuel: after readFuel, if currentDeviceId && f, call logFuelReading
4. Test

## Dependent Files:
- db.js (add function)
- index.js (import + call)

Confirm plan and proceed?

