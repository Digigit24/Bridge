# Notion ↔ n8n Bridge API

Minimal Node.js API that bridges Notion (knowledgebase) and n8n (automation engine). Supports multiple workflows, each mapping a Notion database to an n8n webhook.

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your credentials
node server.js
```

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `DATABASE_URL` | PostgreSQL connection string (Neon) |
| `NOTION_CLIENT_ID` | Notion OAuth app client ID |
| `NOTION_CLIENT_SECRET` | Notion OAuth app client secret |
| `NOTION_REDIRECT_URI` | OAuth callback URL (`http://localhost:3000/auth/notion/callback`) |
| `NOTION_VERSION` | Notion API version (`2022-06-28`) |
| `NOTION_WEBHOOK_SECRET` | Secret for verifying Notion webhook signatures |
| `DEFAULT_N8N_WEBHOOK_URL` | Fallback n8n webhook URL |
| `OPENAI_API_KEY` | OpenAI API key (for embeddings / RAG) |

## Neon Postgres Setup

1. Create a free project at [neon.tech](https://neon.tech)
2. Enable the **pgvector** extension (Neon supports it by default)
3. Copy the connection string from your dashboard
4. Set `DATABASE_URL` in `.env`
5. Tables are created automatically on first startup (including `knowledge_documents` and `knowledge_chunks` with vector columns)

## Notion OAuth Integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **New integration** → select **Public integration**
3. Set redirect URI to `http://localhost:3000/auth/notion/callback`
4. Copy Client ID and Client Secret to `.env`
5. Visit `http://localhost:3000/auth/notion/login` in your browser
6. Authorize the integration → token is stored automatically

## Notion Webhooks

1. In your Notion integration settings, enable webhooks
2. Set the webhook URL to `https://your-domain.com/webhooks/notion`
3. Copy the webhook signing secret to `NOTION_WEBHOOK_SECRET` in `.env`
4. Incoming webhooks are matched to workflows by `database_id` and forwarded to the corresponding n8n webhook

## Connecting n8n

1. In n8n, create a **Webhook** node (trigger)
2. Copy the webhook URL (e.g., `https://your-n8n.com/webhook/abc123`)
3. Use that URL when creating a workflow in the Bridge API

## How Workflows Map Notion → n8n

```
Notion Database ──→ Bridge Workflow ──→ n8n Webhook
     (DB_A)            (workflow_1)       (hook_url_1)
     (DB_B)            (workflow_2)       (hook_url_2)
```

Each workflow links one Notion database to one n8n webhook. When a Notion webhook fires, the Bridge matches `database_id` to the correct workflow and forwards the payload to the mapped n8n webhook.

## API Endpoints

### Auth
- `GET /auth/notion/login` — Start Notion OAuth
- `GET /auth/notion/callback` — OAuth callback (automatic)

### Workflows
- `POST /api/workflows` — Create workflow
- `GET /api/workflows` — List all workflows

### Notion Pages (per workflow)
- `POST /api/workflow/:id/page` — Create page
- `GET /api/workflow/:id/pages` — List pages
- `PATCH /api/workflow/:id/page/:page_id` — Update page
- `DELETE /api/workflow/:id/page/:page_id` — Archive page

### Trigger
- `POST /api/workflow/:id/create-and-trigger` — Create page + notify n8n

### Knowledge (RAG)
- `POST /api/workflow/:id/index-notion-page` — Index a Notion page into the knowledge base
- `GET /api/workflow/:id/documents` — List indexed documents
- `DELETE /api/workflow/:id/document/:doc_id` — Delete a document and its chunks
- `POST /api/workflow/:id/query` — RAG query (vector similarity search)
- `POST /api/workflow/:id/query-and-trigger` — RAG query + forward results to n8n

### Webhook
- `POST /webhooks/notion` — Receive Notion webhooks (also auto re-indexes updated pages)

## Example curl Tests

```bash
# Create a workflow
curl -X POST http://localhost:3000/api/workflows \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Content Pipeline",
    "notion_database_id": "abc123def456",
    "n8n_webhook_url": "https://your-n8n.com/webhook/xyz",
    "permissions": {"can_create": true, "can_delete": false}
  }'

# List workflows
curl http://localhost:3000/api/workflows

# Create a page in a workflow's Notion database
curl -X POST http://localhost:3000/api/workflow/WORKFLOW_ID/page \
  -H "Content-Type: application/json" \
  -d '{
    "properties": {
      "Name": {"title": [{"text": {"content": "My Page"}}]}
    }
  }'

# List pages
curl http://localhost:3000/api/workflow/WORKFLOW_ID/pages

# Update a page
curl -X PATCH http://localhost:3000/api/workflow/WORKFLOW_ID/page/PAGE_ID \
  -H "Content-Type: application/json" \
  -d '{
    "properties": {
      "Name": {"title": [{"text": {"content": "Updated Title"}}]}
    }
  }'

# Archive a page
curl -X DELETE http://localhost:3000/api/workflow/WORKFLOW_ID/page/PAGE_ID

# Create page and trigger n8n
curl -X POST http://localhost:3000/api/workflow/WORKFLOW_ID/create-and-trigger \
  -H "Content-Type: application/json" \
  -d '{
    "properties": {
      "Name": {"title": [{"text": {"content": "Triggered Page"}}]}
    }
  }'
```

## Knowledge Layer (RAG)

### How Knowledge Indexing Works

1. Call `POST /api/workflow/:id/index-notion-page` with a `notion_page_id`
2. The Bridge fetches all blocks from the Notion page via the API
3. Blocks are converted to plain text
4. Text is split into chunks (800 chars, 100 overlap)
5. Each chunk is embedded using OpenAI `text-embedding-3-small` (1536 dimensions)
6. Document + chunks are stored in PostgreSQL with pgvector

The document is upserted (create or update). On re-index, old chunks are deleted and replaced.

### How Notion Auto-Sync Works

When a Notion webhook fires (page updated), the Bridge:
1. Verifies the signature
2. Forwards the payload to the mapped n8n webhook (as before)
3. If `OPENAI_API_KEY` is set, auto re-indexes the updated page in the background

This keeps the knowledge base in sync without manual re-indexing.

### How RAG Query Works

1. Call `POST /api/workflow/:id/query` with `{"query": "...", "top_k": 5}`
2. The query is embedded using the same OpenAI model
3. pgvector performs a nearest-neighbor search (`<->` operator)
4. Top K matching chunks are returned with their source document info

Use `POST /api/workflow/:id/query-and-trigger` to also forward the results to n8n for further processing.

### Adding Future Sources

The knowledge layer is source-agnostic. `knowledge_documents` has a `source_type` field supporting:
- `notion` — Notion pages (built-in)
- `clickup` — ClickUp tasks (future)
- `gdocs` — Google Docs (future)
- `internal` — Custom/manual content (future)

To add a new source, create an ingestion function that calls `indexDocument(workflowId, sourceType, sourceId, title, content, metadata)` from `knowledgeService.js`.

### Example curl — Knowledge + RAG

```bash
# Index a Notion page
curl -X POST http://localhost:3000/api/workflow/WORKFLOW_ID/index-notion-page \
  -H "Content-Type: application/json" \
  -d '{"notion_page_id": "PAGE_ID_HERE"}'

# List indexed documents
curl http://localhost:3000/api/workflow/WORKFLOW_ID/documents

# RAG query
curl -X POST http://localhost:3000/api/workflow/WORKFLOW_ID/query \
  -H "Content-Type: application/json" \
  -d '{"query": "How does the onboarding process work?", "top_k": 5}'

# RAG query + trigger n8n
curl -X POST http://localhost:3000/api/workflow/WORKFLOW_ID/query-and-trigger \
  -H "Content-Type: application/json" \
  -d '{"query": "What are our pricing tiers?", "top_k": 3}'

# Delete an indexed document
curl -X DELETE http://localhost:3000/api/workflow/WORKFLOW_ID/document/DOC_ID
```

## Deploy (Generic VPS)

```bash
# On your server
git clone <your-repo-url> bridge
cd bridge
npm install
cp .env.example .env
# Edit .env with production values

# Run with pm2
npm install -g pm2
pm2 start server.js --name bridge
pm2 save
pm2 startup

# Or run with systemd
# Create /etc/systemd/system/bridge.service, then:
# systemctl enable bridge && systemctl start bridge
```

Set up a reverse proxy (nginx/caddy) to point your domain to port 3000 with HTTPS.
