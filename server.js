// server.js
// Simple master/slave MySQL demo with an in-memory read cache.
// Ready-to-read comments for a step-by-step YouTube walkthrough.

import express from 'express';
import mysql from 'mysql2/promise.js';
import config from './config.js';

const app = express();
// parse JSON bodies for POST/PUT requests
app.use(express.json());

// -----------------------------
// Pools: master (writes) & slaves (reads)
// -----------------------------

// Master pool: all writes go here
const masterPool = mysql.createPool(config.master);

// Slave pools: reads will round-robin across these
const slavePools = config.slaves.map(slave => mysql.createPool(slave));

// -----------------------------
// Round-robin simple selector
// -----------------------------
// We'll rotate through slaves for read requests.
// This is the simplest load-splitter and perfect for demos.
let slaveIndex = 0;
const getSlave = () => {
  const slave = slavePools[slaveIndex];
  // increment index and wrap around
  slaveIndex = (slaveIndex + 1) % slavePools.length;
  return slave;
};

// -----------------------------
// In-memory cache (TTL based)
// -----------------------------
// Small demo cache so repeated reads don't hit the DB every time.
// TTL is short (10s) so you can show writes invalidating and replication.
const CACHE = new Map(); // key -> { data, timestamp }
const CACHE_TTL = 10 * 1000; // 10 seconds cache lifetime

const setCache = (key, data) => {
  CACHE.set(key, { data, timestamp: Date.now() });
};

const getCache = (key) => {
  const cached = CACHE.get(key);
  if (!cached) return null;
  // expire entries older than TTL
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    CACHE.delete(key);
    return null;
  }
  return cached.data;
};

// -----------------------------
// Utility: wait for DB
// -----------------------------
// When the app starts we try to talk to the DB a few times.
// This is useful in Docker where DB container may boot slower.
const waitForDB = async (pool, name) => {
  let retries = 20;
  while (retries) {
    try {
      const conn = await pool.getConnection(); // try to get a connection
      conn.release();
      console.log(`${name} DB is ready`);
      break;
    } catch {
      retries--;
      console.log(`⏳ Waiting for ${name} DB... (${retries} retries left)`);
      // pause and try again
      await new Promise(res => setTimeout(res, 3000));
    }
  }
};

// -----------------------------
// Replication user (master)
// -----------------------------
// Create a replication user if it doesn't exist. This user will be used
// by the slave containers to connect and replicate binlog events.
// Note: we keep credentials simple for demo purposes.
const ensureReplicationUser = async () => {
  const REPL_USER = 'replica';
  const REPL_PASS = 'replica_pass';
  try {
    const conn = await mysql.createConnection(config.master);
    // CREATE USER IF NOT EXISTS keeps this idempotent for restarts
    await conn.query(`CREATE USER IF NOT EXISTS '${REPL_USER}'@'%' IDENTIFIED BY '${REPL_PASS}';`);
    // Grant the replication privileges required by MySQL replication
    await conn.query(`GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO '${REPL_USER}'@'%';`);
    await conn.query('FLUSH PRIVILEGES;');
    conn.end();
    console.log('Replication user ensured on master');
  } catch (err) {
    // If this fails, replication will not start later; helpful to surface.
    console.error('Error creating replication user:', err.message);
  }
};

// -----------------------------
// Ensure slave DB exists
// -----------------------------
// When using dockerized fresh MySQL servers, the slave containers may not
// have the demo database created. Creating it on the slave avoids replication
// failing on DDL statements that reference the database.
const ensureSlaveDatabases = async () => {
  for (const slaveCfg of config.slaves) {
    try {
      // connect to slave and create database if missing
      const slaveConn = await mysql.createConnection(slaveCfg);
      await slaveConn.query('CREATE DATABASE IF NOT EXISTS blogdb;');
      slaveConn.end();
      console.log(`Database blogdb ensured on ${slaveCfg.host}`);
    } catch (err) {
      console.error(`Error ensuring DB on ${slaveCfg.host}:`, err.message);
    }
  }
};

// -----------------------------
// Setup replication (master -> slaves)
// -----------------------------
// This is a convenience routine for the demo: it reads the master's
// current binlog file/position and tells each slave to start replicating
// from that position. For production you'd usually configure your
// replicas ahead of time or use a proper provisioning script.
const setupReplication = async () => {
  const REPL_USER = 'replica';
  const REPL_PASS = 'replica_pass';
  try {
    const masterConn = await mysql.createConnection(config.master);

    // Make sure binary logging is enabled on the master
    const [binlog] = await masterConn.query("SHOW VARIABLES LIKE 'log_bin';");
    if (!binlog.length || binlog[0].Value !== 'ON')
      throw new Error('Binary logging is disabled on master');

    // MySQL 8+ uses SHOW BINARY LOG STATUS in this demo; it returns the current file/pos
    const [rows] = await masterConn.query('SHOW BINARY LOG STATUS');
    const { File: logFile, Position: logPos } = rows[0];
    console.log(`Master log file: ${logFile}, position: ${logPos}`);

    // Configure every slave to point to the master at the chosen file/position
    for (const slaveCfg of config.slaves) {
      const slaveConn = await mysql.createConnection(slaveCfg);
      // STOP REPLICA is the modern name for STOP SLAVE
      await slaveConn.query('STOP REPLICA;');
      await slaveConn.query(`
        CHANGE REPLICATION SOURCE TO
          SOURCE_HOST='mysql-master',
          SOURCE_USER='${REPL_USER}',
          SOURCE_PASSWORD='${REPL_PASS}',
          SOURCE_LOG_FILE='${logFile}',
          SOURCE_LOG_POS=${logPos},
          GET_SOURCE_PUBLIC_KEY=1;
      `);
      await slaveConn.query('START REPLICA;');
      slaveConn.end();
      console.log(`Slave ${slaveCfg.host} replication started`);
    }

    masterConn.end();
    console.log('Replication configured successfully');
  } catch (err) {
    // For teaching it's useful to show the message — common problems include
    // wrong credentials, wrong log position, or GTID vs file/pos mismatch.
    console.error('Replication setup failed:', err.message);
  }
};

// -----------------------------
// Init master table (idempotent)
// -----------------------------
// Create the `blogs` table on the master if missing. We use JSON column for
// flexibility so we can insert arbitrary blog payloads during the demo.
const initDB = async () => {
  const conn = await masterPool.getConnection();
  await conn.query(`
    CREATE TABLE IF NOT EXISTS blogs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      data JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  conn.release();
  console.log('Blogs table ready');
};

// -----------------------------
// Ensure table exists on slaves
// -----------------------------
// Sometimes replicas start empty and trying to apply a DML/DDL event that
// references a missing table will cause replica SQL thread to error.
// Creating the same DDL on slaves ahead of time makes the demo smoother.
const ensureTableOnSlaves = async () => {
  const tableSQL = `
    CREATE TABLE IF NOT EXISTS blogs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      data JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  for (const slaveCfg of config.slaves) {
    try {
      const conn = await mysql.createConnection({ ...slaveCfg, database: 'blogdb' });
      await conn.query(tableSQL);
      conn.end();
      console.log(`blogs table ensured on ${slaveCfg.host}`);
    } catch (err) {
      console.error(`Error ensuring blogs table on ${slaveCfg.host}:`, err.message);
    }
  }
};

// -----------------------------
// API ROUTES
// -----------------------------

// CREATE blog (writes go to master)
// We invalidate cache on every write to keep read results fresh.
app.post('/blog', async (req, res) => {
  try {
    const conn = await masterPool.getConnection();
    // store full payload as JSON — easy to demo varying schemas
    await conn.query('INSERT INTO blogs (data) VALUES (?)', [JSON.stringify(req.body)]);
    conn.release();
    CACHE.clear(); // invalidate all cache entries (simple strategy)
    res.json({ message: 'Blog created successfully' });
  } catch (err) {
    console.error('Error inserting blog:', err);
    res.status(500).json({ error: 'Error inserting blog' });
  }
});

// READ blogs (reads go to slaves + cached)
// Supports pagination via ?page and ?limit.
app.get('/blogs', async (req, res) => {
  try {
    // default page=1, limit=5 for a compact UI demo
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 5;
    const offset = (page - 1) * limit;
    const cacheKey = `blogs_${page}_${limit}`;

    // 1) If cache hit — return quickly
    const cached = getCache(cacheKey);
    if (cached) {
      console.log(`⚡ Cache hit for ${cacheKey}`);
      return res.json({ source: 'cache', ...cached });
    }

    // 2) Otherwise pick a slave and query
    const slave = getSlave();
    // we can reach into the pool config to get the original host name for logs
    const dbHost = slave.pool.config.connectionConfig.host;
    const conn = await slave.getConnection();

    // fetch page from the replica, ordering by id DESC so new posts show first
    const [rows] = await conn.query(
      'SELECT * FROM blogs ORDER BY id DESC LIMIT ? OFFSET ?',
      [limit, offset]
    );

    conn.release();

    // convert JSON column back to JS object if needed
    const blogs = rows.map(r => ({
      id: r.id,
      ...(typeof r.data === 'string' ? JSON.parse(r.data) : r.data)
    }));

    console.log(`Fetched from ${dbHost} (page=${page}, limit=${limit})`);

    const response = {
      source: dbHost,
      page,
      limit,
      size: blogs.length,
      blogs
    };

    // store response in cache for quick subsequent reads
    setCache(cacheKey, response);
    res.json(response);

  } catch (err) {
    // log the full error for debugging during the livestream
    console.error('Error fetching blogs:', err);
    res.status(500).json({ error: 'Error fetching blogs' });
  }
});

// DELETE blog (master)
// delete also clears cache so reads will reflect the change quickly
app.delete('/blog/:id', async (req, res) => {
  try {
    const conn = await masterPool.getConnection();
    await conn.query('DELETE FROM blogs WHERE id = ?', [req.params.id]);
    conn.release();
    CACHE.clear(); // invalidate cache on delete
    res.json({ message: 'Blog deleted successfully' });
  } catch (err) {
    console.error('Error deleting blog:', err);
    res.status(500).json({ error: 'Error deleting blog' });
  }
});

// -----------------------------
// Bootstrap: run startup sequence
// -----------------------------
// The order matters: wait for master, ensure replication user & table,
// create DB/table on slaves for safety, then configure replication.
const startServer = async () => {
  await waitForDB(masterPool, 'Master');
  await ensureReplicationUser();
  await initDB();
  await ensureSlaveDatabases();
  await ensureTableOnSlaves();
  await setupReplication();
  app.listen(5000, () => console.log('Server running on port 5000'));
};

startServer();
