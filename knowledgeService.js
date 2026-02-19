const { pool } = require('./db');
const { embedText } = require('./embeddingService');
const { fetchPageBlocks } = require('./notionService');
const pgvector = require('pgvector/pg');

// ── Text chunking ──────────────────────────────

function chunkText(text, size = 800, overlap = 100) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    start += size - overlap;
  }
  return chunks;
}

// ── Block → plain text extraction ──────────────

function blocksToText(blocks) {
  const parts = [];
  for (const block of blocks) {
    const rt = block[block.type]?.rich_text;
    if (rt && rt.length) {
      parts.push(rt.map(t => t.plain_text).join(''));
    }
    if (block.children) {
      parts.push(blocksToText(block.children));
    }
  }
  return parts.join('\n');
}

// ── Upsert document ────────────────────────────

async function upsertDocument(workflowId, sourceType, sourceId, title, content, metadata = {}) {
  const existing = await pool.query(
    'SELECT id FROM knowledge_documents WHERE workflow_id = $1 AND source_type = $2 AND source_id = $3',
    [workflowId, sourceType, sourceId]
  );

  let docId;
  if (existing.rows.length) {
    docId = existing.rows[0].id;
    await pool.query(
      'UPDATE knowledge_documents SET title = $1, content = $2, metadata = $3, updated_at = NOW() WHERE id = $4',
      [title, content, JSON.stringify(metadata), docId]
    );
  } else {
    const res = await pool.query(
      'INSERT INTO knowledge_documents (workflow_id, source_type, source_id, title, content, metadata, updated_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING id',
      [workflowId, sourceType, sourceId, title, content, JSON.stringify(metadata)]
    );
    docId = res.rows[0].id;
  }
  return docId;
}

// ── Index a Notion page ────────────────────────

async function indexNotionPage(workflowId, notionPageId) {
  // 1. Fetch blocks
  const blocks = await fetchPageBlocks(notionPageId);

  // 2. Extract text
  const text = blocksToText(blocks);
  if (!text.trim()) throw new Error('No text content found in page');

  // 3. Extract title from first heading or fallback
  let title = 'Untitled';
  for (const block of blocks) {
    if (block.type === 'heading_1' || block.type === 'heading_2' || block.type === 'child_page') {
      const rt = block[block.type]?.rich_text || [];
      if (rt.length) { title = rt.map(t => t.plain_text).join(''); break; }
      if (block[block.type]?.title) { title = block[block.type].title; break; }
    }
  }

  // 4. Upsert document
  const docId = await upsertDocument(workflowId, 'notion', notionPageId, title, text, {
    notion_page_id: notionPageId
  });

  // 5. Delete old chunks
  await pool.query('DELETE FROM knowledge_chunks WHERE document_id = $1', [docId]);

  // 6. Chunk + embed + store
  const chunks = chunkText(text);
  await pgvector.registerType(pool);

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embedText(chunks[i]);
    await pool.query(
      'INSERT INTO knowledge_chunks (document_id, workflow_id, chunk_index, content, embedding) VALUES ($1, $2, $3, $4, $5)',
      [docId, workflowId, i, chunks[i], pgvector.toSql(embedding)]
    );
  }

  console.log(`[Knowledge] Indexed page ${notionPageId}: ${chunks.length} chunks`);
  return { document_id: docId, chunks: chunks.length, title };
}

// ── Generic indexer (source-agnostic entry point) ──

async function indexDocument(workflowId, sourceType, sourceId, title, content, metadata = {}) {
  const docId = await upsertDocument(workflowId, sourceType, sourceId, title, content, metadata);

  await pool.query('DELETE FROM knowledge_chunks WHERE document_id = $1', [docId]);

  const chunks = chunkText(content);
  await pgvector.registerType(pool);

  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embedText(chunks[i]);
    await pool.query(
      'INSERT INTO knowledge_chunks (document_id, workflow_id, chunk_index, content, embedding) VALUES ($1, $2, $3, $4, $5)',
      [docId, workflowId, i, chunks[i], pgvector.toSql(embedding)]
    );
  }

  return { document_id: docId, chunks: chunks.length };
}

// ── List documents ─────────────────────────────

async function listDocuments(workflowId) {
  const res = await pool.query(
    'SELECT id, source_type, source_id, title, updated_at, created_at FROM knowledge_documents WHERE workflow_id = $1 ORDER BY updated_at DESC',
    [workflowId]
  );
  return res.rows;
}

// ── Delete document + chunks ───────────────────

async function deleteDocument(docId) {
  await pool.query('DELETE FROM knowledge_documents WHERE id = $1', [docId]);
}

module.exports = { indexNotionPage, indexDocument, listDocuments, deleteDocument, chunkText, blocksToText };
