require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { initDB, saveToken } = require('./db');
const { createPage, listPages, updatePage, archivePage } = require('./notionService');
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
    res.json({ connected: true, configured: !!process.env.NOTION_CLIENT_ID });
  } catch {
    res.json({ connected: false, configured: !!process.env.NOTION_CLIENT_ID });
  }
});

app.get('/auth/notion/login', (_req, res) => {
  const clientId = process.env.NOTION_CLIENT_ID;
  const redirectUri = process.env.NOTION_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).json({
      error: 'Notion OAuth not configured',
      fix: 'Set NOTION_CLIENT_ID and NOTION_REDIRECT_URI in your .env file'
    });
  }

  const url = `https://api.notion.com/v1/oauth/authorize?client_id=${clientId}&response_type=code&owner=user&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

app.get('/auth/notion/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing code parameter' });

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

    const { workspace_id, access_token } = response.data;
    await saveToken(workspace_id, access_token);
    console.log(`[Auth] Token saved for workspace: ${workspace_id}`);
    res.redirect('/?connected=true');
  } catch (err) {
    console.error('[Auth] OAuth error:', err.response?.data || err.message);
    res.status(500).json({ error: 'OAuth failed' });
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
    console.log(`[Workflow] Created: ${workflow.id}`);
    res.status(201).json(workflow);
  } catch (err) {
    console.error('[Workflow] Create error:', err.message);
    res.status(500).json({ error: 'Failed to create workflow' });
  }
});

app.get('/api/workflows', async (_req, res) => {
  try {
    const workflows = await listWorkflows();
    res.json(workflows);
  } catch (err) {
    console.error('[Workflow] List error:', err.message);
    res.status(500).json({ error: 'Failed to list workflows' });
  }
});

// ─── Notion CRUD (per workflow) ──────────────────────────

app.post('/api/workflow/:id/page', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const page = await createPage(workflow.notion_database_id, req.body.properties);
    console.log(`[Page] Created: ${page.id}`);
    res.status(201).json({ page_id: page.id, url: page.url });
  } catch (err) {
    console.error('[Page] Create error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create page' });
  }
});

app.get('/api/workflow/:id/pages', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const pages = await listPages(workflow.notion_database_id);
    res.json(pages);
  } catch (err) {
    console.error('[Page] List error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to list pages' });
  }
});

app.patch('/api/workflow/:id/page/:page_id', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const page = await updatePage(req.params.page_id, req.body.properties);
    res.json({ page_id: page.id });
  } catch (err) {
    console.error('[Page] Update error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to update page' });
  }
});

app.delete('/api/workflow/:id/page/:page_id', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    await archivePage(req.params.page_id);
    res.json({ archived: true, page_id: req.params.page_id });
  } catch (err) {
    console.error('[Page] Delete error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to archive page' });
  }
});

// ─── Create & Trigger (n8n integration) ──────────────────

app.post('/api/workflow/:id/create-and-trigger', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const page = await createPage(workflow.notion_database_id, req.body.properties);
    console.log(`[Trigger] Page created: ${page.id}`);

    // Fire-and-forget to n8n
    forwardToN8N(workflow.n8n_webhook_url, {
      event: 'page_created',
      workflow_id: workflow.id,
      page_id: page.id,
      data: req.body
    });

    res.status(201).json({ success: true, page_id: page.id });
  } catch (err) {
    console.error('[Trigger] Error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create and trigger' });
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
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    console.error('[Knowledge] Index error:', err.message);
    res.status(500).json({ error: 'Failed to index page' });
  }
});

app.get('/api/workflow/:id/documents', async (req, res) => {
  try {
    const workflow = await getWorkflowById(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });

    const docs = await listDocuments(workflow.id);
    res.json(docs);
  } catch (err) {
    console.error('[Knowledge] List error:', err.message);
    res.status(500).json({ error: 'Failed to list documents' });
  }
});

app.delete('/api/workflow/:id/document/:doc_id', async (req, res) => {
  try {
    await deleteDocument(req.params.doc_id);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[Knowledge] Delete error:', err.message);
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
    console.error('[RAG] Query error:', err.message);
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

    // Fire-and-forget to n8n
    forwardToN8N(workflow.n8n_webhook_url, {
      event: 'rag_query',
      workflow_id: workflow.id,
      query,
      context_chunks: matches
    });

    res.json({ query, matches, triggered: true });
  } catch (err) {
    console.error('[RAG] Query+trigger error:', err.message);
    res.status(500).json({ error: 'Failed to query and trigger' });
  }
});

// ─── Notion Webhook Receiver ─────────────────────────────

app.post('/webhooks/notion', async (req, res) => {
  const signature = req.headers['x-notion-signature'];

  if (!verifyNotionSignature(req.rawBody, signature)) {
    console.warn('[Webhook] Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Respond immediately
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
      console.log('[Webhook] No database_id in payload');
      return;
    }

    const workflow = await findWorkflowByDatabaseId(databaseId);
    if (!workflow) {
      console.log(`[Webhook] No workflow for database: ${databaseId}`);
      return;
    }

    // Forward to n8n
    await forwardToN8N(workflow.n8n_webhook_url, payload);

    // Auto re-index page if we have a page_id and OpenAI is configured
    if (pageId && process.env.OPENAI_API_KEY) {
      indexNotionPage(workflow.id, pageId).catch(err => {
        console.error(`[Webhook] Auto re-index failed for ${pageId}: ${err.message}`);
      });
    }
  } catch (err) {
    console.error('[Webhook] Processing error:', err.message);
  }
});

// ─── Start ───────────────────────────────────────────────

async function start() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`[Bridge] API running on port ${PORT}`);
    });
  } catch (err) {
    console.error('[Bridge] Startup failed:', err.message);
    process.exit(1);
  }
}

start();
