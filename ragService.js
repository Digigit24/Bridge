const { pool } = require('./db');
const { embedText } = require('./embeddingService');
const pgvector = require('pgvector/pg');

async function queryKnowledge(workflowId, query, topK = 5) {
  await pgvector.registerType(pool);

  const queryEmbedding = await embedText(query);

  const res = await pool.query(
    `SELECT kc.id, kc.content, kc.chunk_index, kc.document_id,
            kd.title AS document_title, kd.source_type, kd.source_id
     FROM knowledge_chunks kc
     JOIN knowledge_documents kd ON kd.id = kc.document_id
     WHERE kc.workflow_id = $1
     ORDER BY kc.embedding <-> $2
     LIMIT $3`,
    [workflowId, pgvector.toSql(queryEmbedding), topK]
  );

  return res.rows;
}

module.exports = { queryKnowledge };
