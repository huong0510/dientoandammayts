require('dotenv').config();
const express = require('express');
const { Client } = require('pg');
const redis = require('redis');

const app = express();
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
app.use(express.json());

// --- PostgreSQL setup ---
const pgClient = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false // SSL only in production
});

pgClient.connect()
  .then(() => {
    console.log('✅ Connected to PostgreSQL');
    return pgClient.query(`
      CREATE TABLE IF NOT EXISTS public.users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL
      );
    `);
  })
  .then(() => console.log('✅ Table "users" is ready'))
  .catch(err => console.error('❌ PostgreSQL error', err.stack));

// --- Redis setup (optional) ---
let redisClient;
if (process.env.REDIS_URL && isProduction) {
  redisClient = redis.createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', err => {
    console.error('❌ Redis Error', err);
    // disable Redis on error to prevent repeated attempts
    redisClient = null;
  });
  redisClient.connect()
    .then(() => console.log('✅ Connected to Redis'))
    .catch(err => {
      console.error('❌ Redis connection error', err);
      redisClient = null;
    });
} else {
  console.log('⚠️  Redis disabled (only active in production with valid REDIS_URL)');
}

// --- ROUTES ---
// GET all users (cache with Redis nếu có)
app.get('/data', async (req, res) => {
  try {
    if (redisClient && req.query.refresh === 'true') {
      await redisClient.del('data');
      console.log('🔄 Cache cleared by refresh=true');
    }

    if (redisClient) {
      const cache = await redisClient.get('data');
      if (cache) {
        console.log('✅ Data from Redis cache');
        return res.json(JSON.parse(cache));
      }
    }

    const { rows } = await pgClient.query('SELECT * FROM public.users');
    if (redisClient) {
      await redisClient.setEx('data', 60, JSON.stringify(rows));
      console.log('✅ Data cached to Redis');
    }
    res.json(rows);

  } catch (err) {
    console.error('❌ Error fetching data', err.stack || err);
    res.status(500).send('Error fetching data');
  }
});

// CREATE user
app.post('/data', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).send('Name and email are required.');
  try {
    await pgClient.query(
      'INSERT INTO public.users (name, email) VALUES ($1, $2)',
      [name, email]
    );
    if (redisClient) await redisClient.del('data');
    res.status(201).send('Data added successfully');
  } catch (err) {
    console.error('❌ Error inserting data', err.stack || err);
    res.status(500).send('Error inserting data');
  }
});

// UPDATE user
app.put('/data/:id', async (req, res) => {
  const { id } = req.params;
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).send('Name and email are required.');
  try {
    await pgClient.query(
      'UPDATE public.users SET name = $1, email = $2 WHERE id = $3',
      [name, email, id]
    );
    if (redisClient) await redisClient.del('data');
    res.send('Data updated successfully');
  } catch (err) {
    console.error('❌ Error updating data', err.stack || err);
    res.status(500).send('Error updating data');
  }
});

// DELETE user
app.delete('/data/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pgClient.query('DELETE FROM public.users WHERE id = $1', [id]);
    if (redisClient) await redisClient.del('data');
    res.send('Data deleted successfully');
  } catch (err) {
    console.error('❌ Error deleting data', err.stack || err);
    res.status(500).send('Error deleting data');
  }
});

// Redirect root → /data
app.get('/', (req, res) => res.redirect('/data'));

// Start server
app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});
