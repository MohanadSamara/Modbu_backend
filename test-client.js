const axios = require('axios');
const readline = require('readline');
require('dotenv').config();

const BASE_URL = 'http://localhost:3000/api';
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiCall(method, endpoint, data = {}) {
  try {
    const response = await axios({ method, url: `${BASE_URL}${endpoint}`, data, headers: { 'Content-Type': 'application/json' } });
    console.log('✅ Success:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    console.log('❌ Error:', error.response?.data || error.message);
  }
}

async function prompt(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function mainMenu() {
  console.log('\n=== Modbus CLI Client ===');
  console.log('1. List Devices');
  console.log('2. Connect Modbus (device_id or ip)');
  console.log('3. List Actions');
  console.log('4. List Readings');
  console.log('5. Add Action');
  console.log('6. Add Reading');
  console.log('7. Health Check');
  console.log('0. Exit');

  const choice = await prompt('Choose: ');
  switch (choice) {
    case '1':
      await apiCall('GET', '/devices');
      break;
    case '2':
      const connType = await prompt('device_id or ip? ');
      if (connType.match(/^\d+$/)) {
        await apiCall('GET', `/modbus/connect?device_id=${connType}`);
      } else {
        const port = await prompt('port (502)? ') || 502;
        await apiCall('GET', `/modbus/connect?ip=${connType}&port=${port}`);
      }
      break;
    case '3':
      await apiCall('GET', '/device-actions');
      break;
    case '4':
      await apiCall('GET', '/device-readings');
      break;
    case '5':
      const actionId = await prompt('action_id: ');
      const deviceId = await prompt('device_id: ');
      const actionType = await prompt('action_type (start/stop): ');
      await apiCall('POST', '/device-actions', { action_id: parseInt(actionId), device_id: parseInt(deviceId), action_type: actionType });
      break;
    case '6':
      const readingId = await prompt('reading_id: ');
      const devId = await prompt('device_id: ');
      const rType = await prompt('reading_type (fuel/temp): ');
      const rValue = await prompt('reading_value: ');
      const rUnit = await prompt('reading_unit (%/C): ') || '%';
      await apiCall('POST', '/device-readings', { reading_id: parseInt(readingId), device_id: parseInt(devId), reading_type: rType, reading_value: parseFloat(rValue), reading_unit: rUnit });
      break;
    case '7':
      await apiCall('GET', '/health');
      await apiCall('GET', '/modbus/fuel');
      break;
    case '0':
      rl.close();
      return;
    default:
      console.log('Invalid choice');
  }
  await mainMenu();
}

// Run: node test-client.js (server must be running: node index.js)
mainMenu().catch(console.error);
