'use strict';

// ─── CONSTANTS ─────────────────────────────────────────────────────────────
const PH_BOUNDS = [[4.5, 116.0], [21.5, 127.0]];
const PH_CENTER = [12.5, 122.0];
const REFRESH_INTERVAL = 30 * 1000; // 30s
const VOTED_KEY = 'ph_outage_voted'; // localStorage key for voted IDs

// ─── STATE ──────────────────────────────────────────────────────────────────
const state = {
  outages: [],
  stats: { byRegion: [], total: 0 },
  selectedLat: null,
  selectedLng: null,
  pendingMarker: null,
  markerMap: new Map(),   // id -> leaflet marker
  votedIds: new Set(JSON.parse(localStorage.getItem(VOTED_KEY) || '[]')),
  refreshTimer: null,
};

// ─── MAP INIT ───────────────────────────────────────────────────────────────
const map = L.map('map', {
  center: PH_CENTER,
  zoom: 6,
  minZoom: 5,
  maxZoom: 17,
  maxBounds: [[0, 110], [25, 133]],
  maxBoundsViscosity: 0.8,
  zoomControl: true,
});

// Dark tile layer
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> contributors &copy; <a href="https://carto.com">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 19,
}).addTo(map);

// Marker cluster group
const clusterGroup = L.markerClusterGroup({
  maxClusterRadius: 50,
  disableClusteringAtZoom: 12,
});
map.addLayer(clusterGroup);

// ─── MARKER ICONS ───────────────────────────────────────────────────────────
function makeIcon(type, upvotes) {
  const color = type === 'planned' ? '#6366f1' : '#f59e0b';
  const size = Math.min(28 + Math.floor(upvotes / 2), 44);
  const opacity = Math.min(0.6 + upvotes * 0.08, 1);
  return L.divIcon({
    className: '',
    html: `<div style="
      width:${size}px;height:${size}px;
      background:${color};
      border-radius:50%;
      border:2.5px solid rgba(255,255,255,0.5);
      box-shadow:0 0 ${8 + upvotes * 2}px ${color};
      opacity:${opacity};
      display:flex;align-items:center;justify-content:center;
      font-size:${size < 32 ? 11 : 13}px;font-weight:700;color:#000;
    ">${upvotes > 0 ? upvotes : '!'}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2)],
  });
}

const pendingIcon = L.divIcon({
  className: '',
  html: `<div style="
    width:28px;height:28px;background:#ef4444;
    border-radius:50%;border:3px solid #fff;
    box-shadow:0 0 12px #ef4444;
    animation:pulse 1s infinite alternate;
  "></div>
  <style>@keyframes pulse{from{transform:scale(1)}to{transform:scale(1.2)}}</style>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

// ─── TIME UTILITIES ─────────────────────────────────────────────────────────
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function timeLeft(isoExpires) {
  const diff = new Date(isoExpires).getTime() - Date.now();
  if (diff <= 0) return 'expired';
  const hrs = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (hrs > 0) return `expires in ${hrs}h ${mins}m`;
  return `expires in ${mins}m`;
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('en-PH', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: true
  });
}

// ─── API ────────────────────────────────────────────────────────────────────
async function apiGet(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// ─── SOURCE HELPERS ──────────────────────────────────────────────────────────
const SOURCE_META = {
  crowdsourced:  { label: 'Community', color: '#7b82a0', icon: '👥' },
  meralco:       { label: 'Meralco',   color: '#f59e0b', icon: '⚡' },
  veco:          { label: 'VECO',      color: '#22c55e', icon: '⚡' },
  dlpc:          { label: 'DLPC',      color: '#3b82f6', icon: '⚡' },
  'outage.report': { label: 'Outage.Report', color: '#ef4444', icon: '📡' },
};

function sourceMeta(source) {
  return SOURCE_META[source] || SOURCE_META.crowdsourced;
}

// ─── RENDER ─────────────────────────────────────────────────────────────────
function renderOutageCard(o) {
  const location = [o.barangay, o.city, o.province].filter(Boolean).join(', ') || `${o.lat.toFixed(4)}, ${o.lng.toFixed(4)}`;
  const src = sourceMeta(o.source);
  const div = document.createElement('div');
  div.className = `outage-card ${o.type}`;
  div.dataset.id = o.id;
  div.innerHTML = `
    <div class="card-top">
      <div class="card-location">${escHtml(location)}</div>
      <span class="card-badge badge-${o.type}">${o.type}</span>
    </div>
    <div class="card-region-row">
      <span class="card-region">${escHtml(o.region)}</span>
      <span class="card-source" style="color:${src.color}">${src.icon} ${escHtml(src.label)}</span>
    </div>
    ${o.description ? `<div class="card-desc">${escHtml(o.description)}</div>` : ''}
    <div class="card-footer">
      <span class="card-time">${timeAgo(o.reported_at)}</span>
      <span class="card-upvotes">
        <span class="check">✓</span> ${o.upvotes} confirmed
      </span>
    </div>
  `;
  div.addEventListener('click', () => {
    map.setView([o.lat, o.lng], 14);
    showDetailPanel(o);
  });
  return div;
}

function renderFeed() {
  const list = document.getElementById('outage-list');
  const countEl = document.getElementById('feed-count');

  if (state.outages.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✅</div>
        <div class="empty-title">No active outages reported</div>
        <div class="empty-sub">Be the first to report if your area has no power</div>
      </div>
    `;
    countEl.textContent = '0 active reports';
    return;
  }

  countEl.textContent = `${state.outages.length} active report${state.outages.length !== 1 ? 's' : ''}`;
  list.innerHTML = '';
  state.outages.forEach(o => list.appendChild(renderOutageCard(o)));
}

function renderStats() {
  const container = document.getElementById('stats-container');
  const { byRegion, total } = state.stats;

  if (byRegion.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📊</div>
        <div class="empty-title">No data yet</div>
        <div class="empty-sub">Stats will appear once outages are reported</div>
      </div>
    `;
    return;
  }

  const max = Math.max(...byRegion.map(r => r.count));
  container.innerHTML = `<div class="stats-header">${total} active outage${total !== 1 ? 's' : ''} across the Philippines</div>`;

  byRegion.forEach(r => {
    const pct = max > 0 ? (r.count / max) * 100 : 0;
    const div = document.createElement('div');
    div.className = 'region-stat';
    div.innerHTML = `
      <div class="region-name">${escHtml(r.region)}</div>
      <div class="region-bar-wrap">
        <div class="region-bar" style="width:${pct}%"></div>
      </div>
      <div class="region-meta">
        <span>${r.count} outage${r.count !== 1 ? 's' : ''}</span>
        <span>${r.total_upvotes || 0} confirmations</span>
      </div>
    `;
    container.appendChild(div);
  });
}

function renderMarkers() {
  // Remove old markers
  clusterGroup.clearLayers();
  state.markerMap.clear();

  state.outages.forEach(o => {
    const marker = L.marker([o.lat, o.lng], { icon: makeIcon(o.type, o.upvotes) });
    const location = [o.barangay, o.city, o.province].filter(Boolean).join(', ') || 'Philippines';
    marker.bindPopup(`
      <div style="min-width:160px;font-size:13px">
        <strong style="font-size:14px">${escHtml(location)}</strong>
        <div style="margin:4px 0;color:#7b82a0;font-size:11px">${escHtml(o.region)}</div>
        <div style="color:${o.type === 'planned' ? '#6366f1' : '#f59e0b'};font-weight:700;font-size:11px;text-transform:uppercase">${o.type}</div>
        ${o.description ? `<div style="margin-top:6px;color:#7b82a0">${escHtml(o.description)}</div>` : ''}
        <div style="margin-top:8px;font-size:11px;color:#4a5168">${timeAgo(o.reported_at)} · ${o.upvotes} confirmed</div>
        <button onclick="showDetailFromMap('${o.id}')" style="
          margin-top:8px;width:100%;padding:6px;background:#f59e0b;color:#000;
          border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px
        ">View Details</button>
      </div>
    `, { maxWidth: 240 });
    marker.on('click', () => showDetailPanel(o));
    clusterGroup.addLayer(marker);
    state.markerMap.set(o.id, marker);
  });
}

// ─── DETAIL PANEL ───────────────────────────────────────────────────────────
function showDetailPanel(o) {
  const panel = document.getElementById('detail-panel');
  const content = document.getElementById('detail-content');
  const location = [o.barangay, o.city, o.province].filter(Boolean).join(', ') || `${o.lat.toFixed(4)}, ${o.lng.toFixed(4)}`;
  const voted = state.votedIds.has(o.id);

  const src = sourceMeta(o.source);
  content.innerHTML = `
    <div style="display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
      <span class="detail-type-badge ${o.type === 'planned' ? 'badge-planned' : 'badge-unplanned'}">
        ${o.type === 'planned' ? '📅 Planned' : '⚡ Unplanned'}
      </span>
      <span class="detail-type-badge" style="background:rgba(0,0,0,0.3);color:${src.color};border:1px solid ${src.color}40">
        ${src.icon} ${escHtml(src.label)}
      </span>
    </div>
    <div class="detail-location">${escHtml(location)}</div>
    <div class="detail-region">${escHtml(o.region)}</div>
    ${o.description ? `<div class="detail-desc">"${escHtml(o.description)}"</div>` : ''}
    <div class="detail-meta">
      <div><strong>Reported:</strong> ${formatDateTime(o.reported_at)}</div>
      <div><strong>Status:</strong> ${timeLeft(o.expires_at)}</div>
      <div><strong>Coordinates:</strong> ${o.lat.toFixed(5)}, ${o.lng.toFixed(5)}</div>
      ${o.source_url ? `<div><strong>Source:</strong> <a href="${escHtml(o.source_url)}" target="_blank" rel="noopener" style="color:#3b82f6">${escHtml(src.label)}</a></div>` : ''}
      ${o.affected_areas ? `<div><strong>Areas:</strong> ${escHtml(o.affected_areas)}</div>` : ''}
    </div>
    <div class="upvote-section">
      <button class="upvote-btn ${voted ? 'voted' : ''}" id="upvote-btn" data-id="${o.id}" ${voted ? 'disabled' : ''}>
        ${voted ? '✓ Confirmed' : '✓ Confirm this outage'}
      </button>
      <div class="upvote-count" id="upvote-count">${o.upvotes}</div>
      <div class="upvote-label">people confirmed this outage</div>
    </div>
  `;

  const upvoteBtn = content.querySelector('#upvote-btn');
  if (upvoteBtn && !voted) {
    upvoteBtn.addEventListener('click', () => handleUpvote(o.id));
  }

  panel.removeAttribute('hidden');
}

window.showDetailFromMap = function(id) {
  const o = state.outages.find(x => x.id === id);
  if (o) showDetailPanel(o);
};

document.getElementById('detail-close').addEventListener('click', () => {
  document.getElementById('detail-panel').setAttribute('hidden', '');
});

// ─── UPVOTE ─────────────────────────────────────────────────────────────────
async function handleUpvote(id) {
  try {
    const result = await apiPost(`/api/outages/${id}/upvote`, {});
    state.votedIds.add(id);
    localStorage.setItem(VOTED_KEY, JSON.stringify([...state.votedIds]));

    // Update UI
    const btn = document.getElementById('upvote-btn');
    const countEl = document.getElementById('upvote-count');
    if (btn) { btn.classList.add('voted'); btn.disabled = true; btn.textContent = '✓ Confirmed'; }
    if (countEl) countEl.textContent = result.upvotes;

    // Update local state
    const o = state.outages.find(x => x.id === id);
    if (o) {
      o.upvotes = result.upvotes;
      const marker = state.markerMap.get(id);
      if (marker) marker.setIcon(makeIcon(o.type, o.upvotes));
      // Update card upvote count
      const card = document.querySelector(`.outage-card[data-id="${id}"] .card-upvotes`);
      if (card) card.innerHTML = `<span class="check">✓</span> ${o.upvotes} confirmed`;
    }

    showToast('Thanks for confirming!', 'success');
  } catch (err) {
    showToast(err.message || 'Could not confirm outage', 'error');
  }
}

// ─── DATA LOADING ────────────────────────────────────────────────────────────
async function loadData() {
  try {
    const [outageData, statsData] = await Promise.all([
      apiGet('/api/outages'),
      apiGet('/api/stats'),
    ]);
    state.outages = outageData.outages;
    state.stats = statsData;

    renderFeed();
    renderMarkers();
    renderStats();

    document.getElementById('active-count').textContent = state.outages.length;
    document.getElementById('last-updated').textContent = new Date().toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
  } catch (err) {
    console.error('Failed to load data:', err);
    showToast('Failed to load outage data', 'error');
  }
}

// ─── REPORT MODAL ───────────────────────────────────────────────────────────
const modalOverlay = document.getElementById('modal-overlay');

function openModal(lat, lng) {
  state.selectedLat = lat;
  state.selectedLng = lng;

  document.getElementById('preview-coords').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  document.getElementById('preview-place').textContent = getRegionFromCoords(lat, lng) || '—';

  // Auto-select region if we can guess it
  const guessed = guessRegion(lat, lng);
  if (guessed) {
    document.getElementById('f-region').value = guessed;
  }

  modalOverlay.removeAttribute('hidden');
}

function closeModal() {
  modalOverlay.setAttribute('hidden', '');
  document.getElementById('report-form').reset();
  document.getElementById('char-count').textContent = '0';
  if (state.pendingMarker) {
    map.removeLayer(state.pendingMarker);
    state.pendingMarker = null;
  }
  state.selectedLat = null;
  state.selectedLng = null;
}

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('form-cancel').addEventListener('click', closeModal);
document.getElementById('report-btn').addEventListener('click', () => {
  showToast('Click anywhere on the map to pin your location', 'info');
  document.getElementById('map-hint').style.opacity = '1';
});

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// Map click -> open modal
map.on('click', (e) => {
  const { lat, lng } = e.latlng;
  if (lat < 4.5 || lat > 21.5 || lng < 116 || lng > 127) {
    showToast('Please click within the Philippines', 'error');
    return;
  }

  if (state.pendingMarker) map.removeLayer(state.pendingMarker);
  state.pendingMarker = L.marker([lat, lng], { icon: pendingIcon }).addTo(map);
  openModal(lat, lng);
});

// Char counter
document.getElementById('f-desc').addEventListener('input', (e) => {
  document.getElementById('char-count').textContent = e.target.value.length;
});

// Form submit
document.getElementById('report-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.selectedLat === null || state.selectedLng === null) {
    showToast('Please click on the map to set a location first', 'error');
    return;
  }

  const submitBtn = document.getElementById('form-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';

  const type = document.querySelector('input[name="type"]:checked').value;

  try {
    await apiPost('/api/outages', {
      lat: state.selectedLat,
      lng: state.selectedLng,
      region: document.getElementById('f-region').value,
      province: document.getElementById('f-province').value.trim() || null,
      city: document.getElementById('f-city').value.trim() || null,
      barangay: document.getElementById('f-barangay').value.trim() || null,
      description: document.getElementById('f-desc').value.trim() || null,
      type,
    });

    closeModal();
    showToast('Outage reported! Thank you.', 'success');
    await loadData();
  } catch (err) {
    showToast(err.message || 'Failed to submit report', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Report';
  }
});

// ─── TABS ────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ─── REFRESH ─────────────────────────────────────────────────────────────────
document.getElementById('refresh-btn').addEventListener('click', async () => {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  await loadData();
  setTimeout(() => btn.classList.remove('spinning'), 300);
});

// ─── TOAST ───────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ─── REGION GUESSER ─────────────────────────────────────────────────────────
// Approximate bounding boxes for Philippine regions
const REGION_BOXES = [
  { region: 'NCR',         lat: [14.4, 14.8], lng: [120.9, 121.2] },
  { region: 'Region III',  lat: [14.8, 16.0], lng: [119.9, 121.5] },
  { region: 'Region IV-A', lat: [13.5, 14.5], lng: [121.0, 122.0] },
  { region: 'Region I',    lat: [15.8, 18.5], lng: [119.7, 121.0] },
  { region: 'CAR',         lat: [16.5, 18.2], lng: [120.5, 122.0] },
  { region: 'Region II',   lat: [16.0, 18.5], lng: [121.5, 123.0] },
  { region: 'Region V',    lat: [12.0, 14.2], lng: [123.0, 124.7] },
  { region: 'Region IV-B', lat: [8.0, 13.5],  lng: [117.0, 122.5] },
  { region: 'Region VI',   lat: [9.8, 11.8],  lng: [121.5, 123.5] },
  { region: 'Region VII',  lat: [9.5, 11.5],  lng: [123.0, 124.5] },
  { region: 'Region VIII', lat: [10.0, 12.5], lng: [124.0, 126.0] },
  { region: 'Region IX',   lat: [7.0, 9.2],   lng: [121.5, 124.0] },
  { region: 'Region X',    lat: [7.5, 9.5],   lng: [123.5, 125.5] },
  { region: 'Region XI',   lat: [6.0, 8.0],   lng: [125.0, 126.5] },
  { region: 'Region XII',  lat: [5.8, 7.5],   lng: [124.0, 125.5] },
  { region: 'Region XIII', lat: [7.5, 10.5],  lng: [125.5, 126.8] },
  { region: 'BARMM',       lat: [5.0, 8.5],   lng: [119.5, 125.0] },
];

function guessRegion(lat, lng) {
  for (const r of REGION_BOXES) {
    if (lat >= r.lat[0] && lat <= r.lat[1] && lng >= r.lng[0] && lng <= r.lng[1]) {
      return r.region;
    }
  }
  return null;
}

function getRegionFromCoords(lat, lng) {
  return guessRegion(lat, lng) || 'Philippines';
}

// ─── SECURITY ────────────────────────────────────────────────────────────────
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ─── AUTO REFRESH ────────────────────────────────────────────────────────────
function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(loadData, REFRESH_INTERVAL);
}

// ─── INIT ────────────────────────────────────────────────────────────────────
(async function init() {
  await loadData();
  startAutoRefresh();

  // Hide map hint after first click
  map.on('click', () => {
    document.getElementById('map-hint').style.opacity = '0';
  });
})();
