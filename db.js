const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  const client = await pool.connect();
  try {
    // Enable pgvector extension
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    await client.query(`
      CREATE TABLE IF NOT EXISTS notion_tokens (
        id SERIAL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        access_token TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS workflows (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        notion_database_id TEXT NOT NULL,
        n8n_webhook_url TEXT NOT NULL,
        permissions_json JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workflow_id UUID REFERENCES workflows(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT,
        content TEXT,
        metadata JSONB DEFAULT '{}',
        updated_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id UUID REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        workflow_id UUID,
        chunk_index INTEGER,
        content TEXT,
        embedding vector(1536),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('[DB] Tables initialized (with pgvector)');
  } finally {
    client.release();
  }
}

async function getLatestToken() {
  const res = await pool.query(
    'SELECT access_token FROM notion_tokens ORDER BY created_at DESC LIMIT 1'
  );
  if (res.rows.length === 0) throw new Error('No Notion token found. Complete OAuth first.');
  return res.rows[0].access_token;
}

async function saveToken(workspaceId, accessToken) {
  await pool.query(
    'INSERT INTO notion_tokens (workspace_id, access_token) VALUES ($1, $2)',
    [workspaceId, accessToken]
  );
}

module.exports = { pool, initDB, getLatestToken, saveToken };
