const { getConnection } = require('./db');

async function test() {
  const connection = await getConnection();
  if (connection) {
    // Test query
    const result = await connection.execute('SELECT * FROM devices');
    console.log('Devices:', result.rows);
    await connection.close();
  }
}

test();