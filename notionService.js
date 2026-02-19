const axios = require('axios');
const { getLatestToken } = require('./db');

const NOTION_API = 'https://api.notion.com/v1';

async function notionHeaders() {
  const token = await getLatestToken();
  return {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': process.env.NOTION_VERSION,
    'Content-Type': 'application/json'
  };
}

async function createPage(databaseId, properties) {
  const headers = await notionHeaders();
  const res = await axios.post(`${NOTION_API}/pages`, {
    parent: { database_id: databaseId },
    properties
  }, { headers });
  return res.data;
}

async function listPages(databaseId) {
  const headers = await notionHeaders();
  const res = await axios.post(`${NOTION_API}/databases/${databaseId}/query`, {}, { headers });
  return res.data.results;
}

async function updatePage(pageId, properties) {
  const headers = await notionHeaders();
  const res = await axios.patch(`${NOTION_API}/pages/${pageId}`, {
    properties
  }, { headers });
  return res.data;
}

async function archivePage(pageId) {
  const headers = await notionHeaders();
  const res = await axios.patch(`${NOTION_API}/pages/${pageId}`, {
    archived: true
  }, { headers });
  return res.data;
}

module.exports = { createPage, listPages, updatePage, archivePage };
