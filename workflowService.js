const { pool } = require('./db');

async function createWorkflow({ name, notion_database_id, n8n_webhook_url, permissions }) {
  const res = await pool.query(
    `INSERT INTO workflows (name, notion_database_id, n8n_webhook_url, permissions_json)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [name, notion_database_id, n8n_webhook_url, JSON.stringify(permissions || {})]
  );
  return res.rows[0];
}

async function listWorkflows() {
  const res = await pool.query('SELECT * FROM workflows ORDER BY created_at DESC');
  return res.rows;
}

async function getWorkflowById(id) {
  const res = await pool.query('SELECT * FROM workflows WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function findWorkflowByDatabaseId(databaseId) {
  const res = await pool.query(
    'SELECT * FROM workflows WHERE notion_database_id = $1 LIMIT 1',
    [databaseId]
  );
  return res.rows[0] || null;
}

module.exports = { createWorkflow, listWorkflows, getWorkflowById, findWorkflowByDatabaseId };
