require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const logger = require('./logger');
const { initDB, saveToken } = require('./db');
const { createPage, listPages, updatePage, archivePage, listDatabases } = require('./notionService');
const { createWorkflow, listWorkflows, getWorkflowById, findWorkflowByDatabaseId } = require('./workflowService');
const { verifyNotionSignature, forwardToN8N } = require('./webhookService');
const { indexNotionPage, listDocuments, deleteDocument } = require('./knowledgeService');
const { queryKnowledge } = require('./ragService');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Raw body capture for webhook signature verification
app.use('/webhooks/notion', express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); }
}));

app.use(express.json());

// ─── Static frontend ─────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ─── Health ──────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'Bridge API running' });
});

// ─── Notion OAuth ────────────────────────────────────────

app.get('/auth/notion/status', async (_req, res) => {
  try {
    const { getLatestToken } = require('./db');
    const token = await getLatestToken();
    const via = process.env.NOTION_TOKEN ? 'api_key' : 'oauth';
    res.json({ connected: !!token, configured: !!process.env.NOTION_CLIENT_ID, via });
  } catch {
    res.json({ connected: false, configured: !!process.env.NOTION_CLIENT_ID, via: null });
  }
});

// Save a Notion internal integration token directly (no OAuth needed)
app.post('/auth/notion/token', async (req, res) => {
  const { token } = req.body;
  if (!token || !token.startsWith('secret_')) {
    return res.status(400).json({ error: 'Invalid token — must start with secret_' });
  }
  try {
    await saveToken('manual', token);
    logger.info('Auth', 'Internal integration token saved manually');
    res.json({ saved: true });
  } catch (err) {
    logger.error('Auth', 'Failed to save token', { message: err.message });
    res.status(500).json({ error: 'Failed to save token' });
  }
});

app.get('/auth/notion/login', (_req, res) => {
  const clientId = process.env.NOTION_CLIENT_ID;
  const redirectUri = process.env.NOTION_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    logger.error('Auth', 'OAuth not configured — missing NOTION_CLIENT_ID or NOTION_REDIRECT_URI');
    return res.status(500).json({
      error: 'Notion OAuth not configured',
      fix: 'Set NOTION_CLIENT_ID and NOTION_REDIRECT_URI in your .env file'
    });
  }

  const url = `https://api.notion.com/v1/oauth/authorize?client_id=${clientId}&response_type=code&owner=user&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

app.get('/auth/notion/callback', async (req, res) => {
  const { code, error: oauthError, error_description } = req.query;

  // Notion sends an "error" query param if the user denied access
  if (oauthError) {
    const desc = error_description || '';
    logger.error('Auth', 'OAuth denied by user or Notion', { error: oauthError, description: desc });
    return res.redirect(
      `/?auth_error=${encodeURIComponent(oauthError)}&auth_error_detail=${encodeURIComponent(desc)}`
    );
  }

  if (!code) {
    logger.error('Auth', 'Missing code parameter in OAuth callback');
    return res.status(400).json({ error: 'Missing code parameter' });
  }

  try {
    const encoded = Buffer.from(
      `${process.env.NOTION_CLIENT_ID}:${process.env.NOTION_CLIENT_SECRET}`
    ).toString('base64');

    const response = await axios.post('https://api.notion.com/v1/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.NOTION_REDIRECT_URI
    }, {
      headers: {
        'Authorization': `Basic ${encoded}`,
        'Content-Type': 'application/json'
      }
    });

    const { workspace_id, access_token, workspace_name } = response.data;
    await saveToken(workspace_id, access_token);
    logger.info('Auth', 'Token saved', { workspace_id, workspace_name });
    res.redirect('/?connected=true');
  } catch (err) {
    const errData = err.response?.data || {};
    const errMsg = errData.error || err.message || 'unknown_error';
    const errDesc = errData.error_description || '';
    const httpStatus = err.response?.status;

    logger.error('Auth', 'OAuth token exchange failed', {
      http_status: httpStatus,
      error: errMsg,
      description: errDesc,
      notion_response: errData
    });

    const display = errDesc ? `${errMsg}: ${errDesc}` : errMsg;
    res.redirect(
      `/?auth_error=${encodeURIComponent(display)}&auth_error_detail=${encodeURIComponent(JSON.stringify(errData))}`
    );
  }
});

// ─── Notion meta (databases list) ────────────────────────

app.get('/api/notion/databases', async (_req, res) => {
  try {
    const dbs = await listDatabases();
    res.json(dbs);
  } catch (err) {
    logger.error('Notion', 'Failed to list databases', { message: err.message });
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─── Workflows ───────────────────────────────────────────

app.post('/api/workflows', async (req, res) => {
  try {
    const { name, notion_database_id, n8n_webhook_url, permissions } = req.body;
    if (!name || !notion_database_id || !n8n_webhook_url) {
      return res.status(400).json({ error: 'name, notion_database_id, and n8n_webhook_url are required' });
    }
    const workflow = await createWorkflow({ name, notion_database_id, n8n_webhook_url, permissions });
    logger.info('Workflow', 'Created', { id: workflow.id, name });
    res.status(201).json(workflow);
  } catch (err) {
    logger.error('Workflow', 'Create error', { message: err.message });
    res.status(500).json({ error: 'Failed to create workflow' });
  }
});

app.get('/api/workflows', async (_req, res) => {
  try {
    const workflows = await listWorkflows();
    res.json(workflows);
  } catch (err) {
    logger.error('Workflow', 'List error', { message: err.message });
    res.status(500).json({ error: 'Failed to list workflows' });
  }
});

// ─── Notion CRUD (per workflow) ──────────────────────────

app.post('/api/workflow/:id/page', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const page = await createPage(workflow.notion_database_id, req.body.properties);
    logger.info('Page', 'Created', { page_id: page.id, workflow_id: req.params.id });
    res.status(201).json({ page_id: page.id, url: page.url });
  } catch (err) {
    logger.error('Page', 'Create error', { message: err.message, notion: err.response?.data });
    res.status(500).json({ error: err.response?.data?.message || 'Failed to create page' });
  }
});

app.get('/api/workflow/:id/pages', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const pages = await listPages(workflow.notion_database_id);
    res.json(pages);
  } catch (err) {
    logger.error('Page', 'List error', { message: err.message, notion: err.response?.data });
    res.status(500).json({ error: err.response?.data?.message || 'Failed to list pages' });
  }
});

app.patch('/api/workflow/:id/page/:page_id', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const page = await updatePage(req.params.page_id, req.body.properties);
    res.json({ page_id: page.id });
  } catch (err) {
    logger.error('Page', 'Update error', { message: err.message, notion: err.response?.data });
    res.status(500).json({ error: err.response?.data?.message || 'Failed to update page' });
  }
});

app.delete('/api/workflow/:id/page/:page_id', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    await archivePage(req.params.page_id);
    res.json({ archived: true, page_id: req.params.page_id });
  } catch (err) {
    logger.error('Page', 'Archive error', { message: err.message, notion: err.response?.data });
    res.status(500).json({ error: err.response?.data?.message || 'Failed to archive page' });
  }
});

// ─── Create & Trigger (n8n integration) ──────────────────

app.post('/api/workflow/:id/create-and-trigger', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const page = await createPage(workflow.notion_database_id, req.body.properties);
    logger.info('Trigger', 'Page created', { page_id: page.id });

    forwardToN8N(workflow.n8n_webhook_url, {
      event: 'page_created',
      workflow_id: workflow.id,
      page_id: page.id,
      data: req.body
    });

    res.status(201).json({ success: true, page_id: page.id });
  } catch (err) {
    logger.error('Trigger', 'Error', { message: err.message, notion: err.response?.data });
    res.status(500).json({ error: err.response?.data?.message || 'Failed to create and trigger' });
  }
});

// ─── Knowledge Indexing ──────────────────────────────────

app.post('/api/workflow/:id/index-notion-page', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const { notion_page_id } = req.body;
    if (!notion_page_id) return res.status(400).json({ error: 'notion_page_id is required' });

    const result = await indexNotionPage(workflow.id, notion_page_id);
    logger.info('Knowledge', 'Page indexed', { page_id: notion_page_id, chunks: result.chunks, title: result.title });
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    logger.error('Knowledge', 'Index error', { message: err.message });
    res.status(500).json({ error: err.message || 'Failed to index page' });
  }
});

// Sync all pages in the workflow's database into the knowledge base (background)
app.post('/api/workflow/:id/sync-all', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const pages = await listPages(workflow.notion_database_id);
    res.json({ started: true, total: pages.length });

    // Index each page in the background
    ;(async () => {
      let indexed = 0;
      let failed = 0;
      for (const page of pages) {
        try {
          await indexNotionPage(workflow.id, page.id);
          indexed++;
          logger.info('Knowledge', 'Sync-all: page indexed', { page_id: page.id, progress: `${indexed}/${pages.length}` });
        } catch (e) {
          failed++;
          logger.error('Knowledge', 'Sync-all: page failed', { page_id: page.id, error: e.message });
        }
      }
      logger.info('Knowledge', 'Sync-all complete', { workflow_id: workflow.id, indexed, failed, total: pages.length });
    })();
  } catch (err) {
    logger.error('Knowledge', 'Sync-all error', { message: err.message });
    res.status(500).json({ error: err.message || 'Failed to start sync' });
  }
});

app.get('/api/workflow/:id/documents', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const docs = await listDocuments(workflow.id);
    res.json(docs);
  } catch (err) {
    logger.error('Knowledge', 'List error', { message: err.message });
    res.status(500).json({ error: 'Failed to list documents' });
  }
});

app.delete('/api/workflow/:id/document/:doc_id', async (req, res) => {
  try {
    await deleteDocument(req.params.doc_id);
    logger.info('Knowledge', 'Document deleted', { doc_id: req.params.doc_id });
    res.json({ deleted: true });
  } catch (err) {
    logger.error('Knowledge', 'Delete error', { message: err.message });
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// ─── RAG Query ───────────────────────────────────────────

app.post('/api/workflow/:id/query', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const { query, top_k } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });

    const matches = await queryKnowledge(workflow.id, query, top_k || 5);
    res.json({ query, matches });
  } catch (err) {
    logger.error('RAG', 'Query error', { message: err.message });
    res.status(500).json({ error: 'Failed to query knowledge' });
  }
});

app.post('/api/workflow/:id/query-and-trigger', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const { query, top_k } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });

    const matches = await queryKnowledge(workflow.id, query, top_k || 5);

    forwardToN8N(workflow.n8n_webhook_url, {
      event: 'rag_query',
      workflow_id: workflow.id,
      query,
      context_chunks: matches
    });

    res.json({ query, matches, triggered: true });
  } catch (err) {
    logger.error('RAG', 'Query+trigger error', { message: err.message });
    res.status(500).json({ error: 'Failed to query and trigger' });
  }
});

// ─── Notion Webhook Receiver ─────────────────────────────

app.post('/webhooks/notion', async (req, res) => {
  const signature = req.headers['x-notion-signature'];

  if (!verifyNotionSignature(req.rawBody, signature)) {
    logger.warn('Webhook', 'Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  res.status(200).json({ ok: true });

  try {
    const payload = req.body;
    const databaseId = payload?.data?.parent?.database_id
      || payload?.entity?.id
      || null;
    const pageId = payload?.data?.id
      || payload?.entity?.id
      || null;

    if (!databaseId) {
      logger.warn('Webhook', 'No database_id in payload');
      return;
    }

    const workflow = await findWorkflowByDatabaseId(databaseId);
    if (!workflow) {
      logger.warn('Webhook', 'No workflow for database', { database_id: databaseId });
      return;
    }

    await forwardToN8N(workflow.n8n_webhook_url, payload);
    logger.info('Webhook', 'Forwarded to n8n', { workflow_id: workflow.id });

    if (pageId && process.env.OPENAI_API_KEY) {
      indexNotionPage(workflow.id, pageId).catch(err => {
        logger.error('Webhook', 'Auto re-index failed', { page_id: pageId, error: err.message });
      });
    }
  } catch (err) {
    logger.error('Webhook', 'Processing error', { message: err.message });
  }
});

// ─── Logs viewer ─────────────────────────────────────────

app.get('/api/logs', (req, res) => {
  const n = Math.min(parseInt(req.query.n) || 300, 1000);
  const lines = logger.readLines(n);
  res.json({ lines });
});

// ─── Start ───────────────────────────────────────────────

async function start() {
  try {
    await initDB();
    logger.info('DB', 'Tables initialized');
    app.listen(PORT, () => {
      logger.info('Bridge', `API running on port ${PORT}`);
    });
  } catch (err) {
    logger.error('Bridge', 'Startup failed', { message: err.message });
    process.exit(1);
  }
}

start();
