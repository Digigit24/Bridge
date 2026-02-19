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

## Neon Postgres Setup

1. Create a free project at [neon.tech](https://neon.tech)
2. Copy the connection string from your dashboard
3. Set `DATABASE_URL` in `.env`
4. Tables are created automatically on first startup

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

### Webhook
- `POST /webhooks/notion` — Receive Notion webhooks

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
