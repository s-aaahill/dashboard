/**
 * Salesforce Single-Queue Inflow Dashboard Controller
 */

const state = {
  queueName: "Admin Queue",
  timeRange: "thisMonth",
  selectedTab: "ALL",
  selectedWeek: "CURRENT_WEEK",
  selectedStatusFilter: "ACTIVE", // Default view remains Active (New / Assigned)
  queueAgents: [],
  weeklyBifurcation: null,
  cases: [],
  filteredCases: [],
  charts: {},
  showMovingAverage: true,
  isLiveApiConnected: false,
  loadController: null,
  weekSyncedRange: null
};

const SF_COLORS = {
  blue: "#0176D3",
  navy: "#032D60",
  orange: "#FE9339",
  green: "#2E844A",
  red: "#EA001E",
  purple: "#7F27CE",
  teal: "#0B827C",
  gridLines: "#EAEAEA"
};

// Vibrant, high-contrast palette for Case Statuses
const VIBRANT_STATUS_PALETTE = {
  New: "#00B4D8",           // Electric Sky Blue
  Assigned: "#FF7700",      // Vibrant Amber / Electric Orange
  "In Progress": "#8B5CF6", // Neon Violet / Purple
  Closed: "#10B981",        // Bright Mint / Emerald Green
  Resolved: "#06B6D4",      // Vivid Cyan
  Escalated: "#F43F5E",     // Hot Crimson / Rose Red
  Pending: "#FBBF24",       // Bright Golden Yellow
  "On Hold": "#EC4899",     // Neon Fuchsia / Pink
  Unknown: "#64748B"        // Slate Gray fallback
};

const FALLBACK_VIBRANT_COLORS = [
  "#00B4D8", "#FF7700", "#10B981", "#8B5CF6", 
  "#F43F5E", "#FBBF24", "#EC4899", "#06B6D4", 
  "#3B82F6", "#14B8A6", "#A855F7", "#FB923C"
];

document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  updateDateRangeLabel();
  await loadDashboardData();
});

function updateDateRangeLabel() {
  const labelElem = document.getElementById("dateRangeText");
  if (!labelElem) return;
  const now = new Date();
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  if (state.timeRange === "thisMonth") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    labelElem.textContent = `Window: ${fmt(start)} — ${fmt(now)} (Month-to-Date)`;
  } else if (state.timeRange === "lastMonth") {
    const firstDayPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastDayPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    const monthName = firstDayPrevMonth.toLocaleDateString("en-US", { month: "short" });
    labelElem.textContent = `Window: ${monthName} 01 — ${monthName} ${lastDayPrevMonth.getDate()}, ${firstDayPrevMonth.getFullYear()}`;
  } else if (state.timeRange === "bothMonths") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    labelElem.textContent = `Window: ${fmt(start)} — ${fmt(now)} (2-Month Window)`;
  } else if (state.timeRange === "rolling30") {
    const past30 = new Date();
    past30.setDate(now.getDate() - 30);
    labelElem.textContent = `Window: ${fmt(past30)} — ${fmt(now)}`;
  } else if (state.timeRange.startsWith("pastWeek")) {
    const weekNum = parseInt(state.timeRange.replace("pastWeek", ""), 10);
    const endDaysAgo = (weekNum - 1) * 7;
    const startDaysAgo = weekNum * 7;
    const end = new Date(); end.setDate(now.getDate() - endDaysAgo);
    const start = new Date(); start.setDate(now.getDate() - startDaysAgo);
    labelElem.textContent = `Window: ${fmt(start)} — ${fmt(end)} (Week ${weekNum})`;
  }
}

function setLoading(isLoading) {
  document.body.classList.toggle("is-loading", isLoading);
  const refreshBtn = document.getElementById("refreshDataBtn");
  if (refreshBtn) refreshBtn.disabled = isLoading;
}

async function loadDashboardData() {
  updateDateRangeLabel();

  // Cancel any in-flight request so rapid timeframe changes don't queue up or overwrite newer data
  if (state.loadController) state.loadController.abort();
  const controller = new AbortController();
  state.loadController = controller;
  setLoading(true);

  try {
    const url = `/api/queue-inflow?queueName=${encodeURIComponent(state.queueName)}&range=${state.timeRange}`;
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    if (data.records && Array.isArray(data.records)) {
      state.weeklyBifurcation = data.weeklyBifurcation || null;
      state.queueAgents = Array.isArray(data.queueAgents) ? data.queueAgents : [];
      populateWeekSelectOptions();
      mapIncomingRecords(data.records);
      populateStatusFilterOptions();
      state.isLiveApiConnected = true;
      return;
    }
    throw new Error("Invalid response payload structure");
  } catch (err) {
    if (err.name === "AbortError") return; // superseded by a newer request
    console.warn("Could not retrieve live Salesforce data:", err.message);
    state.isLiveApiConnected = false;
  } finally {
    if (state.loadController === controller) {
      state.loadController = null;
      setLoading(false);
    }
  }
}

function normalizeType(rawType, subject = '') {
  const t = String(rawType || '').toLowerCase().trim();
  const s = String(subject || '').toLowerCase().trim();

  if (
    t.includes('feature') ||
    t.includes('enhancement') ||
    t.includes('change request') ||
    t.includes('improvement') ||
    t === 'cr' ||
    t === 'fr' ||
    t === 'rfc' ||
    s.startsWith('[fr]') ||
    s.startsWith('fr:') ||
    s.startsWith('[feature]') ||
    s.startsWith('feature:') ||
    s.includes('feature request')
  ) {
    return 'Feature Request';
  }

  if (t.includes('service') || t.includes('request') || t === 'sr') {
    return 'Service Request';
  }

  if (t.includes('query') || t.includes('question') || t.includes('inquiry')) {
    return 'Query';
  }

  if (t.includes('incident') || t.includes('issue') || t.includes('bug')) {
    return 'Incident';
  }

  return rawType || 'Incident';
}

function mapIncomingRecords(raw) {
  state.cases = raw.map((r, i) => {
    const rawDate = r.CreatedDate || new Date().toISOString();
    const dateObj = new Date(rawDate);

    return {
      id: r.Id || `rec-${i}`,
      caseNumber: r.CaseNumber || `00${100000 + i}`,
      subject: r.Subject || "(No Subject)",
      agent: r.agent && r.agent !== "Unassigned" && r.agent !== "Admin Queue" ? r.agent : "Unassigned",
      type: normalizeType(r.Type || r.Ticket_Type__c || r.RecordType?.Name, r.Subject),
      priority: r.Automation_Priority__c || r.Priority || "Medium",
      origin: r.Origin || "Portal",
      routedDate: dateObj,
      dateKey: dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      weekLabel: r.weekLabel || "",
      hourOfDay: dateObj.getHours(),
      status: r.Status || "New"
    };
  });

  updateTabBadges();
  applyFilters();
}

function updateTabBadges() {
  const counts = { ALL: state.cases.length, Incident: 0, "Service Request": 0, Query: 0, "Feature Request": 0 };
  state.cases.forEach((c) => {
    if (counts[c.type] !== undefined) counts[c.type]++;
  });

  const setBadge = (id, count) => {
    const elem = document.getElementById(id);
    if (elem) elem.textContent = count.toLocaleString();
  };

  setBadge("badgeAll", counts.ALL);
  setBadge("badgeIncident", counts.Incident);
  setBadge("badgeSR", counts["Service Request"]);
  setBadge("badgeQuery", counts.Query);
  setBadge("badgeFR", counts["Feature Request"]);
}

// Returns the [start, end] day window (local time) covered by the selected timeframe
function getTimeWindow() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = (n) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);

  switch (state.timeRange) {
    case "thisMonth":
      return [new Date(now.getFullYear(), now.getMonth(), 1), today];
    case "lastMonth":
      return [new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth(), 0)];
    case "bothMonths":
      return [new Date(now.getFullYear(), now.getMonth() - 1, 1), today];
    case "rolling30":
      return [daysAgo(30), today];
    default: {
      const weekNum = parseInt(state.timeRange.replace("pastWeek", ""), 10) || 1;
      return [daysAgo(weekNum * 7), daysAgo((weekNum - 1) * 7)];
    }
  }
}

function parseLocalDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function populateWeekSelectOptions() {
  const select = document.getElementById("agentWeekSelect");
  if (!select) return;

  const rangeChanged = state.weekSyncedRange !== state.timeRange;
  state.weekSyncedRange = state.timeRange;
  const [winStart, winEnd] = getTimeWindow();

  select.innerHTML = "";
  const addOption = (parent, value, text) => {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    parent.appendChild(opt);
  };

  const allowed = new Set(["ALL_WEEKS"]);
  if (state.timeRange === "thisMonth" || state.timeRange === "rolling30" || state.timeRange === "pastWeek1") {
    addOption(select, "CURRENT_WEEK", state.timeRange === "thisMonth" ? "Current Week" : "Last 7 Days");
    allowed.add("CURRENT_WEEK");
  }
  addOption(select, "ALL_WEEKS", "All Weeks (Combined)");

  // Only list calendar weeks that overlap the selected timeframe
  const weeks = ((state.weeklyBifurcation && state.weeklyBifurcation.allWeeks) || []).filter(
    (w) => !w.startDate || (parseLocalDate(w.endDate) >= winStart && parseLocalDate(w.startDate) <= winEnd)
  );
  if (weeks.length) {
    const optGroup = document.createElement("optgroup");
    optGroup.label = "Weeks in Selected Timeframe";
    weeks.forEach((w) => {
      addOption(optGroup, w.label, `${w.month} - ${w.label} (${w.week})`);
      allowed.add(w.label);
    });
    select.appendChild(optGroup);
  }

  // On a timeframe change, reset to the natural default; otherwise keep the user's pick if still valid
  const preferred = rangeChanged
    ? (state.timeRange === "thisMonth" ? "CURRENT_WEEK" : "ALL_WEEKS")
    : state.selectedWeek;
  select.value = allowed.has(preferred) ? preferred : "ALL_WEEKS";
  state.selectedWeek = select.value;
}

function populateStatusFilterOptions() {
  const select = document.getElementById("statusFilter");
  if (!select) return;

  const currentVal = state.selectedStatusFilter || "ACTIVE";
  const uniqueStatuses = new Set();
  state.cases.forEach((c) => {
    if (c.status) uniqueStatuses.add(c.status);
  });

  select.innerHTML = `
    <option value="ACTIVE">Status: Active (New / Assigned)</option>
    <option value="ALL">Status: All (View All Cases)</option>
  `;

  if (uniqueStatuses.size > 0) {
    const optGroup = document.createElement("optgroup");
    optGroup.label = "Individual Statuses";
    Array.from(uniqueStatuses).sort().forEach((st) => {
      const opt = document.createElement("option");
      opt.value = st;
      opt.textContent = `Status: ${st}`;
      optGroup.appendChild(opt);
    });
    select.appendChild(optGroup);
  }

  select.value = currentVal;
}

function renderDashboard() {
  updateKPICards();
  renderDailyInflowChart();
  renderStatusChart();
  renderHourlyCurveChart();
  renderAgentWorkloadTable();
  renderTable();
}

function updateKPICards() {
  const total = state.filteredCases.length;
  const totalElem = document.getElementById("kpiTotalInflow");
  if (totalElem) totalElem.textContent = total.toLocaleString();

  const now = new Date();
  let startDate = new Date();
  let endDate = new Date();

  if (state.timeRange === "thisMonth") {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (state.timeRange === "lastMonth") {
    startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), 0);
  } else if (state.timeRange === "bothMonths") {
    startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (state.timeRange === "rolling30") {
    startDate.setDate(now.getDate() - 29);
  } else if (state.timeRange.startsWith("pastWeek")) {
    const weekNum = parseInt(state.timeRange.replace("pastWeek", ""), 10);
    endDate.setDate(now.getDate() - (weekNum - 1) * 7);
    startDate.setDate(now.getDate() - weekNum * 7);
  }

  let businessDaysCount = 0;
  let cur = new Date(startDate);
  cur.setHours(0, 0, 0, 0);
  const endCheck = new Date(endDate);
  endCheck.setHours(23, 59, 59, 999);

  while (cur <= endCheck) {
    const dayOfWeek = cur.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) businessDaysCount++;
    cur.setDate(cur.getDate() + 1);
  }
  businessDaysCount = Math.max(1, businessDaysCount);

  const weekdayCases = state.filteredCases.filter((c) => {
    const d = c.routedDate.getDay();
    return d !== 0 && d !== 6;
  });

  const dailyAvg = (weekdayCases.length / businessDaysCount).toFixed(1);
  const avgElem = document.getElementById("kpiDailyAvg");
  if (avgElem) avgElem.textContent = dailyAvg;

  const avgSplitElem = document.getElementById("kpiAvgSplit");
  if (avgSplitElem) {
    avgSplitElem.textContent = `${weekdayCases.length} weekday cases / ${businessDaysCount} workdays`;
  }

  const dayMap = {};
  state.filteredCases.forEach((c) => {
    dayMap[c.dateKey] = (dayMap[c.dateKey] || 0) + 1;
  });

  let peakDay = "--";
  let peakCount = 0;
  for (const [day, count] of Object.entries(dayMap)) {
    if (count > peakCount) {
      peakCount = count;
      peakDay = day;
    }
  }

  const peakDayElem = document.getElementById("kpiPeakDay");
  if (peakDayElem) peakDayElem.textContent = peakDay;

  const peakCountElem = document.getElementById("kpiPeakCount");
  if (peakCountElem) peakCountElem.textContent = `${peakCount} tickets peak velocity`;

  const nowMs = Date.now();
  const agingCases = state.filteredCases.filter((c) => {
    const s = (c.status || "").toLowerCase();
    const isNewOrAssigned = s === "new" || s === "assigned";
    const ageMs = nowMs - c.routedDate.getTime();
    return isNewOrAssigned && ageMs > 24 * 60 * 60 * 1000;
  });

  const agingElem = document.getElementById("kpiAgingCases");
  if (agingElem) agingElem.textContent = agingCases.length.toLocaleString();

  const agingSub = document.getElementById("kpiAgingSubtext");
  if (agingSub) {
    agingSub.textContent = `${agingCases.length} open cases breaching 24h SLA`;
  }
}

function renderDailyInflowChart() {
  const canvas = document.getElementById("dailyInflowChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (state.charts.daily) state.charts.daily.destroy();

  const dateKeys = [];
  const now = new Date();

  if (state.timeRange === "thisMonth") {
    const todayDate = now.getDate();
    for (let day = 1; day <= todayDate; day++) {
      const d = new Date(now.getFullYear(), now.getMonth(), day);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
  } else if (state.timeRange === "lastMonth") {
    const totalDays = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    for (let day = 1; day <= totalDays; day++) {
      const d = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), day);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
  } else if (state.timeRange === "bothMonths") {
    const totalDaysPrev = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    for (let day = 1; day <= totalDaysPrev; day++) {
      const d = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), day);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
    const todayDate = now.getDate();
    for (let day = 1; day <= todayDate; day++) {
      const d = new Date(now.getFullYear(), now.getMonth(), day);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
  } else if (state.timeRange === "rolling30") {
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(now.getDate() - i);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
  } else if (state.timeRange.startsWith("pastWeek")) {
    const weekNum = parseInt(state.timeRange.replace("pastWeek", ""), 10);
    const startOffset = weekNum * 7 - 1;
    const endOffset = (weekNum - 1) * 7;
    for (let i = startOffset; i >= endOffset; i--) {
      const d = new Date();
      d.setDate(now.getDate() - i);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
  }

  const countsMap = {};
  dateKeys.forEach((k) => (countsMap[k] = 0));
  state.filteredCases.forEach((c) => {
    if (countsMap[c.dateKey] !== undefined) countsMap[c.dateKey]++;
  });

  const dataCounts = dateKeys.map((k) => countsMap[k]);

  const movingAvg = [];
  for (let i = 0; i < dataCounts.length; i++) {
    const start = Math.max(0, i - 6);
    const windowVals = dataCounts.slice(start, i + 1);
    movingAvg.push(Math.round(windowVals.reduce((a, b) => a + b, 0) / windowVals.length));
  }

  const datasets = [
    {
      type: "bar",
      label: "Inflow Tickets",
      data: dataCounts,
      backgroundColor: SF_COLORS.blue,
      borderRadius: 4
    }
  ];

  if (state.showMovingAverage) {
    datasets.push({
      type: "line",
      label: "7-Day Moving Avg",
      data: movingAvg,
      borderColor: SF_COLORS.orange,
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      tension: 0.3
    });
  }

  state.charts.daily = new Chart(ctx, {
    data: { labels: dateKeys, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: SF_COLORS.gridLines }, beginAtZero: true }
      }
    }
  });
}

/**
 * High-Contrast Vibrant Status Donut Chart with Bi-Directional Filter Sync
 */
function renderStatusChart() {
  const canvas = document.getElementById("statusChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (state.charts.status) state.charts.status.destroy();

  const statusCounts = {};
  state.filteredCases.forEach((c) => {
    const s = c.status || "Unknown";
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });

  const labels = Object.keys(statusCounts);
  const data = Object.values(statusCounts);

  const bgColors = labels.map((status, idx) => {
    return VIBRANT_STATUS_PALETTE[status] || FALLBACK_VIBRANT_COLORS[idx % FALLBACK_VIBRANT_COLORS.length];
  });

  state.charts.status = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: labels,
      datasets: [
        {
          data: data,
          backgroundColor: bgColors,
          borderWidth: labels.map((l) => (l === state.selectedStatusFilter ? 4 : 2)),
          borderColor: labels.map((l) => (l === state.selectedStatusFilter ? "#1E293B" : "#FFFFFF")),
          hoverOffset: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "68%",
      onHover: (event, chartElement) => {
        event.native.target.style.cursor = chartElement.length ? "pointer" : "default";
      },
      onClick: (event, elements) => {
        if (elements && elements.length > 0) {
          const index = elements[0].index;
          const clickedStatus = labels[index];
          
          // Toggle between clicked status and default ACTIVE view
          state.selectedStatusFilter = state.selectedStatusFilter === clickedStatus ? "ACTIVE" : clickedStatus;
          
          // Synchronize dropdown element
          const statusDropdown = document.getElementById("statusFilter");
          if (statusDropdown) statusDropdown.value = state.selectedStatusFilter;

          renderTable();
          renderStatusChart();
        }
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            boxWidth: 12,
            boxHeight: 12,
            usePointStyle: true,
            pointStyle: "circle",
            padding: 12,
            font: { weight: "600", size: 12 }
          }
        },
        tooltip: {
          backgroundColor: "#1E293B",
          padding: 10,
          titleFont: { weight: "700" },
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${ctx.raw} cases (${((ctx.raw / (data.reduce((a, b) => a + b, 0) || 1)) * 100).toFixed(1)}%)`
          }
        }
      }
    }
  });
}

function renderHourlyCurveChart() {
  const canvas = document.getElementById("hourlyChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (state.charts.hourly) state.charts.hourly.destroy();

  const hourlyCounts = new Array(24).fill(0);
  state.filteredCases.forEach((c) => {
    if (c.hourOfDay >= 0 && c.hourOfDay < 24) hourlyCounts[c.hourOfDay]++;
  });

  state.charts.hourly = new Chart(ctx, {
    type: "line",
    data: {
      labels: Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`),
      datasets: [
        {
          label: "Tickets Routed",
          data: hourlyCounts,
          borderColor: SF_COLORS.green,
          backgroundColor: "rgba(46, 132, 74, 0.1)",
          fill: true,
          tension: 0.4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: SF_COLORS.gridLines }, beginAtZero: true }
      }
    }
  });
}

function renderAgentWorkloadTable() {
  const tbody = document.getElementById("agentWorkloadTableBody");
  const tfoot = document.getElementById("agentWorkloadTableFoot");
  if (!tbody || !tfoot) return;

  tbody.innerHTML = "";
  tfoot.innerHTML = "";

  const now = new Date();

  const weekCases = state.filteredCases.filter((c) => {
    if (c.agent === "Unassigned") return false;

    if (state.selectedWeek === "CURRENT_WEEK") {
      const diffDays = (now - c.routedDate) / (1000 * 60 * 60 * 24);
      return diffDays <= 7;
    } else if (state.selectedWeek === "ALL_WEEKS") {
      return true;
    } else {
      return c.weekLabel === state.selectedWeek;
    }
  });

  // Only current queue members are listed
  const agentList = state.queueAgents || [];

  const types = ["Incident", "Service Request", "Query", "Feature Request"];
  const colTotals = { Incident: 0, "Service Request": 0, Query: 0, "Feature Request": 0, Total: 0 };

  if (agentList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #888; padding: 15px;">No queue members found.</td></tr>`;
    return;
  }

  agentList.forEach((agent) => {
    let rowTotal = 0;
    const counts = {};

    types.forEach((t) => {
      const cnt = weekCases.filter((c) => c.agent === agent && c.type === t).length;
      counts[t] = cnt;
      rowTotal += cnt;
      colTotals[t] += cnt;
    });
    colTotals.Total += rowTotal;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${agent}</strong></td>
      <td style="text-align: center;">${counts["Incident"] > 0 ? `<span class="pill pill-low">${counts["Incident"]}</span>` : "0"}</td>
      <td style="text-align: center;">${counts["Service Request"] > 0 ? `<span class="pill pill-medium">${counts["Service Request"]}</span>` : "0"}</td>
      <td style="text-align: center;">${counts["Query"] > 0 ? `<span class="pill pill-high">${counts["Query"]}</span>` : "0"}</td>
      <td style="text-align: center;">${counts["Feature Request"] > 0 ? `<span class="pill pill-critical">${counts["Feature Request"]}</span>` : "0"}</td>
      <td style="text-align: center; font-weight: 700;">${rowTotal}</td>
    `;
    tbody.appendChild(tr);
  });

  tfoot.innerHTML = `
    <tr>
      <td>Total Assigned</td>
      <td style="text-align: center;">${colTotals["Incident"]}</td>
      <td style="text-align: center;">${colTotals["Service Request"]}</td>
      <td style="text-align: center;">${colTotals["Query"]}</td>
      <td style="text-align: center;">${colTotals["Feature Request"]}</td>
      <td style="text-align: center; font-size: 15px;">${colTotals.Total}</td>
    </tr>
  `;
}

function renderTable() {
  const tbody = document.getElementById("casesTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const filterIndicator = document.getElementById("statusFilterIndicator");
  const activeStatusLabel = document.getElementById("activeStatusLabel");

  let displayedCases = [];

  if (state.selectedStatusFilter === "ALL") {
    // 1. View All Cases
    displayedCases = state.filteredCases;
    if (filterIndicator) {
      filterIndicator.style.display = "inline-flex";
      activeStatusLabel.textContent = "All Cases";
    }
  } else if (state.selectedStatusFilter && state.selectedStatusFilter !== "ACTIVE") {
    // 2. Specific status selected (from donut or dropdown)
    displayedCases = state.filteredCases.filter(
      (c) => (c.status || "").toLowerCase() === state.selectedStatusFilter.toLowerCase()
    );
    if (filterIndicator) {
      filterIndicator.style.display = "inline-flex";
      activeStatusLabel.textContent = state.selectedStatusFilter;
    }
  } else {
    // 3. Default view: Active queue tickets (New / Assigned)
    displayedCases = state.filteredCases.filter((c) => {
      const s = (c.status || "").toLowerCase();
      return s === "new" || s === "assigned";
    });
    if (filterIndicator) {
      filterIndicator.style.display = "none";
    }
  }

  const countElem = document.getElementById("recordCountText");
  if (countElem) {
    let filterDesc = "New / Assigned";
    if (state.selectedStatusFilter === "ALL") filterDesc = "All Statuses";
    else if (state.selectedStatusFilter && state.selectedStatusFilter !== "ACTIVE") {
      filterDesc = `Status: ${state.selectedStatusFilter}`;
    }
    countElem.textContent = `Showing ${Math.min(200, displayedCases.length)} of ${displayedCases.length} (${filterDesc})`;
  }

  const displayList = displayedCases.slice(0, 200);

  if (displayList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: #888; padding: 25px;">No cases found matching the active filters.</td></tr>`;
    return;
  }

  const nowMs = Date.now();

  displayList.forEach((c) => {
    const tr = document.createElement("tr");
    const pClass = (c.priority || "medium").toLowerCase();
    const ageHours = Math.floor((nowMs - c.routedDate.getTime()) / (1000 * 60 * 60));
    const isAgingBreach = ageHours >= 24;

    tr.innerHTML = `
      <td><strong>${c.caseNumber}</strong></td>
      <td>${c.subject}</td>
      <td><strong>${c.agent}</strong></td>
      <td><span class="pill pill-medium">${c.type}</span></td>
      <td><span class="pill pill-${pClass}">${c.priority}</span></td>
      <td>${c.origin}</td>
      <td>
        ${c.routedDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })} 
        ${isAgingBreach ? `<span class="pill pill-critical" style="margin-left: 5px;">${ageHours}h</span>` : `<span style="color: #666; font-size: 12px;">(${ageHours}h)</span>`}
      </td>
      <td><span class="pill ${c.status.toLowerCase() === 'new' ? 'pill-high' : 'pill-medium'}">${c.status}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

function applyFilters() {
  const searchInput = document.getElementById("searchInput");
  const priorityFilter = document.getElementById("priorityFilter");
  const originFilter = document.getElementById("originFilter");

  const term = (searchInput ? searchInput.value : "").toLowerCase();
  const selPriority = priorityFilter ? priorityFilter.value : "ALL";
  const selOrigin = originFilter ? originFilter.value : "ALL";

  state.filteredCases = state.cases.filter((c) => {
    const matchesTab = state.selectedTab === "ALL" || c.type === state.selectedTab;
    const matchesSearch =
      c.caseNumber.toLowerCase().includes(term) ||
      c.subject.toLowerCase().includes(term) ||
      c.agent.toLowerCase().includes(term) ||
      c.type.toLowerCase().includes(term);
    const matchesPriority = selPriority === "ALL" || (c.priority || "").toLowerCase() === selPriority.toLowerCase();
    const matchesOrigin = selOrigin === "ALL" || (c.origin || "").toLowerCase() === selOrigin.toLowerCase();

    return matchesTab && matchesSearch && matchesPriority && matchesOrigin;
  });

  renderDashboard();
}

function setupEventListeners() {
  document.querySelectorAll(".tab-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.selectedTab = btn.getAttribute("data-tab");
      applyFilters();
    });
  });

  const statusFilter = document.getElementById("statusFilter");
  if (statusFilter) {
    statusFilter.addEventListener("change", (e) => {
      state.selectedStatusFilter = e.target.value;
      renderTable();
      renderStatusChart();
    });
  }

  const weekSelect = document.getElementById("agentWeekSelect");
  if (weekSelect) {
    weekSelect.addEventListener("change", (e) => {
      state.selectedWeek = e.target.value;
      renderAgentWorkloadTable();
    });
  }

  const timeSelect = document.getElementById("timeRangeSelect");
  if (timeSelect) {
    timeSelect.addEventListener("change", async (e) => {
      state.timeRange = e.target.value;
      await loadDashboardData();
    });
  }

  const toggleMa = document.getElementById("toggleMa");
  if (toggleMa) {
    toggleMa.addEventListener("change", (e) => {
      state.showMovingAverage = e.target.checked;
      renderDailyInflowChart();
    });
  }

  const searchInput = document.getElementById("searchInput");
  if (searchInput) searchInput.addEventListener("input", applyFilters);

  const priorityFilter = document.getElementById("priorityFilter");
  if (priorityFilter) priorityFilter.addEventListener("change", applyFilters);

  const originFilter = document.getElementById("originFilter");
  if (originFilter) originFilter.addEventListener("change", applyFilters);

  const clearStatusBtn = document.getElementById("clearStatusFilterBtn");
  if (clearStatusBtn) {
    clearStatusBtn.addEventListener("click", () => {
      state.selectedStatusFilter = "ACTIVE";
      const sf = document.getElementById("statusFilter");
      if (sf) sf.value = "ACTIVE";
      renderTable();
      renderStatusChart();
    });
  }

  const refreshBtn = document.getElementById("refreshDataBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => loadDashboardData());
  }

  const exportBtn = document.getElementById("exportCsvBtn");
  if (exportBtn) exportBtn.addEventListener("click", exportToCSV);

  const fileInput = document.getElementById("csvFileInput");
  if (fileInput) fileInput.addEventListener("change", handleFileUpload);
}

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const content = e.target.result;
      if (file.name.endsWith(".json")) {
        const parsed = JSON.parse(content);
        const records = Array.isArray(parsed) ? parsed : parsed.records || [];
        mapIncomingRecords(records);
      } else {
        parseCSV(content);
      }
      populateWeekSelectOptions();
      populateStatusFilterOptions();
      alert(`Imported ${state.cases.length} records successfully.`);
    } catch (err) {
      alert("Error reading file: " + err.message);
    }
  };
  reader.readAsText(file);
}

function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return;
  const headers = lines[0].split(",").map((h) => h.trim().replace(/"/g, ""));

  const records = lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.trim().replace(/"/g, ""));
    const row = {};
    headers.forEach((h, idx) => (row[h] = values[idx]));
    return row;
  });

  mapIncomingRecords(records);
}

function exportToCSV() {
  const activeCases = state.filteredCases.filter((c) => {
    const s = (c.status || "").toLowerCase();
    if (state.selectedStatusFilter === "ALL") return true;
    if (state.selectedStatusFilter && state.selectedStatusFilter !== "ACTIVE") {
      return s === state.selectedStatusFilter.toLowerCase();
    }
    return s === "new" || s === "assigned";
  });

  const headers = ["CaseNumber", "Subject", "Assigned Agent", "Type", "Priority", "Origin", "RoutedDate", "AgeHours", "Status"];
  const nowMs = Date.now();

  const rows = activeCases.map((c) => {
    const ageHours = Math.floor((nowMs - c.routedDate.getTime()) / (1000 * 60 * 60));
    return [
      c.caseNumber,
      `"${c.subject.replace(/"/g, '""')}"`,
      `"${(c.agent || "Unassigned").replace(/"/g, '""')}"`,
      c.type,
      c.priority,
      c.origin,
      c.routedDate.toISOString(),
      ageHours,
      c.status
    ];
  });

  const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map((e) => e.join(","))].join("\n");
  const link = document.createElement("a");
  link.setAttribute("href", encodeURI(csvContent));
  link.setAttribute("download", `queue_backlog_${state.selectedTab}_${state.timeRange}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}