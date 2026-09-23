// server.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const jsforce = require('jsforce');

const app = express();
const PORT = process.env.PORT || 9001;
const HOST = '0.0.0.0';

app.use(cors());
app.use(express.json());

// Serve static assets relative to this file's directory
app.use(express.static(__dirname));

// Explicit fallback to ensure index.html is served on root request
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Environment Configuration
const {
  SF_LOGIN_URL = 'https://greyorangeorg.my.salesforce.com',
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_QUEUE_NAME = 'Admin Queue',
} = process.env;

// In-Memory Connection & Queue Metadata Cache
let cachedConn = null;
let cachedQueue = null;

/**
 * In-Memory Response Cache (5-Minute TTL)
 * Prevents exhausting daily Salesforce API call limits and eliminates gateway timeouts
 */
const responseCache = {
  store: new Map(),
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  },
  set(key, data, ttlSeconds = 300) {
    this.store.set(key, {
      data,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  },
  delete(key) {
    this.store.delete(key);
  }
};

/**
 * Helper: Establish or reuse an authenticated Salesforce session
 */
async function getSalesforceConnection(forceRefresh = false) {
  if (!SF_CLIENT_ID || !SF_CLIENT_SECRET) {
    throw new Error('Missing SF_CLIENT_ID or SF_CLIENT_SECRET in .env file.');
  }

  if (!forceRefresh && cachedConn && cachedConn.accessToken) {
    return cachedConn;
  }

  const tokenUrl = `${SF_LOGIN_URL.replace(/\/+$/, '')}/services/oauth2/token`;
  console.log(`Authenticating via OAuth 2.0 Client Credentials with: ${tokenUrl}`);

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SF_CLIENT_ID,
    client_secret: SF_CLIENT_SECRET,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  const tokenData = await response.json();
  if (!response.ok) {
    throw new Error(`Salesforce OAuth Error: ${tokenData.error_description || tokenData.error}`);
  }

  console.log('OAuth 2.0 authentication successful.');

  cachedConn = new jsforce.Connection({
    instanceUrl: tokenData.instance_url,
    accessToken: tokenData.access_token,
  });

  return cachedConn;
}

/**
 * Helper: Resolve and cache queue metadata dynamically via Group object
 */
async function getQueueMetadata(conn, targetName) {
  if (cachedQueue && cachedQueue.Name === targetName) {
    return cachedQueue;
  }

  const devName = targetName.replace(/\s+/g, '_');
  const query = `
    SELECT Id, Name, DeveloperName 
    FROM Group 
    WHERE Type = 'Queue' 
    AND (Name = '${targetName}' OR DeveloperName = '${devName}') 
    LIMIT 1
  `;

  const res = await conn.query(query);
  if (!res.records.length) {
    throw new Error(`Queue '${targetName}' not found in Salesforce.`);
  }

  cachedQueue = res.records[0];
  console.log(`[QUEUE RESOLVED] "${cachedQueue.Name}" -> ID: ${cachedQueue.Id}`);
  return cachedQueue;
}

/**
 * GET /api/queue-inflow
 * Fetches tickets that entered or are currently sitting in the queue
 */
app.get('/api/queue-inflow', async (req, res) => {
  const queueName = req.query.queueName || SF_QUEUE_NAME;
  const rangeParam = req.query.range || 'rolling30';
  const forceRefresh = req.query.refresh === 'true';
  const cacheKey = `${queueName}_${rangeParam}`;

  // 1. Serve from in-memory cache if available and not explicitly refreshing
  if (!forceRefresh) {
    const cachedData = responseCache.get(cacheKey);
    if (cachedData) {
      console.log(`[CACHE HIT] Returning cached payload for ${cacheKey}`);
      return res.json({ ...cachedData, cached: true });
    }
  }

  const allowedRanges = {
    thisMonth: 'THIS_MONTH',
    rolling30: 'LAST_N_DAYS:30',
    lastMonth: 'LAST_MONTH',
  };
  const sfDateFilter = allowedRanges[rangeParam] || 'LAST_N_DAYS:30';

  // Inner fetch logic with automatic session retry
  const fetchInflowData = async (isRetry = false) => {
    try {
      const conn = await getSalesforceConnection(isRetry);
      const queue = await getQueueMetadata(conn, queueName);

      console.log(`\n======================================================`);
      console.log(`Fetching Inflow for: "${queue.Name}" (${rangeParam} -> ${sfDateFilter})`);
      console.log(`======================================================`);

      // 1. Fetch tickets currently in the queue
      const currentQueueSoql = `
        SELECT Id, CaseNumber, Subject, Status, Automation_Priority__c, Type, CreatedDate 
        FROM Case 
        WHERE OwnerId = '${queue.Id}' 
        ORDER BY CreatedDate ASC
      `;

      // 2. Fetch ownership history events (strictly Field = 'Owner' to bypass noise)
      const historySoql = `
        SELECT CaseId, Field, OldValue, NewValue, CreatedDate 
        FROM CaseHistory 
        WHERE Field = 'Owner' 
        AND CreatedDate = ${sfDateFilter} 
        ORDER BY CreatedDate DESC
      `;

      const [currentResult, historyRecords] = await Promise.all([
        conn.query(currentQueueSoql),
        (async () => {
          let records = [];
          let res = await conn.query(historySoql);
          records = records.concat(res.records);
          while (!res.done && res.nextRecordsUrl) {
            res = await conn.queryMore(res.nextRecordsUrl);
            records = records.concat(res.records);
          }
          return records;
        })(),
      ]);

      console.log(`[DEBUG] Cases currently waiting in Admin Queue: ${currentResult.records.length}`);
      console.log(`[DEBUG] Total genuine Owner change events in timeframe: ${historyRecords.length}`);

      const caseMap = new Map();
      const caseInflowTimestamps = new Map();

      // Register cases currently inside the queue
      currentResult.records.forEach((c) => {
        caseMap.set(c.Id, {
          Id: c.Id,
          CaseNumber: c.CaseNumber,
          Subject: c.Subject || '(No Subject)',
          Status: c.Status,
          Automation_Priority__c: c.Automation_Priority__c || 'Medium',
          Type: c.Type || 'Incident',
          CreatedDate: c.CreatedDate,
        });
      });

      // Target matching logic
      const qNameLower = queue.Name.toLowerCase().trim();
      const qDevLower = queue.DeveloperName.toLowerCase().trim();
      const q15Id = queue.Id.substring(0, 15).toLowerCase();

      const isTargetQueue = (val) => {
        if (!val) return false;
        const str = String(val).toLowerCase().trim();
        return str === qNameLower || str === qDevLower || str.includes(q15Id);
      };

      const targetCaseIds = new Set();

      historyRecords.forEach((h) => {
        const movedIn = isTargetQueue(h.NewValue);
        const movedOut = isTargetQueue(h.OldValue);

        if (movedIn || movedOut) {
          targetCaseIds.add(h.CaseId);
          if (movedIn && !caseInflowTimestamps.has(h.CaseId)) {
            caseInflowTimestamps.set(h.CaseId, h.CreatedDate);
          }
        }
      });

      console.log(`[DEBUG] Cases identified that passed through "${queue.Name}": ${targetCaseIds.size}`);

      // Query full Case details for tickets that were reassigned or closed
      const missingCaseIds = Array.from(targetCaseIds).filter((id) => !caseMap.has(id));

      if (missingCaseIds.length > 0) {
        console.log(`[DEBUG] Querying details for ${missingCaseIds.length} reassigned/closed cases...`);
        const chunkSize = 200;
        for (let i = 0; i < missingCaseIds.length; i += chunkSize) {
          const chunk = missingCaseIds.slice(i, i + chunkSize);
          const idsFormatted = chunk.map((id) => `'${id}'`).join(',');
          const query = `
            SELECT Id, CaseNumber, Subject, Status, Automation_Priority__c, Type, CreatedDate 
            FROM Case 
            WHERE Id IN (${idsFormatted})
          `;
          const res = await conn.query(query);
          res.records.forEach((c) => {
            caseMap.set(c.Id, {
              Id: c.Id,
              CaseNumber: c.CaseNumber,
              Subject: c.Subject || '(No Subject)',
              Status: c.Status,
              Automation_Priority__c: c.Automation_Priority__c || 'Medium',
              Type: c.Type || 'Incident',
              CreatedDate: caseInflowTimestamps.get(c.Id) || c.CreatedDate,
            });
          });
        }
      }

      const unifiedRecords = Array.from(caseMap.values());
      console.log(`[SUCCESS] Total unified inflow tickets for dashboard: ${unifiedRecords.length}\n`);

      const payload = {
        success: true,
        queueName: queue.Name,
        queueId: queue.Id,
        range: rangeParam,
        totalSize: unifiedRecords.length,
        records: unifiedRecords,
      };

      // Cache successful response for 5 minutes (300 seconds)
      responseCache.set(cacheKey, payload, 300);

      return res.json({ ...payload, cached: false });
    } catch (err) {
      // Auto-retry once if session expired
      if ((err.errorCode === 'INVALID_SESSION_ID' || err.message.includes('Session expired')) && !isRetry) {
        console.warn('Session expired. Invalidating connection and retrying request...');
        cachedConn = null;
        return fetchInflowData(true);
      }
      throw err;
    }
  };

  try {
    await fetchInflowData();
  } catch (err) {
    console.error('Error handling /api/queue-inflow:', err.message);
    if (err.errorCode === 'INVALID_SESSION_ID') cachedConn = null;
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/health
 * Simple status and Salesforce connectivity check
 */
app.get('/api/health', async (req, res) => {
  try {
    const conn = await getSalesforceConnection();
    const identity = await conn.identity();
    res.json({
      status: 'ok',
      salesforce: 'connected',
      userId: identity.user_id,
      orgId: identity.organization_id,
      timestamp: new Date(),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`=========================================`);
  console.log(`Server listening on all interfaces at port ${PORT}`);
  console.log(`Local VM access:  http://localhost:${PORT}`);
  console.log(`Remote access:    http://172.35.0.13:${PORT}`);
  console.log(`Health endpoint:  http://172.35.0.13:${PORT}/api/health`);
  console.log(`=========================================`);
});