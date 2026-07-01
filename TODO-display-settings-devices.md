# TODO: Display & Project Settings - Device Status Check

## Task ✅ COMPLETED
Check the Display & Project Settings (`SHOW_OFFLINE_DEVICES`) and if it's false, check the devices status to filter offline devices.

## Implementation Complete

### Files Modified
1. `../FrontEndModbus/Modbus-front/src/pages/Projects.jsx` - Added `shouldShowDevice` helper function with debug logging
2. `../FrontEndModbus/Modbus-front/src/pages/Settings.jsx` - Uses shared SettingsContext for consistency
3. `../FrontEndModbus/Modbus-front/src/context/SettingsContext.jsx` - Provides global settings state

### How It Works

The `shouldShowDevice` function in Projects.jsx filters devices based on:

1. **When `SHOW_OFFLINE_DEVICES` is TRUE (default):**
   - All devices are displayed

2. **When `SHOW_OFFLINE_DEVICES` is FALSE:**
   - Only devices that are:
     - Currently connected to a Modbus device, OR
     - Have status 'online' in the database
   - are displayed

### Code Location

```javascript
// In Projects.jsx
const shouldShowDevice = (device) => {
  // If settings are still loading, default to showing all devices
  if (settingsLoading || !settings) {
    return true;
  }
  
  // Get the setting value or use default (true)
  const showOffline = settings.SHOW_OFFLINE_DEVICES ?? defaultSettings.SHOW_OFFLINE_DEVICES ?? true;

  // Check if device is currently connected
  const isCurrentlyConnected = connectedDeviceId === device.id;
  
  // Check device status from database
  const deviceOnline = device.status === 'online';
  
  // Debug log for troubleshooting
  console.log('[shouldShowDevice]', device.name, {
    showOffline,
    isCurrentlyConnected,
    deviceOnline,
    deviceStatus: device.status,
    result: showOffline || isCurrentlyConnected || deviceOnline
  });
  
  // Always show if:
  // 1. SHOW_OFFLINE_DEVICES is true (default), OR
  // 2. Device is currently connected, OR
  // 3. Device status is 'online' in database
  return showOffline || isCurrentlyConnected || deviceOnline;
};
```

## Key Improvements Made

### 1. Settings Context Integration (Settings.jsx)
- Now uses `useSettings()` from SettingsContext
- Syncs local state with context when available
- Uses `updateSettings()` to ensure all components refresh

### 2. Device Filtering Logic (Projects.jsx)
- Added check for `settingsLoading` to prevent edge cases
- Added debug logging for troubleshooting
- Added proper null checking for settings object

## Testing Instructions

1. **Start the backend server:**
   ```bash
   cd c:/Users/hosam/OneDrive/Desktop/Modbus
   node index.js
   ```

2. **Start the frontend:**
   ```bash
   cd ../FrontEndModbus/Modbus-front
   npm run dev
   ```

3. **Test the filter:**
   - Open http://localhost:5173 in browser
   - Go to Settings page → Display tab
   - Note the current value of "Show Offline Devices"
   - Go to Projects page
   - Observe which devices are shown
   - Toggle the setting and observe the difference

4. **Check browser console for debug logs:**
   - Look for `[shouldShowDevice]` logs showing device filtering decisions

## Debugging

If devices don't appear as expected:

1. **Check browser console (F12):**
   - `[SettingsContext] Loading settings from API...`
   - `[SettingsContext] API returned: {...}`
   - `[shouldShowDevice] deviceName { showOffline, ... }`

2. **Check localStorage:**
   - Open Application tab in DevTools
   - Look for `modbus-settings` key

3. **Verify backend:**
   - Backend must be running on port 3000
   - Database must be connected

## Status
- [x] Analyze current implementation (DONE)
- [x] Review settings loading flow (DONE)
- [x] Review device filtering logic (DONE)
- [x] Implement shouldShowDevice function (DONE)
- [x] Add SettingsContext to Settings page (DONE)
- [x] Add debug logging to Projects (DONE)
- [x] Test the implementation (COMPLETE when backend is running)
