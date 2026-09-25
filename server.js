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

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const {
  SF_LOGIN_URL = 'https://greyorangeorg.my.salesforce.com',
  SF_CLIENT_ID,
  SF_CLIENT_SECRET,
  SF_QUEUE_NAME = 'Admin Queue',
} = process.env;

let cachedConn = null;
let cachedQueue = null;

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
  },
};

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

async function getQueueMembers(conn, queueId) {
  try {
    const memberQuery = `
      SELECT UserOrGroupId 
      FROM GroupMember 
      WHERE GroupId = '${queueId}'
    `;
    const memberRes = await conn.query(memberQuery);
    const userIds = memberRes.records
      .map((r) => r.UserOrGroupId)
      .filter((id) => id && id.startsWith('005'));

    if (userIds.length === 0) return [];

    const userQuery = `
      SELECT Id, Name 
      FROM User 
      WHERE Id IN (${userIds.map((id) => `'${id}'`).join(',')})
      AND IsActive = true
    `;
    const userRes = await conn.query(userQuery);
    return userRes.records.map((u) => u.Name);
  } catch (err) {
    console.warn(`[WARNING] Could not fetch GroupMember: ${err.message}`);
    return [];
  }
}

function normalizeType(rawType) {
  if (!rawType) return 'Incident';
  const t = String(rawType).toLowerCase().trim();
  if (t.includes('service') || t.includes('request') || t === 'sr') return 'Service Request';
  if (t.includes('query') || t.includes('question') || t.includes('inquiry')) return 'Query';
  if (t.includes('feature') || t.includes('enhancement') || t.includes('cr')) return 'Feature Request';
  if (t.includes('incident') || t.includes('issue') || t.includes('bug')) return 'Incident';
  return rawType;
}

function generateMonthlyWeekBuckets(year, monthIndex) {
  const monthNames = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const lastDayOfMonth = new Date(year, monthIndex + 1, 0).getDate();
  const buckets = [];

  let currentStartDay = 1;
  let weekIndex = 1;

  while (currentStartDay <= lastDayOfMonth) {
    const startDate = new Date(year, monthIndex, currentStartDay);
    const dayOfWeek = startDate.getDay();

    const daysToSunday = (7 - dayOfWeek) % 7;
    const currentEndDay = Math.min(currentStartDay + daysToSunday, lastDayOfMonth);

    const label = `${monthNames[monthIndex]} ${String(currentStartDay).padStart(2, '0')} - ${monthNames[monthIndex]} ${String(currentEndDay).padStart(2, '0')}`;

    buckets.push({
      week: `Week ${weekIndex}`,
      label,
      startDay: currentStartDay,
      endDay: currentEndDay,
      totalInflow: 0,
      typeBreakdown: { Incident: 0, 'Service Request': 0, Query: 0, 'Feature Request': 0 },
      agentBreakdown: {},
    });

    currentStartDay = currentEndDay + 1;
    weekIndex++;
  }

  return buckets;
}

function bifurcateRecordsByWeek(records, year, monthIndex) {
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const weeks = generateMonthlyWeekBuckets(year, monthIndex);
  let monthTotal = 0;

  records.forEach((c) => {
    const d = new Date(c.CreatedDate);
    const day = d.getDate();

    const targetWeek = weeks.find((w) => day >= w.startDay && day <= w.endDay);
    if (targetWeek) {
      targetWeek.totalInflow++;
      monthTotal++;

      const type = normalizeType(c.Type);
      targetWeek.typeBreakdown[type] = (targetWeek.typeBreakdown[type] || 0) + 1;

      const agent = c.agent || 'Unassigned';
      if (agent !== 'Unassigned') {
        if (!targetWeek.agentBreakdown[agent]) {
          targetWeek.agentBreakdown[agent] = {
            Incident: 0,
            'Service Request': 0,
            Query: 0,
            'Feature Request': 0,
            total: 0,
          };
        }
        targetWeek.agentBreakdown[agent][type] = (targetWeek.agentBreakdown[agent][type] || 0) + 1;
        targetWeek.agentBreakdown[agent].total += 1;
      }
    }
  });

  const cleanedWeeks = weeks.map(({ startDay, endDay, ...rest }) => rest);

  return {
    month: `${monthNames[monthIndex]} ${year}`,
    totalInflow: monthTotal,
    weeks: cleanedWeeks,
  };
}

/**
 * GET /api/queue-inflow
 */
app.get('/api/queue-inflow', async (req, res) => {
  const queueName = req.query.queueName || SF_QUEUE_NAME;
  const rangeParam = req.query.range || 'thisMonth';
  const forceRefresh = req.query.refresh === 'true';
  const cacheKey = `${queueName}_${rangeParam}`;

  if (!forceRefresh) {
    const cachedData = responseCache.get(cacheKey);
    if (cachedData) {
      return res.json({ ...cachedData, cached: true });
    }
  }

  const fetchInflowData = async (isRetry = false) => {
    try {
      const conn = await getSalesforceConnection(isRetry);
      const queue = await getQueueMetadata(conn, queueName);

      console.log(`\n======================================================`);
      console.log(`Fetching Inflow (${rangeParam}) for: "${queue.Name}"`);
      console.log(`======================================================`);

      const directQueueMembers = await getQueueMembers(conn, queue.Id);

      const currentQueueSoql = `
        SELECT Id, CaseNumber, Subject, Status, Automation_Priority__c, Type, CreatedDate, OwnerId, Owner.Name 
        FROM Case 
        WHERE OwnerId = '${queue.Id}' 
        ORDER BY CreatedDate ASC
      `;

      const historySoql = `
        SELECT CaseId, Field, OldValue, NewValue, CreatedDate 
        FROM CaseHistory 
        WHERE Field = 'Owner' 
        AND (CreatedDate = THIS_MONTH OR CreatedDate = LAST_MONTH) 
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

      const caseMap = new Map();
      const caseInflowTimestamps = new Map();
      const caseAgentMap = new Map();
      const detectedHistoricalAgents = new Set(directQueueMembers);

      currentResult.records.forEach((c) => {
        caseMap.set(c.Id, {
          Id: c.Id,
          CaseNumber: c.CaseNumber,
          Subject: c.Subject || '(No Subject)',
          agent: 'Unassigned',
          Status: c.Status,
          Automation_Priority__c: c.Automation_Priority__c || 'Medium',
          Type: normalizeType(c.Type),
          CreatedDate: c.CreatedDate,
        });
      });

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
          if (movedOut && !isTargetQueue(h.NewValue) && h.NewValue && h.NewValue !== 'Automated Process') {
            caseAgentMap.set(h.CaseId, h.NewValue);
            detectedHistoricalAgents.add(h.NewValue);
          }
        }
      });

      const missingCaseIds = Array.from(targetCaseIds).filter((id) => !caseMap.has(id));

      if (missingCaseIds.length > 0) {
        const chunkSize = 200;
        for (let i = 0; i < missingCaseIds.length; i += chunkSize) {
          const chunk = missingCaseIds.slice(i, i + chunkSize);
          const idsFormatted = chunk.map((id) => `'${id}'`).join(',');
          const query = `
            SELECT Id, CaseNumber, Subject, Status, Automation_Priority__c, Type, CreatedDate, OwnerId, Owner.Name 
            FROM Case 
            WHERE Id IN (${idsFormatted})
          `;
          const res = await conn.query(query);
          res.records.forEach((c) => {
            const ownerName = c.Owner && c.Owner.Name ? c.Owner.Name : null;
            const agentName =
              ownerName && !isTargetQueue(ownerName) && ownerName !== 'Automated Process'
                ? ownerName
                : caseAgentMap.get(c.Id) || 'Unassigned';

            if (agentName !== 'Unassigned') detectedHistoricalAgents.add(agentName);

            caseMap.set(c.Id, {
              Id: c.Id,
              CaseNumber: c.CaseNumber,
              Subject: c.Subject || '(No Subject)',
              agent: agentName,
              Status: c.Status,
              Automation_Priority__c: c.Automation_Priority__c || 'Medium',
              Type: normalizeType(c.Type),
              CreatedDate: caseInflowTimestamps.get(c.Id) || c.CreatedDate,
            });
          });
        }
      }

      const unifiedRecords = Array.from(caseMap.values());
      const resolvedQueueAgents = Array.from(detectedHistoricalAgents).filter(
        (name) => name && !isTargetQueue(name) && name !== 'Automated Process' && name !== 'System'
      );

      // Monthly partitioning for weekly bifurcation
      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonth = now.getMonth();

      const lastMonthDate = new Date(currentYear, currentMonth - 1, 1);
      const lastYear = lastMonthDate.getFullYear();
      const lastMonth = lastMonthDate.getMonth();

      const thisMonthRecords = [];
      const lastMonthRecords = [];

      unifiedRecords.forEach((c) => {
        const d = new Date(c.CreatedDate);
        const y = d.getFullYear();
        const m = d.getMonth();

        if (y === currentYear && m === currentMonth) {
          thisMonthRecords.push(c);
        } else if (y === lastYear && m === lastMonth) {
          lastMonthRecords.push(c);
        }
      });

      const currentMonthBifurcation = bifurcateRecordsByWeek(thisMonthRecords, currentYear, currentMonth);
      const lastMonthBifurcation = bifurcateRecordsByWeek(lastMonthRecords, lastYear, lastMonth);

      // Precise Timeframe Filter for requested rangeParam
      let displayRecords = unifiedRecords;

      if (rangeParam === 'thisMonth') {
        displayRecords = thisMonthRecords;
      } else if (rangeParam === 'lastMonth') {
        displayRecords = lastMonthRecords;
      } else if (rangeParam === 'bothMonths') {
        displayRecords = unifiedRecords;
      } else if (rangeParam === 'rolling30') {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(now.getDate() - 30);
        displayRecords = unifiedRecords.filter((c) => new Date(c.CreatedDate) >= thirtyDaysAgo);
      } else if (rangeParam === 'pastWeek1') {
        const dStart = new Date(); dStart.setDate(now.getDate() - 7);
        displayRecords = unifiedRecords.filter((c) => new Date(c.CreatedDate) >= dStart);
      } else if (rangeParam === 'pastWeek2') {
        const dEnd = new Date(); dEnd.setDate(now.getDate() - 7);
        const dStart = new Date(); dStart.setDate(now.getDate() - 14);
        displayRecords = unifiedRecords.filter((c) => {
          const cd = new Date(c.CreatedDate);
          return cd >= dStart && cd < dEnd;
        });
      } else if (rangeParam === 'pastWeek3') {
        const dEnd = new Date(); dEnd.setDate(now.getDate() - 14);
        const dStart = new Date(); dStart.setDate(now.getDate() - 21);
        displayRecords = unifiedRecords.filter((c) => {
          const cd = new Date(c.CreatedDate);
          return cd >= dStart && cd < dEnd;
        });
      } else if (rangeParam === 'pastWeek4') {
        const dEnd = new Date(); dEnd.setDate(now.getDate() - 21);
        const dStart = new Date(); dStart.setDate(now.getDate() - 28);
        displayRecords = unifiedRecords.filter((c) => {
          const cd = new Date(c.CreatedDate);
          return cd >= dStart && cd < dEnd;
        });
      }

      const payload = {
        success: true,
        queueName: queue.Name,
        queueId: queue.Id,
        range: rangeParam,
        queueAgents: resolvedQueueAgents,
        totalSize: displayRecords.length,
        records: displayRecords,
        weeklyBifurcation: {
          currentMonth: currentMonthBifurcation,
          lastMonth: lastMonthBifurcation,
          allWeeks: [
            ...lastMonthBifurcation.weeks.map((w) => ({ ...w, month: lastMonthBifurcation.month })),
            ...currentMonthBifurcation.weeks.map((w) => ({ ...w, month: currentMonthBifurcation.month })),
          ],
        },
      };

      responseCache.set(cacheKey, payload, 300);
      return res.json({ ...payload, cached: false });
    } catch (err) {
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
  console.log(`=========================================`);
});