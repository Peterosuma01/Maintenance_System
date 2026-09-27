// ============================================================
// PWA / API CONFIGURATION
// ============================================================
const CONFIG = {
  // Paste your deployed Google Apps Script Web App URL here (must end in /exec).
  // Deploy > New deployment > Web app > Execute as "Me", Access "Anyone".
  API_URL: 'https://script.google.com/macros/s/AKfycbwdryWkZ6ofbUc31vqXgC3s2Ir0Yc6rDDJxe8txhLMnVcVVqYOKRNXWhNaHQlN4YXRF/exec',

  // Must match API_TOKEN in Api.gs on the Apps Script side.
  API_TOKEN: '3S&k:2`2KB\p|_y@`oUPW)kXBrl@{-xa}fJ)'
};

// ============================================================
// GLOBAL STATE
// ============================================================
let issuesData = [];
let pmData = [];
let machinesData = [];
let staffData = [];
let categoriesData = [];
let settingsData = {};
let currentView = 'dashboard';
let pmUrgencyFilter = null;

// Frequency options for PM records - value is what's stored in the
// sheet, label is what's shown. 'Bi-Weekly' displays as "After Two
// Weeks" per how the client phrases it.
const PM_FREQUENCIES = [
  { value: 'Weekly', label: 'Weekly' },
  { value: 'Bi-Weekly', label: 'After Two Weeks' },
  { value: 'Monthly', label: 'Monthly' },
  { value: 'Annually', label: 'Annually' }
];

// ============================================================
// API CALL WRAPPER (replaces google.script.run)
// ============================================================
// Calls the Apps Script web app's doPost() endpoint (see Api.gs) with
// {token, fn, args} and resolves with whatever that server function
// returns - i.e. the same shape { success, data/message, ... } your
// UI code already expects.
function gsRun(fnName, ...args) {
  return fetch(CONFIG.API_URL, {
    method: 'POST',
    // text/plain avoids a CORS preflight (OPTIONS) request, which
    // Apps Script web apps do not handle.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: CONFIG.API_TOKEN, fn: fnName, args })
  }).then(res => {
    if (!res.ok) throw new Error('Network error: ' + res.status);
    return res.json();
  }).then(result => {
    if (result && result.success === false && result.message === 'Unauthorized') {
      throw new Error('Unauthorized - check API_TOKEN in app.js matches Api.gs');
    }
    return result;
  });
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', initializeApp);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker registration failed:', err));
  });
}

async function initializeApp() {
  showLoading(true);
  try {
    setupNavigation();
    setupGlobalListeners();
    setupReportListeners();

      const [settingsRes, categoriesRes, machinesRes] = await Promise.all([
      gsRun('getSettings'),
      gsRun('getMachineCategories'),
      gsRun('getAllMachines')
    ]);
    if (settingsRes.success) settingsData = settingsRes.data;
    if (categoriesRes.success) categoriesData = categoriesRes.data;
    if (machinesRes.success) machinesData = machinesRes.data;

    populateStaticSelects();
    await loadDashboard();

    showToast('System loaded successfully', 'success');
  } catch (err) {
    console.error(err);
    showToast('Error initializing system: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

function setupGlobalListeners() {
  document.getElementById('btn-quick-new-issue').addEventListener('click', () => openIssueModal(null));
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', e => { if (e.target.id === 'modal-backdrop') closeModal(); });

  // Scheduled PM list on the dashboard - click any row to open its full detail.
  const scheduledList = document.getElementById('pm-scheduled-list');
  if (scheduledList) {
    scheduledList.addEventListener('click', e => {
      const item = e.target.closest('[data-pm-id]');
      if (item) openPMDetailModal(item.dataset.pmId);
    });
  }
  const kpiGrid = document.getElementById('kpi-grid');
if (kpiGrid) {
  kpiGrid.addEventListener('click', e => {
    const card = e.target.closest('[data-kpi-view]');
    if (!card) return;
    const view = card.dataset.kpiView;
    if (view === 'issues') goToIssuesFiltered(card.dataset.kpiStatus);
    else if (view === 'pm') goToPMFiltered(card.dataset.kpiStatus, card.dataset.kpiUrgency);
  });
}
}

function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => navigateTo(item.dataset.view));
  });
}

function setupReportListeners() {
  document.querySelectorAll('[data-report]').forEach(card => {
    card.addEventListener('click', () => generateReportView(card.dataset.report));
  });
  document.querySelectorAll('[data-summary]').forEach(card => {
    card.addEventListener('click', () => generateSummaryReport());
  });
  const printBtn = document.getElementById('btn-print-report');
  if (printBtn) printBtn.addEventListener('click', () => window.print());

  const machineHistoryBtn = document.getElementById('btn-machine-history');
  if (machineHistoryBtn) machineHistoryBtn.addEventListener('click', generateMachineHistoryReport);
}

const VIEW_TITLES = {
  dashboard: 'Dashboard', issues: 'Issue Log', pm: 'Preventive Maintenance',
  machines: 'Machines', staff: 'Staff', reports: 'Reports', settings: 'Settings'
};

function navigateTo(view) {
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.view === view));
  document.querySelectorAll('.view').forEach(s => s.classList.add('hidden'));
  document.getElementById('view-' + view).classList.remove('hidden');
  document.getElementById('view-title').textContent = VIEW_TITLES[view] || view;
  currentView = view;

  switch (view) {
    case 'dashboard': loadDashboard(); break;
    case 'issues': loadIssues(); break;
    case 'pm': loadPM(); break;
    case 'machines': loadMachines(); break;
    case 'staff': loadStaff(); break;
    case 'reports': populateMachineHistorySelect(); break;
    case 'settings': loadSettingsPage(); break;
  }
}

function populateStaticSelects() {
  const priorities = (settingsData['Priorities'] || 'High,Medium,Low').split(',');
  const statuses = (settingsData['Statuses'] || 'Open,In Progress,Closed,Pending Parts,On Hold').split(',');
  const pmStatuses = ['Completed', 'In Progress', 'Scheduled'];

  setOptions('filter-priority', priorities, true);
  setOptions('filter-status', statuses, true);
  setOptions('filter-category', categoriesData, true);
  setOptions('pm-filter-status', pmStatuses, true);
  setOptions('pm-filter-category', categoriesData, true);
  setOptions('machine-filter-category', categoriesData, true);
  setOptions('staff-filter-status', ['Active', 'Inactive'], true);
}

function setOptions(selectId, values, keepFirst) {
  const el = document.getElementById(selectId);
  if (!el) return;
  const first = keepFirst ? el.options[0] : null;
  el.innerHTML = '';
  if (first) el.appendChild(first);
  values.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = v;
    el.appendChild(opt);
  });
}

function optionsHtml(values, selected) {
  return values.map(v => `<option value="${escapeHtml(v)}" ${v === selected ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
}

// ============================================================
// GENERIC MODAL
// ============================================================
function openModal(title, bodyHtml) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  document.getElementById('modal-backdrop').classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal-backdrop').classList.add('hidden');
  document.getElementById('modal-body').innerHTML = '';
}

// ============================================================
// READ-ONLY DETAIL PREVIEW (issue + PM)
// ============================================================
function detailField(label, value, full) {
  const v = (value === null || value === undefined || value === '') ? '-' : value;
  return `<div class="detail-field${full ? ' full' : ''}">
    <div class="detail-label">${escapeHtml(label)}</div>
    <div class="detail-value">${escapeHtml(v)}</div>
  </div>`;
}

function openIssueDetailModal(issueNo) {
  const i = issuesData.find(x => x.issueNo === issueNo);
  if (!i) { showToast('Issue not found in current view', 'error'); return; }

  const html = `
    <div class="detail-grid">
      ${detailField('Issue No.', '#' + i.issueNo)}
      ${detailField('Priority', i.priority)}
      ${detailField('Issue Date', formatDateDisplay(i.issueDate))}
      ${detailField('Issue Time', i.issueTime)}
      ${detailField('Status', i.status)}
      ${detailField('Impact', i.impact)}
      ${detailField('Machine Category', i.machineCategory)}
      ${detailField('Machine Name', getMachineNameById(i.machineId))}
      ${detailField('Reported By', i.reportedBy)}
      ${detailField('Assigned To', i.assignedTo)}
      ${detailField('Description of Fault', i.description, true)}
      ${detailField('Spare Parts Used', i.spareParts)}
      ${detailField('Quantity Used', i.quantityUsed)}
      ${detailField('Balance Stock', i.balanceStock)}
      ${detailField('Resolved Date', i.resolvedDate ? formatDateDisplay(i.resolvedDate) : '')}
      ${detailField('Resolved Time', i.resolvedTime)}
      ${detailField('Engineer In Charge', i.engineerSign)}
      ${detailField('Created By', i.createdBy)}
      ${detailField('Resolution / Recommendations', i.resolution, true)}
      ${detailField('Root Cause', i.rootCause, true)}
      <div class="form-actions no-print">
        <button class="btn btn-ghost" onclick="closeModal()">Close</button>
        <button class="btn btn-primary" id="btn-detail-edit">Edit Issue</button>
      </div>
    </div>
  `;
  openModal('Issue #' + i.issueNo + ' — Details', html);
  document.getElementById('btn-detail-edit').addEventListener('click', () => {
    closeModal();
    openIssueModal(i.issueNo);
  });
}

function openPMDetailModal(pmId) {
  const p = pmData.find(x => x.pmId === pmId);
  if (!p) { showToast('PM record not found in current view', 'error'); return; }

  const isScheduled = p.status === 'Scheduled';
  const freqLabel = pmFrequencyLabel(p.frequency);

  const scheduleHtml = isScheduled
    ? detailField('Schedule Date (planned)', p.scheduleDate ? formatDateDisplay(p.scheduleDate) : '')
      + `<div class="detail-field">
           <div class="detail-label">Time Remaining</div>
           <div class="detail-value">${p.scheduleDate ? pmDurationHtml(p.scheduleDate) : '-'}</div>
         </div>`
    : `${detailField('Frequency', freqLabel)}
       ${detailField('Next Service Date', p.nextServiceDate ? formatDateDisplay(p.nextServiceDate) : '')}`;

  const html = `
    <div class="detail-grid">
      ${detailField('PM ID', p.pmId)}
      ${detailField('Date Logged', formatDateDisplay(p.date))}
      ${detailField('Machine Category', p.machineCategory)}
      ${detailField('Machine Name', getMachineNameById(p.machineId))}
      ${detailField('Service Type', p.serviceType)}
      ${detailField('General Service Done', p.generalServiceDone)}
      ${detailField('Status', p.status)}
      ${scheduleHtml}
      ${detailField('Maintenance Team', p.maintenanceTeam)}
      ${detailField('Engineer In Charge', p.engineerInCharge)}
      ${detailField('Comments / Remarks', p.comments, true)}
      ${detailField('Created At', p.createdAt)}
      ${detailField('Last Updated', p.updatedAt)}
      <div class="form-actions no-print">
        <button class="btn btn-ghost" onclick="closeModal()">Close</button>
        <button class="btn btn-primary" id="btn-detail-edit">Edit PM Record</button>
      </div>
    </div>
  `;
  openModal(p.pmId + ' — Details', html);
  document.getElementById('btn-detail-edit').addEventListener('click', () => {
    closeModal();
    openPMModal(p.pmId);
  });
}

// ============================================================
// UTILITIES
// ============================================================
function showLoading(show) { document.getElementById('loading-overlay').classList.toggle('hidden', !show); }

function showToast(message, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = 'toast show' + (type === 'error' ? ' error' : type === 'warning' ? ' warning' : '');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.className = 'toast'; }, 3500);
}

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}
function truncate(text, len) { text = text || ''; return text.length > len ? text.substring(0, len) + '...' : text; }
function classify(str) { return String(str || '').replace(/[^A-Za-z0-9]/g, ''); }
function getMachineNameById(machineId) {
  if (!machineId) return '';
  const m = machinesData.find(x => x.id === machineId);
  return m ? m.name : machineId;
}

function formatDateDisplay(iso) {
  if (!iso) return '-';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function daysFromToday(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return Math.round((d - new Date(new Date().toDateString())) / 86400000);
}
function classifyPMUrgency(nextServiceDate) {
  const days = daysFromToday(nextServiceDate);
  if (days === null) return null;
  if (days < 0) return 'overdue';
  if (days <= 7) return 'due-soon';
  return 'upcoming';
}

// Human-readable countdown/overdue string relative to today.
function pmDurationLabel(dateStr) {
  const days = daysFromToday(dateStr);
  if (days === null) return '';
  if (days === 0) return 'Due today';
  if (days > 0) return days + (days === 1 ? ' day left' : ' days left');
  const overdue = Math.abs(days);
  return 'Overdue by ' + overdue + (overdue === 1 ? ' day' : ' days');
}

function pmDurationHtml(dateStr) {
  if (!dateStr) return '';
  const urgency = classifyPMUrgency(dateStr);
  const color = urgency === 'overdue' ? 'var(--red)' : urgency === 'due-soon' ? 'var(--amber)' : 'var(--green)';
  return `<span style="font-weight:700;color:${color};">${escapeHtml(pmDurationLabel(dateStr))}</span>`;
}

// Human label for a stored frequency value ('Bi-Weekly' -> 'After Two Weeks').
function pmFrequencyLabel(value) {
  if (!value) return '';
  const match = PM_FREQUENCIES.find(f => f.value === value);
  return match ? match.label : value;
}

// Adds an interval to an ISO date string (yyyy-mm-dd) and returns a new
// ISO date string. Returns '' if either input is missing/invalid or the
// frequency isn't one of the known values (i.e. "set manually").
function calcNextServiceDate(dateStr, frequency) {
  if (!dateStr || !frequency) return '';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return '';

  switch (frequency) {
    case 'Weekly': d.setDate(d.getDate() + 7); break;
    case 'Bi-Weekly': d.setDate(d.getDate() + 14); break;
    case 'Monthly': d.setMonth(d.getMonth() + 1); break;
    case 'Annually': d.setFullYear(d.getFullYear() + 1); break;
    default: return '';
  }

  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Recomputes Next Service Date from the current Date + Frequency fields
// in the open PM form, if a frequency is selected. Leaves Next Service
// Date untouched (fully manual) when Frequency is blank.
function autoSetPMNextServiceDate() {
  const freqEl = document.getElementById('f-pmFrequency');
  const dateEl = document.getElementById('f-pmDate');
  const nextEl = document.getElementById('f-pmNextDate');
  if (!freqEl || !dateEl || !nextEl) return;

  const next = calcNextServiceDate(dateEl.value, freqEl.value);
  if (next) nextEl.value = next;
}

async function downloadCsv(sheetName, filenamePrefix) {
  showLoading(true);
  try {
    const res = await gsRun('exportToCSV', sheetName);
    if (!res.success) { showToast('Export failed: ' + res.message, 'error'); return; }
    const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filenamePrefix + '_' + todayISO() + '.csv';
    link.click();
    showToast('Export completed', 'success');
  } catch (err) {
    showToast('Export error: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

async function populateMachineIdSelect(category, selectId, selectedId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = '<option value="">Select Machine</option>';
  if (!category) return;
  try {
    const res = await gsRun('getMachinesByCategory', category);
    if (res.success) {
      res.data.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        if (m.id === selectedId) opt.selected = true;
        select.appendChild(opt);
      });
    }
  } catch (err) { console.error(err); }
}

// ============================================================
// DASHBOARD
// ============================================================
async function loadDashboard() {
  showLoading(true);
  try {
    const res = await gsRun('getDashboardData');
    if (!res.success) { showToast('Error loading dashboard: ' + res.message, 'error'); return; }
    const d = res.data;

   document.getElementById('kpi-grid').innerHTML = `
  ${kpiCard('Total Issues', d.totalIssues, '', { view: 'issues', status: 'All' })}
  ${kpiCard('Open', d.openIssues, 'amber', { view: 'issues', status: 'Open' })}
  ${kpiCard('In Progress', d.inProgressIssues, 'blue', { view: 'issues', status: 'In Progress' })}
  ${kpiCard('Closed', d.closedIssues, 'green', { view: 'issues', status: 'Closed' })}
  ${kpiCard('Avg Resolution (days)', d.avgResolutionTime, '')}
  ${kpiCard('Scheduled', d.pmScheduled, 'blue', { view: 'pm', status: 'Scheduled' })}
  ${kpiCard('PM Due within 7 Days', d.pmDueSoon, d.pmDueSoon > 0 ? 'red' : 'green', { view: 'pm', urgency: 'due-soon-or-overdue' })}
`;

    renderBarChart('chart-category', d.topMachines.map(m => ({ label: m.name, count: m.count })), '');
    renderBarChart('chart-priority', [
      { label: 'High', count: d.priorityDistribution.High, cls: 'priority-High' },
      { label: 'Medium', count: d.priorityDistribution.Medium, cls: 'priority-Medium' },
      { label: 'Low', count: d.priorityDistribution.Low, cls: 'priority-Low' }
    ], '');
    renderTrendChart('chart-trend', d.monthlyTrend);

    await Promise.all([loadPMOverdueList(), loadRecentIssuesList(), loadScheduledPMList()]);
  } catch (err) {
    console.error(err);
    showToast('Error loading dashboard data', 'error');
  } finally {
    showLoading(false);
  }
}

function kpiCard(label, value, colorClass, target) {
  const clickableClass = target ? ' kpi-card-clickable' : '';
  const attrs = target
    ? ` data-kpi-view="${target.view}"${target.status ? ` data-kpi-status="${escapeHtml(target.status)}"` : ''}${target.urgency ? ` data-kpi-urgency="${target.urgency}"` : ''}`
    : '';
  return `<div class="kpi-card${clickableClass}"${attrs}><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value ${colorClass}">${value}</div></div>`;
}

function goToIssuesFiltered(status) {
  navigateTo('issues');
  document.getElementById('issue-search').value = '';
  document.getElementById('filter-status').value = status || 'All';
  document.getElementById('filter-priority').value = 'All';
  document.getElementById('filter-category').value = 'All';
  document.getElementById('filter-from').value = '';
  document.getElementById('filter-to').value = '';
  loadIssues();
}

function goToPMFiltered(status, urgency) {
  navigateTo('pm');
  document.getElementById('pm-search').value = '';
  document.getElementById('pm-filter-category').value = 'All';
  document.getElementById('pm-filter-status').value = status || 'All';
  pmUrgencyFilter = urgency || null;
  if (urgency) showToast('Showing PM records due within 7 days or overdue', 'info');
  loadPM();
}

function renderBarChart(containerId, items, extra) {
  const container = document.getElementById(containerId);
  if (!items || items.length === 0) { container.innerHTML = '<div class="empty-state">No data yet</div>'; return; }
  const max = Math.max(...items.map(i => i.count), 1);
  container.innerHTML = items.map(i => `
    <div class="bar-row">
      <div class="bar-label" title="${escapeHtml(i.label)}">${escapeHtml(i.label)}</div>
      <div class="bar-track"><div class="bar-fill ${i.cls || ''}" style="width:${(i.count / max) * 100}%"></div></div>
      <div class="bar-count">${i.count}</div>
    </div>
  `).join('');
}

function renderTrendChart(containerId, trend) {
  const container = document.getElementById(containerId);
  if (!trend || trend.length === 0) { container.innerHTML = '<div class="empty-state">No data yet</div>'; return; }
  const max = Math.max(...trend.map(t => t.count), 1);
  container.innerHTML = `<div class="trend-row">${trend.map(t => `
    <div class="trend-col">
      <div class="trend-count">${t.count}</div>
      <div class="trend-bar" style="height:${(t.count / max) * 100}%"></div>
      <div class="trend-label">${escapeHtml(t.month)}</div>
    </div>
  `).join('')}</div>`;
}

async function loadPMOverdueList() {
  const container = document.getElementById('pm-overdue-list');
  try {
    const res = await gsRun('getPMRecords', { status: 'Scheduled' });
    if (!res.success) { container.innerHTML = '<div class="empty-state">Could not load PM data</div>'; return; }
    const withUrgency = res.data
      .map(pm => ({ pm, urgency: classifyPMUrgency(pm.scheduleDate) }))
      .filter(x => x.urgency === 'overdue' || x.urgency === 'due-soon')
      .sort((a, b) => (a.pm.scheduleDate || '').localeCompare(b.pm.scheduleDate || ''))
      .slice(0, 8);

    if (withUrgency.length === 0) { container.innerHTML = '<div class="empty-state">Nothing overdue or due soon 🎉</div>'; return; }

    container.innerHTML = withUrgency.map(({ pm, urgency }) => `
      <div class="mini-item mini-item-clickable" data-pm-id="${escapeHtml(pm.pmId)}">
        <div>
        <div class="mini-item-main">${escapeHtml(pm.machineCategory)} ${pm.machineId ? '(' + escapeHtml(getMachineNameById(pm.machineId)) + ')' : ''}</div>
          <div class="mini-item-sub">${escapeHtml(pm.serviceType)}</div>
        </div>
        <div style="text-align:right;">
          <span class="badge ${urgency === 'overdue' ? 'badge-Overdue' : 'badge-DueSoon'}">${urgency === 'overdue' ? 'Overdue' : 'Due Soon'}</span>
          <div class="mini-item-sub">${formatDateDisplay(pm.scheduleDate)}</div>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('[data-pm-id]').forEach(el => {
      el.addEventListener('click', () => openPMDetailModal(el.dataset.pmId));
    });
  } catch (err) {
    container.innerHTML = '<div class="empty-state">Could not load PM data</div>';
  }
}

async function loadRecentIssuesList() {
  const container = document.getElementById('recent-issues-list');
  try {
    const res = await gsRun('getIssues', {});
    if (!res.success) { container.innerHTML = '<div class="empty-state">Could not load issues</div>'; return; }
    const recent = [...res.data].sort((a, b) => Number(b.issueNo) - Number(a.issueNo)).slice(0, 6);

    if (recent.length === 0) { container.innerHTML = '<div class="empty-state">No issues logged yet</div>'; return; }

    container.innerHTML = recent.map(i => `
      <div class="mini-item">
        <div>
          <div class="mini-item-main">#${i.issueNo} &middot; ${escapeHtml(i.machineCategory)}</div>
          <div class="mini-item-sub">${escapeHtml(truncate(i.description, 60))}</div>
        </div>
        <div style="text-align:right;">
          <span class="badge badge-${classify(i.priority)}">${escapeHtml(i.priority)}</span>
          <div class="mini-item-sub">${formatDateDisplay(i.issueDate)}</div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = '<div class="empty-state">Could not load issues</div>';
  }
}

// Dashboard: PM records whose Status is "Scheduled". Clicking a row opens
// the same read-only PM detail modal used everywhere else in the app.
async function loadScheduledPMList() {
  const container = document.getElementById('pm-scheduled-list');
  if (!container) return;
  try {
    const res = await gsRun('getPMRecords', { status: 'Scheduled' });
    if (!res.success) { container.innerHTML = '<div class="empty-state">Could not load PM data</div>'; return; }

    const scheduled = [...res.data].sort((a, b) =>
      (a.scheduleDate || a.date || '').localeCompare(b.scheduleDate || b.date || '')
    );

    if (scheduled.length === 0) { container.innerHTML = '<div class="empty-state">No scheduled PM logs</div>'; return; }

    scheduled.forEach(pm => {
      if (!pmData.find(p => p.pmId === pm.pmId)) pmData.push(pm);
    });

    container.innerHTML = scheduled.map(pm => `
      <div class="mini-item mini-item-clickable" data-pm-id="${escapeHtml(pm.pmId)}">
        <div>
        <div class="mini-item-main">${escapeHtml(pm.pmId)} &middot; ${escapeHtml(pm.machineCategory)} ${pm.machineId ? '(' + escapeHtml(getMachineNameById(pm.machineId)) + ')' : ''}</div>
          <div class="mini-item-sub">${escapeHtml(pm.serviceType)}${pm.maintenanceTeam ? ' — ' + escapeHtml(pm.maintenanceTeam) : ''}</div>
          <div class="mini-item-sub">Logged: ${formatDateDisplay(pm.date)}</div>
        </div>
        <div style="text-align:right;">
          <span class="badge badge-Scheduled">Scheduled</span>
          <div class="mini-item-sub">Schedule: ${pm.scheduleDate ? formatDateDisplay(pm.scheduleDate) : '-'}</div>
          ${pm.scheduleDate ? `<div class="mini-item-sub">${pmDurationHtml(pm.scheduleDate)}</div>` : ''}
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = '<div class="empty-state">Could not load PM data</div>';
  }
}

// ============================================================
// ISSUES
// ============================================================
function setupIssuesListeners() {
  document.getElementById('issue-search').addEventListener('input', debounce(loadIssues, 400));
  document.getElementById('filter-status').addEventListener('change', loadIssues);
  document.getElementById('filter-priority').addEventListener('change', loadIssues);
  document.getElementById('filter-category').addEventListener('change', loadIssues);
  document.getElementById('filter-from').addEventListener('change', loadIssues);
  document.getElementById('filter-to').addEventListener('change', loadIssues);
  document.getElementById('btn-clear-issue-filters').addEventListener('click', () => {
    document.getElementById('issue-search').value = '';
    document.getElementById('filter-status').value = 'All';
    document.getElementById('filter-priority').value = 'All';
    document.getElementById('filter-category').value = 'All';
    document.getElementById('filter-from').value = '';
    document.getElementById('filter-to').value = '';
    loadIssues();
  });
  document.getElementById('btn-export-issues').addEventListener('click', () => downloadCsv('Issue Log', 'Maintenance_Issues'));

  // Delegated click handler: action buttons (edit/delete) fire first and
  // stopPropagation so a preview modal doesn't also open; anything else
  // on the row opens the read-only detail preview.
  document.querySelector('#issues-table tbody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (btn) {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (btn.dataset.action === 'edit') openIssueModal(id);
      else if (btn.dataset.action === 'delete') deleteIssueConfirm(id);
      return;
    }
    const row = e.target.closest('tr[data-issue-no]');
    if (row) openIssueDetailModal(row.dataset.issueNo);
  });
}
let _issuesListenersSet = false;

async function loadIssues() {
  if (!_issuesListenersSet) { setupIssuesListeners(); _issuesListenersSet = true; }
  showLoading(true);
  const filters = {
    search: document.getElementById('issue-search').value,
    status: document.getElementById('filter-status').value,
    priority: document.getElementById('filter-priority').value,
    machineCategory: document.getElementById('filter-category').value,
    dateFrom: document.getElementById('filter-from').value,
    dateTo: document.getElementById('filter-to').value
  };
  try {
    const res = await gsRun('getIssues', filters);
    if (!res.success) { showToast('Error loading issues: ' + res.message, 'error'); return; }
    issuesData = res.data;
    renderIssuesTable();
  } catch (err) {
    showToast('Error loading issues: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

function renderIssuesTable() {
  const tbody = document.querySelector('#issues-table tbody');
  if (issuesData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">No issues found</div></td></tr>`;
    return;
  }
  const sorted = [...issuesData].sort((a, b) => Number(b.issueNo) - Number(a.issueNo));
  tbody.innerHTML = sorted.map(i => `
    <tr data-issue-no="${escapeHtml(i.issueNo)}">
      <td><strong>#${i.issueNo}</strong></td>
      <td>${formatDateDisplay(i.issueDate)}</td>
      <td>${escapeHtml(i.machineCategory)}<br><small style="color:var(--text-muted)">${escapeHtml(getMachineNameById(i.machineId))}</small></td>
      <td class="cell-truncate" title="${escapeHtml(i.description)}">${escapeHtml(i.description)}</td>
      <td><span class="badge badge-${classify(i.priority)}">${escapeHtml(i.priority)}</span></td>
      <td>${escapeHtml(i.assignedTo || '-')}</td>
      <td><span class="badge badge-${classify(i.status)}">${escapeHtml(i.status)}</span></td>
      <td>
        <div class="action-cell">
          <button class="btn btn-ghost btn-small btn-icon" data-action="edit" data-id="${escapeHtml(i.issueNo)}" title="Edit">&#9998;</button>
          <button class="btn btn-danger btn-small btn-icon" data-action="delete" data-id="${escapeHtml(i.issueNo)}" title="Delete">&#128465;</button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function openIssueModal(issueNo) {
  let issue = null;
  if (issueNo) {
    showLoading(true);
    try {
      const res = await gsRun('getIssue', issueNo);
      if (!res.success) { showToast(res.message, 'error'); return; }
      issue = res.data;
    } finally { showLoading(false); }
  }

  const priorities = (settingsData['Priorities'] || 'High,Medium,Low').split(',');
  const statuses = (settingsData['Statuses'] || 'Open,In Progress,Closed,Pending Parts,On Hold').split(',');
  const impacts = (settingsData['Impacts'] || 'No Production,Low Production,Not Operational,Minor Impact,No Impact').split(',');
  const engineers = (settingsData['Engineers'] || '').split(',').filter(Boolean);

  const html = `
    <input type="hidden" id="f-issueNo" value="${issue ? escapeHtml(issue.issueNo) : ''}">
    <div class="form-grid">
      <div class="form-field"><label>Issue Date *</label><input type="date" id="f-issueDate" value="${issue ? issue.issueDate : todayISO()}"></div>
      <div class="form-field"><label>Issue Time</label><input type="time" id="f-issueTime" value="${issue ? issue.issueTime : ''}"></div>
      <div class="form-field"><label>Priority</label><select id="f-priority">${optionsHtml(priorities, issue ? issue.priority : 'Medium')}</select></div>

      <div class="form-field"><label>Machine Category *</label><select id="f-machineCategory">
        <option value="">Select Category</option>${optionsHtml(categoriesData, issue ? issue.machineCategory : '')}
      </select></div>
      <div class="form-field"><label>Machine Name</label><select id="f-machineId"><option value="">Select Machine</option></select></div>
      <div class="form-field"><label>Status</label><select id="f-status">${optionsHtml(statuses, issue ? issue.status : 'Open')}</select></div>

      <div class="form-field full"><label>Description of Fault *</label><textarea id="f-description" rows="3">${escapeHtml(issue ? issue.description : '')}</textarea></div>

      <div class="form-field"><label>Impact</label><select id="f-impact">${optionsHtml(impacts, issue ? issue.impact : '')}</select></div>
      <div class="form-field"><label>Reported By</label><input type="text" id="f-reportedBy" value="${escapeHtml(issue ? issue.reportedBy : '')}"></div>
      <div class="form-field"><label>Assigned To</label><input type="text" id="f-assignedTo" value="${escapeHtml(issue ? issue.assignedTo : '')}"></div>

      <div class="form-field"><label>Engineer In Charge</label><select id="f-engineer">
        <option value="">Select Engineer</option>${optionsHtml(engineers, issue ? issue.engineerSign : '')}
      </select></div>

      <div class="form-section-title">Spare Parts &amp; Resolution</div>
      <div class="form-field"><label>Spare Parts Used</label><input type="text" id="f-spareParts" value="${escapeHtml(issue ? issue.spareParts : '')}"></div>
      <div class="form-field"><label>Quantity Used</label><input type="text" id="f-qtyUsed" value="${escapeHtml(issue ? issue.quantityUsed : '')}"></div>
      <div class="form-field"><label>Balance Stock</label><input type="text" id="f-balanceStock" value="${escapeHtml(issue ? issue.balanceStock : '')}"></div>

      <div class="form-field"><label>Resolved Date</label><input type="date" id="f-resolvedDate" value="${issue ? issue.resolvedDate : ''}"></div>
      <div class="form-field"><label>Resolved Time</label><input type="time" id="f-resolvedTime" value="${issue ? issue.resolvedTime : ''}"></div>

      <div class="form-field full"><label>Resolution / Recommendations</label><textarea id="f-resolution" rows="2">${escapeHtml(issue ? issue.resolution : '')}</textarea></div>
      <div class="form-field full"><label>Root Cause</label><textarea id="f-rootCause" rows="2">${escapeHtml(issue ? issue.rootCause : '')}</textarea></div>

      <div class="form-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveIssueForm()">Save Issue</button>
      </div>
    </div>
  `;

  openModal(issue ? 'Edit Issue #' + issue.issueNo : 'New Issue', html);
  document.getElementById('f-machineCategory').addEventListener('change', e => populateMachineIdSelect(e.target.value, 'f-machineId'));
  if (issue && issue.machineCategory) await populateMachineIdSelect(issue.machineCategory, 'f-machineId', issue.machineId);
}

async function saveIssueForm() {
  const val = id => document.getElementById(id).value;
  const issueData = {
    issueNo: val('f-issueNo') || null,
    issueDate: val('f-issueDate'),
    issueTime: val('f-issueTime'),
    machineCategory: val('f-machineCategory'),
    machineId: val('f-machineId'),
    description: val('f-description'),
    impact: val('f-impact'),
    priority: val('f-priority'),
    reportedBy: val('f-reportedBy'),
    assignedTo: val('f-assignedTo'),
    status: val('f-status'),
    spareParts: val('f-spareParts'),
    quantityUsed: val('f-qtyUsed'),
    balanceStock: val('f-balanceStock'),
    resolvedDate: val('f-resolvedDate'),
    resolvedTime: val('f-resolvedTime'),
    resolution: val('f-resolution'),
    rootCause: val('f-rootCause'),
    engineerSign: val('f-engineer')
  };

  if (!issueData.issueDate || !issueData.machineCategory || !issueData.description) {
    showToast('Please fill in Issue Date, Machine Category and Description', 'warning');
    return;
  }

  showLoading(true);
  try {
    const res = await gsRun('saveIssue', issueData);
    if (res.success) {
      showToast(res.message, 'success');
      closeModal();
      loadIssues();
      if (currentView === 'dashboard') loadDashboard();
    } else {
      showToast('Error: ' + res.message, 'error');
    }
  } catch (err) {
    showToast('Error saving issue: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

function deleteIssueConfirm(issueNo) {
  if (confirm('Delete issue #' + issueNo + '? This cannot be undone.')) deleteIssueRun(issueNo);
}
async function deleteIssueRun(issueNo) {
  showLoading(true);
  try {
    const res = await gsRun('deleteIssue', issueNo);
    showToast(res.message, res.success ? 'success' : 'error');
    if (res.success) { loadIssues(); if (currentView === 'dashboard') loadDashboard(); }
  } finally {
    showLoading(false);
  }
}

// ============================================================
// PREVENTIVE MAINTENANCE
// ============================================================
function setupPMListeners() {
  document.getElementById('pm-search').addEventListener('input', debounce(() => { pmUrgencyFilter = null; loadPM(); }, 400));
  document.getElementById('pm-filter-status').addEventListener('change', () => { pmUrgencyFilter = null; loadPM(); });
  document.getElementById('pm-filter-category').addEventListener('change', () => { pmUrgencyFilter = null; loadPM(); });
  document.getElementById('btn-new-pm').addEventListener('click', () => openPMModal(null));

  document.querySelector('#pm-table tbody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (btn) {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (btn.dataset.action === 'edit') openPMModal(id);
      else if (btn.dataset.action === 'delete') deletePMConfirm(id);
      return;
    }
    const row = e.target.closest('tr[data-pm-id]');
    if (row) openPMDetailModal(row.dataset.pmId);
  });
}
let _pmListenersSet = false;

async function loadPM() {
  if (!_pmListenersSet) { setupPMListeners(); _pmListenersSet = true; }
  showLoading(true);
  const filters = {
    search: document.getElementById('pm-search').value,
    status: document.getElementById('pm-filter-status').value,
    machineCategory: document.getElementById('pm-filter-category').value
  };
  try {
    const res = await gsRun('getPMRecords', filters);
    if (!res.success) { showToast('Error loading PM records: ' + res.message, 'error'); return; }
      pmData = res.data;
    if (pmUrgencyFilter === 'due-soon-or-overdue') {
      pmData = pmData.filter(pm => {
        const u = classifyPMUrgency(pm.nextServiceDate);
        return u === 'overdue' || u === 'due-soon';
      });
    }
    renderPMTable();
  } catch (err) {
    showToast('Error loading PM records: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

function renderPMTable() {
  const tbody = document.querySelector('#pm-table tbody');
  if (pmData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">No PM records found</div></td></tr>`;
    return;
  }
  const sorted = [...pmData].sort((a, b) => {
    const aKey = a.status === 'Scheduled' ? (a.scheduleDate || '9999') : (a.nextServiceDate || '9999');
    const bKey = b.status === 'Scheduled' ? (b.scheduleDate || '9999') : (b.nextServiceDate || '9999');
    return aKey.localeCompare(bKey);
  });

  tbody.innerHTML = sorted.map(pm => {
    const isScheduled = pm.status === 'Scheduled';
    const urgency = isScheduled ? classifyPMUrgency(pm.scheduleDate) : classifyPMUrgency(pm.nextServiceDate);
    const rowClass = urgency === 'overdue' ? 'row-overdue' : urgency === 'due-soon' ? 'row-due-soon' : '';
    const dueBadge = urgency === 'overdue' ? '<span class="badge badge-Overdue">Overdue</span>' :
                      urgency === 'due-soon' ? '<span class="badge badge-DueSoon">Due Soon</span>' : '';

    const dateCell = isScheduled
      ? (pm.scheduleDate ? `${formatDateDisplay(pm.scheduleDate)}<br><small>${pmDurationHtml(pm.scheduleDate)}</small>` : '-')
      : (pm.nextServiceDate ? `${formatDateDisplay(pm.nextServiceDate)} ${dueBadge}` : '-');

    return `
      <tr class="${rowClass}" data-pm-id="${escapeHtml(pm.pmId)}">
        <td><strong>${escapeHtml(pm.pmId)}</strong></td>
        <td>${escapeHtml(pm.machineCategory)}<br><small style="color:var(--text-muted)">${escapeHtml(getMachineNameById(pm.machineId))}</small></td>
        <td class="cell-truncate" title="${escapeHtml(pm.comments)}">${escapeHtml(pm.comments)}</td>
        <td>${escapeHtml(pm.serviceType)}</td>
        <td>${dateCell}</td>
        <td>${escapeHtml(pm.maintenanceTeam || '-')}</td>
        <td><span class="badge badge-${classify(pm.status)}">${escapeHtml(pm.status)}</span></td>
        <td>
          <div class="action-cell">
            <button class="btn btn-ghost btn-small btn-icon" data-action="edit" data-id="${escapeHtml(pm.pmId)}" title="Edit">&#9998;</button>
            <button class="btn btn-danger btn-small btn-icon" data-action="delete" data-id="${escapeHtml(pm.pmId)}" title="Delete">&#128465;</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function openPMModal(pmId) {
  let pm = null;
  if (pmId) {
    pm = pmData.find(p => p.pmId === pmId);
    if (!pm) {
      showLoading(true);
      const res = await gsRun('getPMRecord', pmId);
      showLoading(false);
      if (!res.success) { showToast(res.message, 'error'); return; }
      pm = res.data;
    }
  }

  const serviceTypes = (settingsData['Service Types'] || '').split(',').filter(Boolean);
  const engineers = (settingsData['Engineers'] || '').split(',').filter(Boolean);
  const teamMembers = (settingsData['Team Members'] || '').split(',').filter(Boolean);
  const pmStatuses = ['Completed', 'In Progress', 'Scheduled'];
  const doneOptions = ['Done', 'Not Done', 'Partially Done'];
  const frequencyOptions = PM_FREQUENCIES.map(f => f.value);
  const frequencyLabels = {};
  PM_FREQUENCIES.forEach(f => { frequencyLabels[f.value] = f.label; });

  const html = `
    <input type="hidden" id="f-pmId" value="${pm ? escapeHtml(pm.pmId) : ''}">
    <div class="form-grid">
      <div class="form-field"><label>Date *</label><input type="date" id="f-pmDate" value="${pm ? pm.date : todayISO()}"></div>
      <div class="form-field"><label>Machine Category *</label><select id="f-pmCategory">
        <option value="">Select Category</option>${optionsHtml(categoriesData, pm ? pm.machineCategory : '')}
      </select></div>
      <div class="form-field"><label>Machine Name</label><select id="f-pmMachineId"><option value="">Select Machine</option></select></div>

      <div class="form-field"><label>Service Type *</label><select id="f-pmServiceType">
        <option value="">Select Service Type</option>${optionsHtml(serviceTypes, pm ? pm.serviceType : '')}
      </select></div>
      <div class="form-field"><label>General Service Done</label><select id="f-pmGeneralDone">${optionsHtml(doneOptions, pm ? pm.generalServiceDone : 'Done')}</select></div>
      <div class="form-field"><label>Status</label><select id="f-pmStatus">${optionsHtml(pmStatuses, pm ? pm.status : 'Completed')}</select></div>

      <div class="form-field full"><label>Comments / Remarks *</label><textarea id="f-pmComments" rows="4">${escapeHtml(pm ? pm.comments : '')}</textarea></div>

      <div class="form-field"><label>Maintenance Team</label><input type="text" id="f-pmTeam" list="team-members-list" value="${escapeHtml(pm ? pm.maintenanceTeam : '')}" placeholder="e.g. Victor, Bramwel"></div>
      <div class="form-field"><label>Engineer In Charge</label><select id="f-pmEngineer">
        <option value="">Select Engineer</option>${optionsHtml(engineers, pm ? pm.engineerInCharge : '')}
      </select></div>

          <!-- Shown while Status = Scheduled: the planned date to work on the machine. -->
      <div class="form-field" id="pm-schedule-date-wrap">
        <label>Schedule Date *</label>
        <input type="date" id="f-pmScheduleDate" value="${pm ? pm.scheduleDate || '' : ''}">
      </div>

      <!-- Shown only once Status = Completed: Frequency then drives the computed Next Service Date. -->
      <div class="form-field" id="pm-frequency-wrap">
        <label>Frequency</label>
        <select id="f-pmFrequency">
          <option value="">Set Manually</option>
          ${frequencyOptions.map(v => `<option value="${escapeHtml(v)}" ${pm && pm.frequency === v ? 'selected' : ''}>${escapeHtml(frequencyLabels[v])}</option>`).join('')}
        </select>
      </div>
      <div class="form-field" id="pm-next-date-wrap">
        <label>Next Service Date</label>
        <input type="date" id="f-pmNextDate" value="${pm ? pm.nextServiceDate || '' : ''}">
      </div>

      <datalist id="team-members-list">${teamMembers.map(t => `<option value="${escapeHtml(t)}">`).join('')}</datalist>

      <div class="form-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="savePMForm()">Save Record</button>
      </div>
    </div>
  `;

  openModal(pm ? 'Edit PM Record ' + pm.pmId : 'New PM Record', html);
  document.getElementById('f-pmCategory').addEventListener('change', e => populateMachineIdSelect(e.target.value, 'f-pmMachineId'));
  if (pm && pm.machineCategory) await populateMachineIdSelect(pm.machineCategory, 'f-pmMachineId', pm.machineId);

  // Auto-calculate Next Service Date whenever Frequency or Date changes.
  // Next Service Date itself stays a normal editable field, so a value
  // computed this way can still be overridden by hand afterward.
  document.getElementById('f-pmFrequency').addEventListener('change', autoSetPMNextServiceDate);
  document.getElementById('f-pmDate').addEventListener('change', autoSetPMNextServiceDate);
}

async function savePMForm() {
  const val = id => document.getElementById(id).value;
  const status = val('f-pmStatus');
  const isScheduled = status === 'Scheduled';

  const pmDataObj = {
    pmId: val('f-pmId') || null,
    date: val('f-pmDate'),
    machineCategory: val('f-pmCategory'),
    machineId: val('f-pmMachineId'),
    serviceType: val('f-pmServiceType'),
    generalServiceDone: val('f-pmGeneralDone'),
    comments: val('f-pmComments'),
    maintenanceTeam: val('f-pmTeam'),
    engineerInCharge: val('f-pmEngineer'),
    frequency: isScheduled ? '' : val('f-pmFrequency'),
    nextServiceDate: isScheduled ? '' : val('f-pmNextDate'),
    scheduleDate: isScheduled ? val('f-pmScheduleDate') : '',
    status: status
  };

  if (!pmDataObj.date || !pmDataObj.machineCategory || !pmDataObj.serviceType || !pmDataObj.comments) {
    showToast('Please fill in Date, Machine Category, Service Type and Comments', 'warning');
    return;
  }
  if (isScheduled && !pmDataObj.scheduleDate) {
    showToast('Please set a Schedule Date for this scheduled task', 'warning');
    return;
  }

  showLoading(true);
  try {
    const res = await gsRun('savePMRecord', pmDataObj);
    if (res.success) {
      showToast(res.message, 'success');
      closeModal();
      loadPM();
      if (currentView === 'dashboard') loadDashboard();
    } else {
      showToast('Error: ' + res.message, 'error');
    }
  } catch (err) {
    showToast('Error saving PM record: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

function deletePMConfirm(pmId) {
  if (confirm('Delete PM record ' + pmId + '? This cannot be undone.')) deletePMRun(pmId);
}
async function deletePMRun(pmId) {
  showLoading(true);
  try {
    const res = await gsRun('deletePMRecord', pmId);
    showToast(res.message, res.success ? 'success' : 'error');
    if (res.success) { loadPM(); if (currentView === 'dashboard') loadDashboard(); }
  } finally {
    showLoading(false);
  }
}

// ============================================================
// MACHINES
// ============================================================
function setupMachinesListeners() {
  document.getElementById('machine-search').addEventListener('input', debounce(loadMachines, 400));
  document.getElementById('machine-filter-category').addEventListener('change', loadMachines);
  document.getElementById('btn-new-machine').addEventListener('click', () => openMachineModal(null));

  document.getElementById('machines-grid').addEventListener('click', e => {
    const card = e.target.closest('.entity-card[data-id]');
    if (!card) return;
    openMachineModal(card.dataset.id);
  });
}
let _machinesListenersSet = false;

async function loadMachines() {
  if (!_machinesListenersSet) { setupMachinesListeners(); _machinesListenersSet = true; }
  showLoading(true);
  try {
    const res = await gsRun('getAllMachines');
    if (!res.success) { showToast('Error loading machines: ' + res.message, 'error'); return; }
    machinesData = res.data;

    const search = document.getElementById('machine-search').value.toLowerCase();
    const category = document.getElementById('machine-filter-category').value;
    let filtered = machinesData;
    if (search) filtered = filtered.filter(m => (m.id + m.name + m.category).toLowerCase().includes(search));
    if (category && category !== 'All') filtered = filtered.filter(m => m.category === category);

    renderMachinesGrid(filtered);
  } catch (err) {
    showToast('Error loading machines: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

function renderMachinesGrid(machines) {
  const container = document.getElementById('machines-grid');
  if (machines.length === 0) { container.innerHTML = '<div class="empty-state">No machines found</div>'; return; }
  container.innerHTML = machines.map(m => `
    <div class="entity-card" data-id="${escapeHtml(m.id)}">
      <div class="entity-card-top">
        <div>
          <div class="entity-card-name">${escapeHtml(m.name)}</div>
          <div class="entity-card-sub">${escapeHtml(m.id)}</div>
        </div>
        <span class="status-dot ${classify(m.status)}" title="${escapeHtml(m.status)}"></span>
      </div>
      <span class="badge" style="background:var(--bg);color:var(--navy);">${escapeHtml(m.category)}</span>
      <div class="entity-card-sub" style="margin-top:8px;">${escapeHtml(m.location || 'Location not set')}</div>
    </div>
  `).join('');
}

function openMachineModal(machineId) {
  const machine = machineId ? machinesData.find(m => m.id === machineId) : null;
  const locations = (settingsData['Locations'] || '').split(',').filter(Boolean);
  const statuses = ['Active', 'Maintenance', 'Broken', 'Inactive'];

  const html = `
    <input type="hidden" id="f-machineIsNew" value="${machine ? 'false' : 'true'}">
    <div class="form-grid">
      <div class="form-field"><label>Machine ID *</label><input type="text" id="f-machineId2" value="${escapeHtml(machine ? machine.id : '')}" ${machine ? 'readonly' : ''} placeholder="e.g. FWL-020"></div>
      <div class="form-field"><label>Machine Name *</label><input type="text" id="f-machineName" value="${escapeHtml(machine ? machine.name : '')}"></div>
      <div class="form-field"><label>Category *</label><input type="text" id="f-machineCategory2" list="machine-categories-list" value="${escapeHtml(machine ? machine.category : '')}"></div>
      <datalist id="machine-categories-list">${categoriesData.map(c => `<option value="${escapeHtml(c)}">`).join('')}</datalist>
      <div class="form-field"><label>Location</label><input type="text" id="f-machineLocation" list="locations-list" value="${escapeHtml(machine ? machine.location : '')}"></div>
      <datalist id="locations-list">${locations.map(l => `<option value="${escapeHtml(l)}">`).join('')}</datalist>
      <div class="form-field"><label>Manufacturer</label><input type="text" id="f-machineManufacturer" value="${escapeHtml(machine ? machine.manufacturer : '')}"></div>
      <div class="form-field"><label>Model</label><input type="text" id="f-machineModel" value="${escapeHtml(machine ? machine.model : '')}"></div>
      <div class="form-field"><label>Serial Number</label><input type="text" id="f-machineSerial" value="${escapeHtml(machine ? machine.serialNumber : '')}"></div>
      <div class="form-field"><label>Installation Date</label><input type="date" id="f-machineInstallDate" value="${machine ? machine.installationDate : ''}"></div>
      <div class="form-field"><label>Status</label><select id="f-machineStatus">${optionsHtml(statuses, machine ? machine.status : 'Active')}</select></div>
      <div class="form-field full"><label>Notes</label><textarea id="f-machineNotes" rows="2">${escapeHtml(machine ? machine.notes : '')}</textarea></div>

      <div class="form-actions">
        ${machine ? `<button class="btn btn-danger" id="btn-delete-machine" style="margin-right:auto;">Delete</button>` : ''}
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveMachineForm()">Save Machine</button>
      </div>
    </div>
  `;
  openModal(machine ? 'Edit Machine' : 'Add Machine', html);

  if (machine) {
    document.getElementById('btn-delete-machine').addEventListener('click', () => deleteMachineConfirm(machine.id));
  }
}

async function saveMachineForm() {
  const val = id => document.getElementById(id).value;
  const machineData = {
    id: val('f-machineId2'), name: val('f-machineName'), category: val('f-machineCategory2'),
    location: val('f-machineLocation'), manufacturer: val('f-machineManufacturer'), model: val('f-machineModel'),
    serialNumber: val('f-machineSerial'), installationDate: val('f-machineInstallDate'),
    status: val('f-machineStatus'), notes: val('f-machineNotes'),
    isNew: document.getElementById('f-machineIsNew').value === 'true'
  };

  if (!machineData.id || !machineData.name || !machineData.category) {
    showToast('Please fill in Machine ID, Name and Category', 'warning');
    return;
  }

  showLoading(true);
  try {
    const res = await gsRun('saveMachine', machineData);
    if (res.success) {
      showToast(res.message, 'success');
      closeModal();
      const catRes = await gsRun('getMachineCategories');
      if (catRes.success) { categoriesData = catRes.data; populateStaticSelects(); }
      loadMachines();
    } else {
      showToast('Error: ' + res.message, 'error');
    }
  } catch (err) {
    showToast('Error saving machine: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

function deleteMachineConfirm(machineId) {
  if (confirm('Delete machine ' + machineId + '? This cannot be undone.')) deleteMachineRun(machineId);
}
async function deleteMachineRun(machineId) {
  showLoading(true);
  try {
    const res = await gsRun('deleteMachine', machineId);
    showToast(res.message, res.success ? 'success' : 'error');
    if (res.success) { closeModal(); loadMachines(); }
  } finally {
    showLoading(false);
  }
}

// ============================================================
// STAFF
// ============================================================
function setupStaffListeners() {
  document.getElementById('staff-search').addEventListener('input', debounce(loadStaff, 400));
  document.getElementById('staff-filter-status').addEventListener('change', loadStaff);
  document.getElementById('btn-new-staff').addEventListener('click', () => openStaffModal(null));

  document.querySelector('#staff-table tbody').addEventListener('click', e => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'edit') openStaffModal(id);
    else if (btn.dataset.action === 'delete') deleteStaffConfirm(id);
  });
}
let _staffListenersSet = false;

async function loadStaff() {
  if (!_staffListenersSet) { setupStaffListeners(); _staffListenersSet = true; }
  showLoading(true);
  const filters = {
    search: document.getElementById('staff-search').value,
    status: document.getElementById('staff-filter-status').value
  };
  try {
    const res = await gsRun('getStaff', filters);
    if (!res.success) { showToast('Error loading staff: ' + res.message, 'error'); return; }
    staffData = res.data;
    renderStaffTable();
  } catch (err) {
    showToast('Error loading staff: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

function renderStaffTable() {
  const tbody = document.querySelector('#staff-table tbody');
  if (staffData.length === 0) { tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No staff records found</div></td></tr>`; return; }
  tbody.innerHTML = staffData.map(s => `
    <tr>
      <td><strong>${escapeHtml(s.staffId)}</strong></td>
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.role)}</td>
      <td>${escapeHtml(s.department || '-')}</td>
      <td><span class="badge badge-${classify(s.status)}">${escapeHtml(s.status)}</span></td>
      <td>
        <div class="action-cell">
          <button class="btn btn-ghost btn-small btn-icon" data-action="edit" data-id="${escapeHtml(s.staffId)}" title="Edit">&#9998;</button>
          <button class="btn btn-danger btn-small btn-icon" data-action="delete" data-id="${escapeHtml(s.staffId)}" title="Delete">&#128465;</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function openStaffModal(staffId) {
  const staff = staffId ? staffData.find(s => s.staffId === staffId) : null;
  const teamMembers = (settingsData['Team Members'] || '').split(',').filter(Boolean);
  const statuses = ['Active', 'Inactive'];

  const html = `
    <input type="hidden" id="f-staffId" value="${staff ? escapeHtml(staff.staffId) : ''}">
    <div class="form-grid">
      <div class="form-field"><label>Name *</label><input type="text" id="f-staffName" list="staff-name-list" value="${escapeHtml(staff ? staff.name : '')}"></div>
      <datalist id="staff-name-list">${teamMembers.map(t => `<option value="${escapeHtml(t)}">`).join('')}</datalist>
      <div class="form-field"><label>Role *</label><input type="text" id="f-staffRole" value="${escapeHtml(staff ? staff.role : '')}" placeholder="e.g. Technician, Engineer"></div>
      <div class="form-field"><label>Department</label><input type="text" id="f-staffDept" value="${escapeHtml(staff ? staff.department : '')}"></div>
      <div class="form-field"><label>Status</label><select id="f-staffStatus">${optionsHtml(statuses, staff ? staff.status : 'Active')}</select></div>

      <div class="form-actions">
        ${staff ? `<button class="btn btn-danger" id="btn-delete-staff" style="margin-right:auto;">Delete</button>` : ''}
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveStaffForm()">Save Staff</button>
      </div>
    </div>
  `;
  openModal(staff ? 'Edit Staff Member' : 'Add Staff Member', html);

  if (staff) {
    document.getElementById('btn-delete-staff').addEventListener('click', () => deleteStaffConfirm(staff.staffId));
  }
}

async function saveStaffForm() {
  const val = id => document.getElementById(id).value;
  const staffDataObj = {
    staffId: val('f-staffId') || null,
    name: val('f-staffName'), role: val('f-staffRole'),
    department: val('f-staffDept'), status: val('f-staffStatus')
  };

  if (!staffDataObj.name || !staffDataObj.role) {
    showToast('Please fill in Name and Role', 'warning');
    return;
  }

  showLoading(true);
  try {
    const res = await gsRun('saveStaffMember', staffDataObj);
    if (res.success) { showToast(res.message, 'success'); closeModal(); loadStaff(); }
    else showToast('Error: ' + res.message, 'error');
  } catch (err) {
    showToast('Error saving staff: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

function deleteStaffConfirm(staffId) {
  if (confirm('Delete this staff member? This cannot be undone.')) deleteStaffRun(staffId);
}
async function deleteStaffRun(staffId) {
  showLoading(true);
  try {
    const res = await gsRun('deleteStaffMember', staffId);
    showToast(res.message, res.success ? 'success' : 'error');
    if (res.success) { closeModal(); loadStaff(); }
  } finally {
    showLoading(false);
  }
}

// ============================================================
// REPORTS
// ============================================================
const REPORT_COLUMNS = {
  issues: [['issueNo', 'Issue No.'], ['issueDate', 'Date'], ['machineCategory', 'Machine'], ['description', 'Description'], ['priority', 'Priority'], ['status', 'Status'], ['resolution', 'Resolution']],
   pm: [['pmId', 'PM ID'], ['date', 'Date Logged'], ['machineCategory', 'Machine'], ['serviceType', 'Service Type'], ['scheduleDate', 'Schedule Date'], ['frequency', 'Frequency'], ['maintenanceTeam', 'Team'], ['nextServiceDate', 'Next Service'], ['status', 'Status']],
  machine: [['id', 'Machine ID'], ['name', 'Name'], ['category', 'Category'], ['location', 'Location'], ['status', 'Status']],
  staff: [['staffId', 'Staff ID'], ['name', 'Name'], ['role', 'Role'], ['department', 'Department'], ['status', 'Status']]
};

async function generateReportView(type) {
  showLoading(true);
  try {
    const res = await gsRun('generateReport', type, {});
    if (!res.success) { showToast('Error generating report: ' + res.message, 'error'); return; }

    document.getElementById('report-title').textContent = res.title;
    const cols = REPORT_COLUMNS[type];
    const thead = '<thead><tr>' + cols.map(c => `<th>${c[1]}</th>`).join('') + '</tr></thead>';
    const tbody = '<tbody>' + res.data.map(row => {
      return '<tr>' + cols.map(c => {
        let v = row[c[0]] ?? '-';
        if (c[0] === 'frequency') v = pmFrequencyLabel(v) || '-';
        return `<td>${escapeHtml(v)}</td>`;
      }).join('') + '</tr>';
    }).join('') + '</tbody>';

    document.getElementById('report-content').innerHTML = `<table class="table">${thead}${tbody}</table>`;
    document.getElementById('report-output').style.display = 'block';
    document.getElementById('report-output').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showToast('Error generating report: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

// ============================================================
// SUMMARY REPORT
// ============================================================
async function generateSummaryReport() {
  showLoading(true);
  try {
    const res = await gsRun('getSummaryReport');
    if (!res.success) { showToast('Error: ' + res.message, 'error'); return; }
    const d = res.data;

    const kpi = (label, value) =>
      `<div class="kpi-card"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value">${value}</div></div>`;

    const kpiHtml = `<div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px;">
      ${kpi('Total Resolved Issues', d.kpis.totalResolved)}
      ${kpi('Total PM Records', d.kpis.totalPMRecords)}
      ${kpi('Avg Resolution (days)', d.kpis.avgResolutionDays)}
      ${kpi('Closed This Year', d.kpis.closedThisYear)}
    </div>`;

    const partsTable = d.topParts.length === 0 ? '<div class="empty-state">No spare parts recorded</div>' :
      `<table class="table"><thead><tr><th>Spare Part</th><th>Times Used</th><th>Total Qty</th></tr></thead>
        <tbody>${d.topParts.map(p => `<tr><td>${escapeHtml(p.part)}</td><td>${p.count}</td><td>${p.totalQty || '-'}</td></tr>`).join('')}</tbody>
      </table>`;

    const rcTable = d.topRootCauses.length === 0 ? '<div class="empty-state">No root causes recorded</div>' :
      `<table class="table"><thead><tr><th>Root Cause</th><th>Occurrences</th></tr></thead>
        <tbody>${d.topRootCauses.map(r => `<tr><td>${escapeHtml(r.rootCause)}</td><td>${r.count}</td></tr>`).join('')}</tbody>
      </table>`;

    const resolvedRows = d.resolvedIssues.map(i => `
      <tr>
        <td><strong>#${escapeHtml(i.issueNo)}</strong></td>
        <td>${formatDateDisplay(i.issueDate)}</td>
        <td>${formatDateDisplay(i.resolvedDate)}</td>
        <td>${escapeHtml(i.machineCategory)} ${i.machineId ? '(' + escapeHtml(getMachineNameById(i.machineId)) + ')' : ''}</td>
        <td class="cell-truncate" title="${escapeHtml(i.description)}">${escapeHtml(i.description)}</td>
        <td>${escapeHtml(i.spareParts || '-')}</td>
        <td>${escapeHtml(i.rootCause || '-')}</td>
        <td class="cell-truncate" title="${escapeHtml(i.resolution)}">${escapeHtml(i.resolution || '-')}</td>
        <td>${escapeHtml(i.engineerSign || '-')}</td>
      </tr>`).join('');

    const resolvedTable = d.resolvedIssues.length === 0 ? '<div class="empty-state">No resolved issues yet</div>' :
      `<table class="table">
        <thead><tr>
          <th>Issue</th><th>Reported</th><th>Resolved</th><th>Machine</th>
          <th>Fault</th><th>Spare Parts</th><th>Root Cause</th>
          <th>Resolution / Recommendations</th><th>Engineer</th>
        </tr></thead>
        <tbody>${resolvedRows}</tbody>
      </table>`;

    const pmRows = d.pmRecords.map(p => `
      <tr>
        <td><strong>${escapeHtml(p.pmId)}</strong></td>
        <td>${formatDateDisplay(p.date)}</td>
        <td>${escapeHtml(p.machineCategory)} ${p.machineId ? '(' + escapeHtml(getMachineNameById(p.machineId)) + ')' : ''}</td>
        <td>${escapeHtml(p.serviceType)}</td>
        <td>${escapeHtml(p.generalServiceDone || '-')}</td>
        <td>${escapeHtml(pmFrequencyLabel(p.frequency) || '-')}</td>
        <td>${escapeHtml(p.maintenanceTeam || '-')}</td>
        <td>${escapeHtml(p.engineerInCharge || '-')}</td>
        <td>${p.nextServiceDate ? formatDateDisplay(p.nextServiceDate) : '-'}</td>
        <td>${escapeHtml(p.status)}</td>
        <td class="cell-truncate" title="${escapeHtml(p.comments)}">${escapeHtml(p.comments || '-')}</td>
      </tr>`).join('');

    const pmTable = d.pmRecords.length === 0 ? '<div class="empty-state">No PM records yet</div>' :
      `<table class="table">
        <thead><tr>
          <th>PM ID</th><th>Date</th><th>Machine</th><th>Service Type</th>
          <th>Service Done</th><th>Frequency</th><th>Team</th><th>Engineer</th>
          <th>Next Service</th><th>Status</th><th>Comments / Remarks</th>
        </tr></thead>
        <tbody>${pmRows}</tbody>
      </table>`;

    document.getElementById('report-title').textContent = 'Maintenance Summary Report';
    document.getElementById('report-content').innerHTML = `
      <div style="padding:4px 0 12px;color:var(--text-muted);font-size:12px;">
        Generated: ${new Date(d.generatedAt).toLocaleString('en-GB')}
      </div>
      ${kpiHtml}
      <div class="card"><div class="card-title">Resolved Issues — Full Detail</div>${resolvedTable}</div>
      <div class="card"><div class="card-title">Preventive Maintenance — Full History</div>${pmTable}</div>
      <div class="grid-2">
        <div class="card"><div class="card-title">Top Spare Parts Used</div>${partsTable}</div>
        <div class="card"><div class="card-title">Top Root Causes</div>${rcTable}</div>
      </div>
    `;
    document.getElementById('report-output').style.display = 'block';
    document.getElementById('report-output').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showToast('Error generating summary: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

// ============================================================
// MACHINE HISTORY REPORT
// ============================================================

// Populates the machine picker on the Reports view. Fetches the machine
// list fresh only if it hasn't already been loaded (e.g. via Machines view).
async function populateMachineHistorySelect() {
  const select = document.getElementById('machine-history-select');
  if (!select) return;

  let machines = machinesData;
  if (!machines || machines.length === 0) {
    try {
      const res = await gsRun('getAllMachines');
      if (res.success) { machines = res.data; machinesData = res.data; }
    } catch (err) {
      console.error(err);
      return;
    }
  }

  const currentValue = select.value;
  const sorted = [...machines].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  select.innerHTML = '<option value="">Select Machine...</option>' +
    sorted.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} (${escapeHtml(m.id)})</option>`).join('');
  if (currentValue) select.value = currentValue;
}

async function generateMachineHistoryReport() {
  const machineId = document.getElementById('machine-history-select').value;
  if (!machineId) { showToast('Please select a machine first', 'warning'); return; }

  showLoading(true);
  try {
    const res = await gsRun('getMachineHistory', machineId);
    if (!res.success) { showToast('Error: ' + res.message, 'error'); return; }
    const d = res.data;

    const kpi = (label, value) =>
      `<div class="kpi-card"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value">${value}</div></div>`;

    const kpiHtml = `<div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px;">
      ${kpi('Total Issues', d.totalIssues)}
      ${kpi('Open Issues', d.openIssues)}
      ${kpi('Closed Issues', d.closedIssues)}
      ${kpi('PM Services', d.totalPM)}
    </div>`;

    const timelineRows = d.timeline.map(t => `
      <tr class="history-row" onclick="viewHistoryItem('${t.type}', '${escapeHtml(t.id)}')">
        <td>${formatDateDisplay(t.date)}</td>
        <td><span class="badge badge-${t.type}">${t.type === 'Issue' ? 'Issue' : 'PM'}</span></td>
        <td><strong>${escapeHtml(t.id)}</strong></td>
        <td class="cell-truncate" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</td>
        <td>${t.status ? `<span class="badge badge-${classify(t.status)}">${escapeHtml(t.status)}</span>` : '-'}</td>
        <td class="cell-truncate" title="${escapeHtml(t.detail)}">${escapeHtml(t.detail || '-')}</td>
      </tr>
    `).join('');

    const timelineTable = d.timeline.length === 0 ? '<div class="empty-state">No history recorded for this machine yet</div>' :
      `<table class="table">
        <thead><tr><th>Date</th><th>Type</th><th>ID</th><th>Title</th><th>Status</th><th>Detail</th></tr></thead>
        <tbody>${timelineRows}</tbody>
      </table>`;

    document.getElementById('report-title').textContent = 'Machine History — ' + d.machineName + ' (' + d.machineId + ')';
    document.getElementById('report-content').innerHTML = `
      <div style="padding:4px 0 12px;color:var(--text-muted);font-size:12px;">
        Category: ${escapeHtml(d.machineCategory || '-')}${d.machineLocation ? ' &middot; Location: ' + escapeHtml(d.machineLocation) : ''}${d.machineStatus ? ' &middot; Status: ' + escapeHtml(d.machineStatus) : ''}
      </div>
      ${kpiHtml}
      <div class="card"><div class="card-title">Full Activity Timeline (click a row for details)</div>${timelineTable}</div>
    `;
    document.getElementById('report-output').style.display = 'block';
    document.getElementById('report-output').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showToast('Error generating machine history: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

// Opens the existing read-only Issue/PM detail modal for a row clicked in
// the Machine History timeline. Fetches the single record fresh (it may not
// be present in the currently-loaded issuesData/pmData arrays) and merges
// it in before opening, so the existing modal functions can find it.
async function viewHistoryItem(type, id) {
  showLoading(true);
  try {
    if (type === 'Issue') {
      const res = await gsRun('getIssue', id);
      if (!res.success) { showToast(res.message, 'error'); return; }
      issuesData = issuesData.filter(i => i.issueNo !== id).concat([res.data]);
      openIssueDetailModal(id);
    } else {
      const res = await gsRun('getPMRecord', id);
      if (!res.success) { showToast(res.message, 'error'); return; }
      pmData = pmData.filter(p => p.pmId !== id).concat([res.data]);
      openPMDetailModal(id);
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

// ============================================================
// SETTINGS
// ============================================================
function loadSettingsPage() {
  const container = document.getElementById('settings-form');
  const priorities = (settingsData['Priorities'] || 'High,Medium,Low').split(',');

  container.innerHTML = `
    <div class="form-field" style="margin-bottom:12px;"><label>Company Name</label><input type="text" value="${escapeHtml(settingsData['Company Name'] || '')}" readonly></div>
    <div class="form-field" style="margin-bottom:12px;"><label>System Version</label><input type="text" value="${escapeHtml(settingsData['System Version'] || '')}" readonly></div>
    <div class="form-field" style="margin-bottom:12px;"><label>Notification Email</label><input type="email" id="set-notification-email" value="${escapeHtml(settingsData['Notification Email'] || '')}"></div>
    <div class="form-field" style="margin-bottom:12px;"><label>Default Priority</label><select id="set-default-priority">${optionsHtml(priorities, settingsData['Default Priority'])}</select></div>
    <button class="btn btn-primary" id="btn-save-settings">Save Settings</button>
  `;
  document.getElementById('btn-save-settings').addEventListener('click', saveSettingsForm);

  const dbContainer = document.getElementById('database-info');
  dbContainer.innerHTML = `
    <div class="mini-item"><div>Total Issues</div><strong>${issuesData.length}</strong></div>
    <div class="mini-item"><div>Total PM Records</div><strong>${pmData.length}</strong></div>
    <div class="mini-item"><div>Total Machines</div><strong>${machinesData.length}</strong></div>
    <div class="mini-item"><div>Total Staff</div><strong>${staffData.length}</strong></div>
    <div class="mini-item-sub" style="margin-top:10px;">Database: Google Sheets &middot; Steelwool Africa Maintenance Management System</div>
  `;
}

async function saveSettingsForm() {
  const payload = {
    'Notification Email': document.getElementById('set-notification-email').value,
    'Default Priority': document.getElementById('set-default-priority').value
  };
  showLoading(true);
  try {
    const res = await gsRun('saveSettings', payload);
    if (res.success) {
      Object.assign(settingsData, payload);
      showToast(res.message, 'success');
    } else {
      showToast('Error: ' + res.message, 'error');
    }
  } catch (err) {
    showToast('Error saving settings: ' + err.message, 'error');
  } finally {
    showLoading(false);
  }
}

// ============================================================
// DEBOUNCE
// ============================================================
function debounce(fn, wait) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

function togglePMDateFields() {
  const status = document.getElementById('f-pmStatus').value;
  const isScheduled = status === 'Scheduled';
  document.getElementById('pm-schedule-date-wrap').style.display = isScheduled ? '' : 'none';
  document.getElementById('pm-frequency-wrap').style.display = isScheduled ? 'none' : '';
  document.getElementById('pm-next-date-wrap').style.display = isScheduled ? 'none' : '';
  if (!isScheduled) autoSetPMNextServiceDate();
}
