/**
 * Location API Test File
 * Tests all location-related endpoints
 * 
 * Run: node test-locations.js (server must be running: node index.js)
 */

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
    return response.data;
  } catch (error) {
    console.log('❌ Error:', error.response?.data || error.message);
    return null;
  }
}

async function prompt(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ============================================================================
// Test Functions
// ============================================================================

async function testListLocations() {
  console.log('\n--- Test: List Locations for Project ---');
  const projectId = await prompt('Enter project ID (default 1): ');
  const pid = parseInt(projectId) || 1;
  return apiCall('GET', `/projects/${pid}/locations`);
}

async function testCreateLocation() {
  console.log('\n--- Test: Create Location ---');
  const projectId = await prompt('Enter project ID: ');
  const name = await prompt('Enter location name: ');
  const description = await prompt('Enter description (optional): ');
  const address = await prompt('Enter address (optional): ');
  
  const data = { name, description: description || undefined, address: address || undefined };
  return apiCall('POST', `/projects/${projectId}/locations`, data);
}

async function testGetLocation() {
  console.log('\n--- Test: Get Single Location ---');
  const locationId = await prompt('Enter location ID: ');
  return apiCall('GET', `/locations/${locationId}`);
}

async function testUpdateLocation() {
  console.log('\n--- Test: Update Location ---');
  const locationId = await prompt('Enter location ID: ');
  const name = await prompt('Enter new name: ');
  const description = await prompt('Enter description (optional): ');
  const address = await prompt('Enter address (optional): ');
  const parentId = await prompt('Enter parent_id (optional, 0 to remove): ');
  
  const data = { 
    name, 
    description: description || undefined, 
    address: address || undefined,
    parent_id: parentId ? parseInt(parentId) : undefined
  };
  return apiCall('PUT', `/locations/${locationId}`, data);
}

async function testDeleteLocation() {
  console.log('\n--- Test: Delete Location ---');
  const locationId = await prompt('Enter location ID to delete: ');
  return apiCall('DELETE', `/locations/${locationId}`);
}

async function testGetLocationDevices() {
  console.log('\n--- Test: Get Devices by Location ---');
  const locationId = await prompt('Enter location ID: ');
  return apiCall('GET', `/locations/${locationId}/devices`);
}

async function testGetLocationChildren() {
  console.log('\n--- Test: Get Sub-Locations ---');
  const locationId = await prompt('Enter parent location ID: ');
  return apiCall('GET', `/locations/${locationId}/children`);
}

async function testListProjects() {
  console.log('\n--- Test: List Projects ---');
  return apiCall('GET', '/projects');
}

async function testCreateProject() {
  console.log('\n--- Test: Create Project ---');
  const name = await prompt('Enter project name: ');
  const description = await prompt('Enter description (optional): ');
  return apiCall('POST', '/projects', { name, description: description || undefined });
}

// ============================================================================
// Main Menu
// ============================================================================

async function mainMenu() {
  console.log('\n=== Location API Test Menu ===');
  console.log('1. List Projects');
  console.log('2. Create Project');
  console.log('3. List Locations (by project)');
  console.log('4. Create Location');
  console.log('5. Get Single Location');
  console.log('6. Update Location');
  console.log('7. Delete Location');
  console.log('8. Get Devices by Location');
  console.log('9. Get Sub-Locations');
  console.log('0. Exit');
  console.log('--------------------------------');

  const choice = await prompt('Choose: ');
  switch (choice) {
    case '1':
      await testListProjects();
      break;
    case '2':
      await testCreateProject();
      break;
    case '3':
      await testListLocations();
      break;
    case '4':
      await testCreateLocation();
      break;
    case '5':
      await testGetLocation();
      break;
    case '6':
      await testUpdateLocation();
      break;
    case '7':
      await testDeleteLocation();
      break;
    case '8':
      await testGetLocationDevices();
      break;
    case '9':
      await testGetLocationChildren();
      break;
    case '0':
      rl.close();
      return;
    default:
      console.log('Invalid choice');
  }
  await mainMenu();
}

// Run tests
console.log('Location API Testing Tool');
console.log('Make sure server is running: node index.js');
mainMenu().catch(console.error);
