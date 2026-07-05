// Directly read the GPS registers from a device (no API/auth needed).
// Usage: node probe-gps.js <ip> [port]
//   node probe-gps.js 192.168.1.10 502
const ModbusRTU = require('modbus-serial');

const ip = process.argv[2] || '192.168.1.10';
const port = parseInt(process.argv[3] || '502', 10);

(async () => {
  const client = new ModbusRTU();
  client.setTimeout(5000);
  try {
    await client.connectTCP(ip, { port });
    console.log(`Connected to ${ip}:${port}`);

    try {
      const fuel = await client.readHoldingRegisters(10363, 1);
      console.log(`Fuel reg 10363 raw=${fuel.data[0]} -> ${fuel.data[0] / 10}%`);
    } catch (e) { console.log('Fuel read failed:', e.message); }

    try {
      const res = await client.readHoldingRegisters(10594, 6); // lat[2] lon[2] alt[2]
      const buf = res.buffer;
      console.log('GPS regs 10594..10599 raw words:', res.data);
      console.log('  latRaw =', buf.readInt32BE(0), ' -> deg', buf.readInt32BE(0) / 1e6);
      console.log('  lonRaw =', buf.readInt32BE(4), ' -> deg', buf.readInt32BE(4) / 1e6);
      console.log('  altRaw =', buf.readInt32BE(8));
    } catch (e) { console.log('GPS read failed:', e.message); }

    await client.close();
    process.exit(0);
  } catch (e) {
    console.error('Connect failed:', e.message);
    process.exit(1);
  }
})();
