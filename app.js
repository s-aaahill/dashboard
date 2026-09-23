/**
 * Salesforce Single-Queue Inflow Dashboard Controller
 */

// Application State
const state = {
  queueName: "Admin Queue",
  timeRange: "rolling30", // 'rolling30', 'thisMonth', or 'lastMonth'
  selectedTab: "ALL",     // 'ALL', 'Incident', 'Service Request', 'Query', 'Feature Request'
  cases: [],
  filteredCases: [],
  charts: {},
  showMovingAverage: true,
  isLiveApiConnected: false
};

// Colors matching Salesforce Lightning Design System
const SF_COLORS = {
  blue: "#0176D3",
  navy: "#032D60",
  orange: "#FE9339",
  green: "#2E844A",
  red: "#EA001E",
  purple: "#7F27CE",
  gridLines: "#EAEAEA"
};

// 1. Initialize Application
document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  updateDateRangeLabel();
  await loadDashboardData();
});

// 2. Timeframe Label Calculation
function updateDateRangeLabel() {
  const labelElem = document.getElementById("dateRangeText");
  if (!labelElem) return;
  const now = new Date();
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  if (state.timeRange === "thisMonth") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    labelElem.textContent = `Window: ${fmt(start)} — ${fmt(now)} (Month-to-Date)`;
  } else if (state.timeRange === "rolling30") {
    const past30 = new Date();
    past30.setDate(now.getDate() - 30);
    labelElem.textContent = `Window: ${fmt(past30)} — ${fmt(now)}`;
  } else {
    const firstDayPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastDayPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    const monthName = firstDayPrevMonth.toLocaleDateString("en-US", { month: "short" });
    labelElem.textContent = `Window: ${monthName} 01 — ${monthName} ${lastDayPrevMonth.getDate()}, ${firstDayPrevMonth.getFullYear()}`;
  }
}

// 3. Fetch Data from Backend API
async function loadDashboardData() {
  updateDateRangeLabel();
  try {
    const url = `/api/queue-inflow?queueName=${encodeURIComponent(state.queueName)}&range=${state.timeRange}`;
    const response = await fetch(url);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    if (data.records && Array.isArray(data.records)) {
      mapIncomingRecords(data.records);
      state.isLiveApiConnected = true;
      return;
    }
    throw new Error("Invalid response payload structure");
  } catch (err) {
    console.warn("Could not retrieve live Salesforce data:", err.message);
    state.isLiveApiConnected = false;
  }
}

// 4. Ticket Type Normalization Helper
function normalizeType(rawType) {
  if (!rawType) return "Incident";
  const t = String(rawType).toLowerCase().trim();
  if (t.includes("service") || t.includes("request") || t === "sr") return "Service Request";
  if (t.includes("query") || t.includes("question") || t.includes("inquiry")) return "Query";
  if (t.includes("feature") || t.includes("enhancement") || t.includes("cr")) return "Feature Request";
  if (t.includes("incident") || t.includes("issue") || t.includes("bug")) return "Incident";
  return rawType;
}

// 5. Inflow Normalization & Mapping
function mapIncomingRecords(raw) {
  state.cases = raw.map((r, i) => {
    const rawDate = r.CreatedDate || new Date().toISOString();
    const dateObj = new Date(rawDate);

    return {
      id: r.Id || `rec-${i}`,
      caseNumber: r.CaseNumber || `00${100000 + i}`,
      subject: r.Subject || "(No Subject)",
      type: normalizeType(r.Type || r.Ticket_Type__c),
      priority: r.Automation_Priority__c || r.Priority || "Medium",
      origin: r.Origin || "Portal",
      routedDate: dateObj,
      dateKey: dateObj.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      hourOfDay: dateObj.getHours(),
      status: r.Status || "New"
    };
  });

  updateTabBadges();
  applyFilters();
}

// 6. Update Tab Counter Badges
function updateTabBadges() {
  const counts = {
    ALL: state.cases.length,
    Incident: 0,
    "Service Request": 0,
    Query: 0,
    "Feature Request": 0
  };

  state.cases.forEach((c) => {
    if (counts[c.type] !== undefined) {
      counts[c.type]++;
    }
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

// 8. Render All Dashboard Components
function renderDashboard() {
  updateKPICards();
  renderDailyInflowChart();
  renderOriginChart();
  renderHourlyCurveChart();
  renderPriorityChart();
  renderTable();
}

// 9. KPI Calculations
function updateKPICards() {
  const total = state.filteredCases.length;
  const totalElem = document.getElementById("kpiTotalInflow");
  if (totalElem) totalElem.textContent = total.toLocaleString();

  const dayMap = {};
  state.filteredCases.forEach((c) => {
    dayMap[c.dateKey] = (dayMap[c.dateKey] || 0) + 1;
  });

  const uniqueDays = Object.keys(dayMap).length || 1;
  const avg = (total / uniqueDays).toFixed(1);
  const avgElem = document.getElementById("kpiDailyAvg");
  if (avgElem) avgElem.textContent = avg;

  const avgSplitElem = document.getElementById("kpiAvgSplit");
  if (avgSplitElem) avgSplitElem.textContent = `Active days: ${uniqueDays} / Intake avg`;

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
}

// 10. Daily Inflow Chart with Continuous Timeline
function renderDailyInflowChart() {
  const canvas = document.getElementById("dailyInflowChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (state.charts.daily) state.charts.daily.destroy();

  const dateKeys = [];
  const now = new Date();

  if (state.timeRange === "rolling30") {
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(now.getDate() - i);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
  } else if (state.timeRange === "thisMonth") {
    const todayDate = now.getDate();
    for (let day = 1; day <= todayDate; day++) {
      const d = new Date(now.getFullYear(), now.getMonth(), day);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
  } else {
    const totalDays = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    for (let day = 1; day <= totalDays; day++) {
      const d = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), day);
      dateKeys.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
    }
  }

  const countsMap = {};
  dateKeys.forEach((k) => (countsMap[k] = 0));
  state.filteredCases.forEach((c) => {
    if (countsMap[c.dateKey] !== undefined) countsMap[c.dateKey]++;
  });

  const dataCounts = dateKeys.map((k) => countsMap[k]);

  // 7-day Simple Moving Average calculation
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

// 11. Channel Breakdown Donut Chart
function renderOriginChart() {
  const canvas = document.getElementById("originChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (state.charts.origin) state.charts.origin.destroy();

  const originCounts = {};
  state.filteredCases.forEach((c) => {
    originCounts[c.origin] = (originCounts[c.origin] || 0) + 1;
  });

  state.charts.origin = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: Object.keys(originCounts),
      datasets: [
        {
          data: Object.values(originCounts),
          backgroundColor: [SF_COLORS.blue, SF_COLORS.navy, SF_COLORS.purple, SF_COLORS.orange, SF_COLORS.green]
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom" } }
    }
  });
}

// 12. Hourly Intake Curve
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

// 13. Priority Tier Distribution
function renderPriorityChart() {
  const canvas = document.getElementById("priorityChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (state.charts.priority) state.charts.priority.destroy();

  const priorityKeys = ["Low", "Medium", "High", "Critical"];
  const counts = priorityKeys.map(
    (p) => state.filteredCases.filter((c) => (c.priority || "").toLowerCase() === p.toLowerCase()).length
  );

  state.charts.priority = new Chart(ctx, {
    type: "bar",
    data: {
      labels: priorityKeys,
      datasets: [
        {
          label: "Case Volume",
          data: counts,
          backgroundColor: [SF_COLORS.green, SF_COLORS.blue, SF_COLORS.orange, SF_COLORS.red],
          borderRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: SF_COLORS.gridLines }, beginAtZero: true }
      }
    }
  });
}

// 14. Detail Data Table
function renderTable() {
  const tbody = document.getElementById("casesTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const displayList = state.filteredCases.slice(0, 50);
  const countElem = document.getElementById("recordCountText");
  if (countElem) {
    countElem.textContent = `Showing ${displayList.length} of ${state.filteredCases.length} cases`;
  }

  displayList.forEach((c) => {
    const tr = document.createElement("tr");
    const pClass = (c.priority || "medium").toLowerCase();
    tr.innerHTML = `
      <td><strong>${c.caseNumber}</strong></td>
      <td>${c.subject}</td>
      <td><span class="pill pill-medium">${c.type}</span></td>
      <td><span class="pill pill-${pClass}">${c.priority}</span></td>
      <td>${c.origin}</td>
      <td>${c.routedDate.toLocaleString()}</td>
      <td><span class="pill pill-medium">${c.status}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

// 15. Filtering Logic
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
      c.type.toLowerCase().includes(term);
    const matchesPriority = selPriority === "ALL" || (c.priority || "").toLowerCase() === selPriority.toLowerCase();
    const matchesOrigin = selOrigin === "ALL" || (c.origin || "").toLowerCase() === selOrigin.toLowerCase();

    return matchesTab && matchesSearch && matchesPriority && matchesOrigin;
  });

  renderDashboard();
}

// 16. Event Listeners Setup
function setupEventListeners() {
  // Tab navigation buttons
  document.querySelectorAll(".tab-nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.selectedTab = btn.getAttribute("data-tab");
      applyFilters();
    });
  });

  // Timeframe dropdown selector
  const timeSelect = document.getElementById("timeRangeSelect");
  if (timeSelect) {
    timeSelect.addEventListener("change", async (e) => {
      state.timeRange = e.target.value;
      await loadDashboardData();
    });
  }

  // Trendline toggle
  const toggleMa = document.getElementById("toggleMa");
  if (toggleMa) {
    toggleMa.addEventListener("change", (e) => {
      state.showMovingAverage = e.target.checked;
      renderDailyInflowChart();
    });
  }

  // Search and Filter controls
  const searchInput = document.getElementById("searchInput");
  if (searchInput) searchInput.addEventListener("input", applyFilters);

  const priorityFilter = document.getElementById("priorityFilter");
  if (priorityFilter) priorityFilter.addEventListener("change", applyFilters);

  const originFilter = document.getElementById("originFilter");
  if (originFilter) originFilter.addEventListener("change", applyFilters);

  // Refresh button
  const refreshBtn = document.getElementById("refreshDataBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => loadDashboardData());
  }

  // CSV Export & Upload
  const exportBtn = document.getElementById("exportCsvBtn");
  if (exportBtn) exportBtn.addEventListener("click", exportToCSV);

  const fileInput = document.getElementById("csvFileInput");
  if (fileInput) fileInput.addEventListener("change", handleFileUpload);

  // Settings Modal Controls
  const modal = document.getElementById("settingsModal");
  const openModalTrigger = document.getElementById("queueNameBadge");
  const closeModalBtn = document.getElementById("closeSettingsBtn");
  const saveModalBtn = document.getElementById("saveSettingsBtn");

  if (modal && openModalTrigger) {
    openModalTrigger.style.cursor = "pointer";
    openModalTrigger.addEventListener("click", () => (modal.style.display = "flex"));
  }
  if (modal && closeModalBtn) {
    closeModalBtn.addEventListener("click", () => (modal.style.display = "none"));
  }
  if (saveModalBtn) {
    saveModalBtn.addEventListener("click", saveSettings);
  }
}

// 17. Save Settings Modal Handler
async function saveSettings() {
  const nameInput = document.getElementById("queueNameInput");
  const idInput = document.getElementById("queueIdInput");

  if (nameInput && nameInput.value.trim()) state.queueName = nameInput.value.trim();

  const badgeElem = document.getElementById("queueNameBadge");
  if (badgeElem) badgeElem.textContent = state.queueName;

  const modal = document.getElementById("settingsModal");
  if (modal) modal.style.display = "none";

  await loadDashboardData();
}

// 18. File Upload & CSV Export
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
  const headers = ["CaseNumber", "Subject", "Type", "Priority", "Origin", "RoutedDate", "Status"];
  const rows = state.filteredCases.map((c) => [
    c.caseNumber,
    `"${c.subject.replace(/"/g, '""')}"`,
    c.type,
    c.priority,
    c.origin,
    c.routedDate.toISOString(),
    c.status
  ]);

  const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map((e) => e.join(","))].join("\n");
  const link = document.createElement("a");
  link.setAttribute("href", encodeURI(csvContent));
  link.setAttribute("download", `queue_inflow_${state.selectedTab}_${state.timeRange}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// 19. Utility Helpers
function getRandomWeightedHour() {
  const r = Math.random();
  if (r < 0.65) return Math.floor(Math.random() * 7) + 9;
  if (r < 0.90) return Math.floor(Math.random() * 6) + 16;
  return Math.floor(Math.random() * 9);
}

function getWeightedChoice(items, weights) {
  const rand = Math.random();
  let cumulative = 0;
  for (let i = 0; i < items.length; i++) {
    cumulative += weights[i];
    if (rand <= cumulative) return items[i];
  }
  return items[items.length - 1];
}

function getRandomSubject() {
  const subjects = [
    "Unable to authenticate SSO via Okta",
    "Billing discrepancy on invoice #INV-9281",
    "API 500 error on webhook endpoint /v1/events",
    "Password reset request from locked user",
    "Latency spike observed on US-East tenant",
    "Integration failure with external ERP sync",
    "Request for permissions upgrade to manager tier",
    "License allocation quota exceeded"
  ];
  return subjects[Math.floor(Math.random() * subjects.length)];
}