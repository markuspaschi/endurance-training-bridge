const state = {
  apiUrl: '',
  apiKey: '',
  athleteId: '',
  athleteName: '',
  period: { weeks: 2 },
  trainingData: null
};

const elements = {};
const byId = id => document.getElementById(id);

function generateAccessKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  return `etb_${encoded}`;
}

function getApiUrl() {
  if (['localhost', '127.0.0.1'].includes(window.location.hostname) && window.location.port === '8081') {
    return 'http://localhost:8080';
  }
  return `${window.location.origin}/api`;
}

function setStatus(element, message, status = 'idle') {
  element.textContent = message;
  element.dataset.state = status;
}

function readConnectionFields() {
  const apiKey = elements.apiKey.value.trim();
  if (!apiKey) throw new Error('Enter your private connection key.');
  state.apiUrl = getApiUrl();
  state.apiKey = apiKey;
  localStorage.setItem('enduranceMcpAccessKey', apiKey);
}

async function apiRequest(path, options = {}) {
  readConnectionFields();
  const response = await fetch(`${state.apiUrl}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${state.apiKey}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Server returned ${response.status} without a JSON response.`);
  }
  if (!response.ok || body.error) {
    throw new Error(body.error?.message || `Request failed (${response.status}).`);
  }
  return body;
}

function updateHelperCommand() {
  const scriptUrl = `${window.location.origin}/garmin-pair.py`;
  const uploadUrl = `${getApiUrl()}/auth/garmin/tokens`;
  elements.helperCommand.textContent = navigator.userAgent.includes('Windows')
    ? `curl.exe -fsSLo garmin-pair.py ${scriptUrl}; py garmin-pair.py --upload-url ${uploadUrl}`
    : `curl -fsSLo garmin-pair.py ${scriptUrl} && python3 garmin-pair.py --upload-url ${uploadUrl}`;
}

function showConnected(name, athleteId) {
  state.athleteName = name || 'Garmin athlete';
  state.athleteId = athleteId;
  localStorage.setItem('enduranceMcpAthleteId', athleteId);
  elements.athleteName.textContent = state.athleteName;
  elements.athleteMeta.textContent = `Garmin Connect · ${athleteId}`;
  elements.athleteCard.classList.remove('hidden');
  elements.connectionBadge.dataset.state = 'connected';
  elements.connectionBadge.querySelector('b').textContent = 'Connected';
  elements.fetchButton.disabled = false;
  elements.deleteButton.disabled = false;
}

function forgetLocalConnection() {
  state.athleteId = '';
  state.athleteName = '';
  state.trainingData = null;
  localStorage.removeItem('enduranceMcpAthleteId');
  localStorage.removeItem('enduranceMcpAccessKey');
  const replacementKey = generateAccessKey();
  state.apiKey = replacementKey;
  elements.apiKey.value = replacementKey;
  localStorage.setItem('enduranceMcpAccessKey', replacementKey);
  elements.athleteCard.classList.add('hidden');
  elements.connectionBadge.dataset.state = 'idle';
  elements.connectionBadge.querySelector('b').textContent = 'Not connected';
  elements.fetchButton.disabled = true;
  elements.deleteButton.disabled = true;
  elements.result.classList.add('hidden');
  setStatus(elements.analysisStatus, '');
}

async function connect(event) {
  event?.preventDefault();
  const athleteId = state.athleteId || localStorage.getItem('enduranceMcpAthleteId') || '';

  elements.connectButton.disabled = true;
  setStatus(elements.serverStatus, 'Verifying Garmin connection…');
  try {
    const query = athleteId ? `?athleteId=${encodeURIComponent(athleteId)}` : '';
    const body = await apiRequest(`/auth/garmin/status${query}`);
    if (!body.connected) throw new Error(body.error || 'No valid Garmin session is stored for this athlete.');
    showConnected(body.athleteName, body.athleteId);
    setStatus(elements.serverStatus, 'Garmin connection verified.', 'success');
  } catch (error) {
    setStatus(elements.serverStatus, error.message, 'error');
  } finally {
    elements.connectButton.disabled = false;
  }
}

function selectPeriod(event) {
  const button = event.target.closest('button');
  if (!button) return;
  elements.periodOptions.querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button));
  state.period = button.dataset.days
    ? { days: Number(button.dataset.days) }
    : { weeks: Number(button.dataset.weeks) };
}

function formatNumber(value, suffix = '') {
  return `${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}`;
}

function buildPrompt(data) {
  const totals = data.totals || {};
  const averages = data.weekly_averages || {};
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const periodLabel = state.period.days ? `${state.period.days} day` : `${state.period.weeks} week${state.period.weeks === 1 ? '' : 's'}`;
  const lines = [
    `ENDURANCE TRAINING BRIEF — ${periodLabel}`,
    `Period: ${data.period?.start_date || 'unknown'} to ${data.period?.end_date || 'unknown'}`,
    '',
    'TOTALS',
    `Sessions: ${totals.total_sessions || 0}`,
    `Training time: ${formatNumber(totals.total_duration_hours, ' h')}`,
    `Distance: ${formatNumber(totals.total_distance_km, ' km')}`,
    `Elevation: ${formatNumber(totals.total_elevation_m, ' m')}`,
    `Estimated TSS: ${formatNumber(totals.total_tss)}`
  ];

  if (!state.period.days) {
    lines.push(
      '', 'WEEKLY AVERAGES',
      `Sessions: ${formatNumber(averages.sessions_per_week)}`,
      `Training time: ${formatNumber(averages.hours_per_week, ' h')}`,
      `Bike: ${formatNumber(averages.bike_hours_per_week, ' h')}`,
      `Run: ${formatNumber(averages.run_km_per_week, ' km')}`,
      `Swims: ${formatNumber(averages.swim_sessions_per_week)}`
    );
  }

  if (elements.includeSessions.checked) {
    lines.push('', 'SESSIONS');
    sessions.forEach((session, index) => {
      lines.push(
        `${index + 1}. ${session.title || 'Untitled activity'} — ${(session.date || '').split('T')[0] || 'unknown date'}`,
        `   ${session.discipline || session.type || 'Workout'} · ${formatNumber(session.duration_minutes, ' min')} · ${formatNumber(session.distance_km, ' km')} · intensity ${session.intensity || 'unknown'}`
      );
      if (session.heart_rate?.average) lines.push(`   HR ${session.heart_rate.average} avg / ${session.heart_rate.max || '—'} max bpm`);
      if (session.average_watts) lines.push(`   Power ${session.average_watts} W avg`);
      if (elements.includeHr.checked && session.samples?.heart_rate) lines.push(`   HR samples: ${session.samples.heart_rate.join(', ')}`);
      if (elements.includeSpeed.checked && session.samples?.speed) lines.push(`   Speed samples (m/s): ${session.samples.speed.join(', ')}`);
    });
  }

  if (elements.includeCoaching.checked) {
    lines.push(
      '', 'COACHING REQUEST',
      'Act as an experienced endurance coach. Assess load, discipline balance, intensity distribution, progression, recovery, and injury risk. State data limitations. Give 3–5 specific recommendations for the next week. Do not provide medical diagnosis.'
    );
  }
  return lines.join('\n');
}

function renderResult(data) {
  const totals = data.totals || {};
  const stats = [
    [totals.total_sessions || 0, 'SESSIONS'],
    [formatNumber(totals.total_duration_hours, ' h'), 'TRAINING TIME'],
    [formatNumber(totals.total_distance_km, ' km'), 'DISTANCE']
  ];
  elements.summaryStats.replaceChildren(...stats.map(([value, label]) => {
    const card = document.createElement('div');
    card.className = 'stat';
    const strong = document.createElement('b');
    strong.textContent = value;
    const caption = document.createElement('span');
    caption.textContent = label;
    card.append(strong, caption);
    return card;
  }));
  elements.promptOutput.textContent = buildPrompt(data);
  elements.result.classList.remove('hidden');
  elements.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function fetchTrainingData() {
  if (!state.athleteId) return;
  elements.fetchButton.disabled = true;
  setStatus(elements.analysisStatus, 'Fetching and normalizing recent activities…');
  try {
    const body = await apiRequest('/mcp', {
      method: 'POST',
      body: JSON.stringify({
        tool: 'getWeeklyTrainingSummary',
        arguments: { athleteId: state.athleteId, source: 'garmin', ...state.period }
      })
    });
    state.trainingData = body.result;
    renderResult(body.result);
    setStatus(elements.analysisStatus, 'Training brief generated.', 'success');
  } catch (error) {
    setStatus(elements.analysisStatus, error.message, 'error');
  } finally {
    elements.fetchButton.disabled = !state.athleteId;
  }
}

async function deleteServerData() {
  if (!state.athleteId) return;
  if (!window.confirm('Delete this athlete’s Garmin session and cached activities from the configured server?')) return;
  elements.deleteButton.disabled = true;
  try {
    await apiRequest('/auth/garmin/disconnect', {
      method: 'POST',
      body: JSON.stringify({ athleteId: state.athleteId })
    });
    forgetLocalConnection();
    setStatus(elements.serverStatus, 'Garmin data deleted from the server.', 'success');
  } catch (error) {
    setStatus(elements.analysisStatus, error.message, 'error');
    elements.deleteButton.disabled = false;
  }
}

async function copyText(text, button, confirmation) {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = confirmation;
    window.setTimeout(() => { button.textContent = original; }, 1600);
  } catch {
    setStatus(elements.serverStatus, 'Clipboard access was denied.', 'error');
  }
}

function initialize() {
  Object.assign(elements, {
    apiKey: byId('api-key'),
    helperCommand: byId('helper-command'), serverStatus: byId('server-status'),
    analysisStatus: byId('analysis-status'), connectionBadge: byId('connection-badge'),
    athleteCard: byId('athlete-card'), athleteName: byId('athlete-name'), athleteMeta: byId('athlete-meta'),
    connectButton: byId('connect-button'), fetchButton: byId('fetch-button'), deleteButton: byId('delete-button'),
    periodOptions: byId('period-options'), includeSessions: byId('include-sessions'),
    includeCoaching: byId('include-coaching'), includeHr: byId('include-hr'), includeSpeed: byId('include-speed'),
    result: byId('result'), summaryStats: byId('summary-stats'), promptOutput: byId('prompt-output')
  });

  const savedKey = localStorage.getItem('enduranceMcpAccessKey');
  elements.apiKey.value = savedKey || generateAccessKey();
  localStorage.setItem('enduranceMcpAccessKey', elements.apiKey.value);
  state.athleteId = localStorage.getItem('enduranceMcpAthleteId') || '';
  updateHelperCommand();

  byId('connection-form').addEventListener('submit', connect);
  byId('copy-key').addEventListener('click', event => copyText(elements.apiKey.value, event.currentTarget, 'Copied'));
  byId('toggle-key').addEventListener('click', event => {
    const showing = elements.apiKey.type === 'text';
    elements.apiKey.type = showing ? 'password' : 'text';
    event.currentTarget.textContent = showing ? 'Show' : 'Hide';
    event.currentTarget.setAttribute('aria-label', showing ? 'Show API key' : 'Hide API key');
  });
  elements.periodOptions.addEventListener('click', selectPeriod);
  elements.fetchButton.addEventListener('click', fetchTrainingData);
  elements.deleteButton.addEventListener('click', deleteServerData);
  byId('forget-button').addEventListener('click', forgetLocalConnection);
  byId('copy-command').addEventListener('click', async event => {
    await copyText(elements.helperCommand.textContent, event.currentTarget, 'Copied');
    setStatus(elements.serverStatus, 'Command copied. Run it in Terminal, complete Garmin login, then return here.', 'success');
  });
  byId('copy-prompt').addEventListener('click', event => copyText(elements.promptOutput.textContent, event.currentTarget, 'Copied'));

  if (state.athleteId && savedKey) connect();
}

document.addEventListener('DOMContentLoaded', initialize);
