'use strict';

const CATEGORY = {
  lodging: { label: '숙박', icon: '🏡' },
  restaurant: { label: '음식점', icon: '🍽️' },
  cafe: { label: '카페', icon: '☕' },
  mart: { label: '마트', icon: '🛒' },
  convenience: { label: '편의점', icon: '🏪' },
  travel: { label: '여행지·체험', icon: '🗺️' },
  taxi: { label: '택시', icon: '🚕' },
  driver: { label: '대리운전', icon: '🚘' },
  transport: { label: '교통·주차', icon: '🅿️' },
  other: { label: '기타', icon: '📌' },
};
const PAGE_META = {
  dashboard: ['홈', 'TODAY’S OVERVIEW'], members: ['회원 관리', 'MEMBERS'], fees: ['회비·공동회비', 'MEMBERSHIP FUND'],
  event: ['모임 설정', 'SUMMER · WINTER'], records: ['이용 기록', 'EXPENSES & PLACES'], settlement: ['개인별 정산', 'SETTLEMENT'],
  report: ['사진 정산 보고서', 'REPORT'], backup: ['백업·설정', 'SYSTEM'],
};
const STATUS_LABEL = { preparing: '준비 중', active: '진행 중', reviewing: '검토 중', completed: '정산 완료' };
const FEE_METHOD = { auto:'자동이체', transfer:'계좌이체', cash:'현금', advance:'선납', other:'기타' };
const MAX_RECORD_PHOTOS = 4;

let state = null;
let serverInfo = null;
let currentPage = 'dashboard';
let recordFilter = 'all';
let feeViewMonth = new Date().getMonth() + 1;
let saveTimer = null;
let saveChain = Promise.resolve();
let activeSaves = 0;

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const esc = (v = '') => String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const money = n => `${Math.round(Number(n) || 0).toLocaleString('ko-KR')}원`;
const dateText = v => v ? new Intl.DateTimeFormat('ko-KR', {year:'numeric',month:'short',day:'numeric'}).format(new Date(`${v}T00:00:00`)) : '-';
const dateTimeText = v => v ? new Intl.DateTimeFormat('ko-KR', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(v)) : '-';
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));


const MOBILE_APP_VERSION = '2.0.1';
const MOBILE_DB_NAME = 'rosa-gather-mobile-v2';
const MOBILE_DB_VERSION = 1;
let mobileDbPromise = null;
let installPromptEvent = null;
const attachmentUrlCache = new Map();

function mobileInitialState() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const season = now.getMonth()+1 >= 4 && now.getMonth()+1 <= 9 ? 'summer' : 'winter';
  const end = new Date(now); end.setDate(end.getDate()+1);
  const eventId = uid('evt');
  return {
    version: 1,
    settings: { clubName:'우리 모임', monthlyFee:20000, openingBalance:0, settlementRounding:1 },
    members: [],
    events: [{
      id:eventId, year:now.getFullYear(), season,
      title:`${now.getFullYear()}년 ${season==='summer'?'하계':'동계'} 모임`,
      startDate:dateStr(now), endDate:dateStr(end), location:'', status:'preparing',
      attendeeIds:[], lodgerIds:[], notes:'', createdAt:new Date().toISOString(),
    }],
    currentEventId:eventId, records:[], fees:[], fundTransactions:[], attachments:[], updatedAt:new Date().toISOString(),
  };
}

function openMobileDb() {
  if (mobileDbPromise) return mobileDbPromise;
  mobileDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(MOBILE_DB_NAME, MOBILE_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', {keyPath:'id'});
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('휴대폰 저장소를 열지 못했습니다.'));
  });
  return mobileDbPromise;
}

async function idbGet(store, key) {
  const db = await openMobileDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(store, value, key) {
  const db = await openMobileDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = key === undefined ? tx.objectStore(store).put(value) : tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error || req.error);
  });
}
async function idbDelete(store, key) {
  const db = await openMobileDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function idbClear(store) {
  const db = await openMobileDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function stateWithoutRuntimeUrls(input) {
  const copy = JSON.parse(JSON.stringify(input));
  (copy.attachments || []).forEach(a => delete a.url);
  return copy;
}

async function refreshAttachmentUrls(targetState) {
  for (const url of attachmentUrlCache.values()) URL.revokeObjectURL(url);
  attachmentUrlCache.clear();
  for (const meta of targetState.attachments || []) {
    const stored = await idbGet('files', meta.id);
    if (stored?.blob) {
      const url = URL.createObjectURL(stored.blob);
      attachmentUrlCache.set(meta.id, url);
      meta.url = url;
      meta.contentType ||= stored.contentType || stored.blob.type;
      meta.size ||= stored.size || stored.blob.size;
      meta.originalName ||= stored.originalName || meta.id;
    } else {
      meta.url = '';
    }
  }
  return targetState;
}

async function loadMobileState() {
  let stored = await idbGet('kv', 'state');
  if (!stored) {
    stored = mobileInitialState();
    await idbPut('kv', stateWithoutRuntimeUrls(stored), 'state');
  }
  return await refreshAttachmentUrls(stored);
}

async function saveMobileState(nextState) {
  nextState.updatedAt = new Date().toISOString();
  await idbPut('kv', stateWithoutRuntimeUrls(nextState), 'state');
  return nextState;
}

async function storeMobileAttachment(file) {
  const id = uid('att');
  const blob = file instanceof Blob ? file : new Blob([file]);
  const originalName = file.name || `${id}.${(blob.type.split('/')[1] || 'bin')}`;
  const stored = {id, blob, originalName, contentType:blob.type || 'application/octet-stream', size:blob.size, createdAt:new Date().toISOString()};
  await idbPut('files', stored);
  const url = URL.createObjectURL(blob);
  attachmentUrlCache.set(id, url);
  return {id, originalName, storedName:originalName, url, contentType:stored.contentType, size:stored.size, createdAt:stored.createdAt};
}

async function deleteLocalAttachment(id) {
  const url = attachmentUrlCache.get(id);
  if (url) URL.revokeObjectURL(url);
  attachmentUrlCache.delete(id);
  await idbDelete('files', id);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('파일을 읽지 못했습니다.'));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const [head, body] = String(dataUrl).split(',', 2);
  const type = (head.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
  const binary = atob(body || '');
  const bytes = new Uint8Array(binary.length);
  for (let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], {type});
}

async function buildMobileTransferPackage() {
  const cleanState = stateWithoutRuntimeUrls(state);
  const files = [];
  for (const meta of cleanState.attachments || []) {
    const stored = await idbGet('files', meta.id);
    if (!stored?.blob) continue;
    files.push({meta:{...meta, contentType:stored.contentType, size:stored.size, originalName:stored.originalName}, dataUrl:await blobToDataUrl(stored.blob)});
  }
  return {format:'ROSA_GATHER_TRANSFER_V1', app:'ROSA Gather Mobile', version:MOBILE_APP_VERSION, exportedAt:new Date().toISOString(), state:cleanState, files};
}

async function importMobileTransferPackage(parsed) {
  if (parsed?.format !== 'ROSA_GATHER_TRANSFER_V1' || !parsed.state) throw new Error('ROSA 휴대폰 전송 파일이 아닙니다.');
  await idbClear('files');
  for (const item of parsed.files || []) {
    const meta = item.meta || {};
    if (!meta.id || !item.dataUrl) continue;
    const blob = dataUrlToBlob(item.dataUrl);
    await idbPut('files', {id:meta.id, blob, originalName:meta.originalName || meta.id, contentType:meta.contentType || blob.type, size:blob.size, createdAt:meta.createdAt || new Date().toISOString()});
  }
  await idbPut('kv', stateWithoutRuntimeUrls(parsed.state), 'state');
  return await loadMobileState();
}

async function api(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (url === '/api/info') return {app:'ROSA Gather Mobile', version:MOBILE_APP_VERSION, networkUrl:'휴대폰 단독 저장', dataPath:'휴대폰 앱 저장소'};
  if (url === '/api/health') return {status:'ok', version:MOBILE_APP_VERSION};
  if (url === '/api/state' && method === 'GET') return await loadMobileState();
  if (url === '/api/state' && method === 'PUT') {
    const next = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    return await saveMobileState(next);
  }
  throw new Error(`지원하지 않는 모바일 요청입니다: ${method} ${url}`);
}


function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toastRoot').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function normalizeState() {
  state.settings ||= { clubName:'우리 모임', monthlyFee:20000, openingBalance:0, settlementRounding:1 };
  state.members ||= []; state.events ||= []; state.records ||= []; state.fees ||= []; state.fundTransactions ||= []; state.attachments ||= [];
  state.events.forEach(e=>{ e.attendeeIds ||= []; e.lodgerIds ||= []; });
  state.records.forEach(r=>{ r.participantIds ||= []; r.receiptIds ||= []; r.photoIds ||= []; });
  state.fees.forEach(f=>{ f.status ||= 'paid'; f.method ||= 'auto'; f.memo ||= ''; f.statusMemo ||= ''; });
  if (!state.currentEventId && state.events[0]) state.currentEventId = state.events[0].id;
}

function persistSnapshot(snapshot) {
  const payload = JSON.stringify(snapshot);
  const task = saveChain.catch(()=>{}).then(()=>api('/api/state', {
    method:'PUT', headers:{'Content-Type':'application/json'}, body:payload,
  }));
  saveChain = task;
  return task;
}

async function saveState(showToast = false) {
  activeSaves += 1;
  setSync('저장 중', 'warn');
  try {
    state = await persistSnapshot(state);
    setSync('자동 저장됨', 'ok');
    if (showToast) toast('저장했습니다.', 'ok');
    return state;
  } catch (err) {
    setSync('저장 실패', 'warn');
    toast(err.message, 'error');
    throw err;
  } finally { activeSaves = Math.max(0, activeSaves - 1); }
}
function queueSave(delay = 350) { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveState(false).catch(()=>{}), delay); }
function setSync(text, cls='') { const el = $('#syncBadge'); if (el) { el.textContent = text; el.className = `sync-badge ${cls}`; } }

function currentEvent() { return state.events.find(e => e.id === state.currentEventId) || state.events[0] || null; }
function member(id) { return state.members.find(m => m.id === id); }
function attachment(id) { return state.attachments.find(a => a.id === id); }
function eventRecords(eventId = currentEvent()?.id) { return state.records.filter(r => r.eventId === eventId).sort((a,b) => String(a.datetime).localeCompare(String(b.datetime))); }
function lodgingRecords(eventId = currentEvent()?.id) { return eventRecords(eventId).filter(r => r.category === 'lodging'); }
function lodgerIdsForEvent(event = currentEvent()) {
  if (!event) return [];
  const ids = [...new Set(lodgingRecords(event.id).flatMap(r => r.participantIds || []))];
  return ids.length ? ids : [...new Set(event.lodgerIds || [])];
}
function syncLegacyLodgers(targetState, eventId) {
  const event = targetState.events.find(e => e.id === eventId);
  if (!event) return;
  const ids = [...new Set(targetState.records.filter(r => r.eventId === eventId && r.category === 'lodging').flatMap(r => r.participantIds || []))];
  event.lodgerIds = ids;
}
function activeMembers() { return state.members.filter(m => m.active !== false); }
function attendees(event = currentEvent()) { return (event?.attendeeIds || []).map(member).filter(Boolean); }
function memberNames(ids = []) { return ids.map(id => member(id)?.name).filter(Boolean); }
function getFee(year, month, memberId) { return state.fees.find(f => Number(f.year) === Number(year) && Number(f.month) === Number(month) && f.memberId === memberId); }
function feeMethodLabel(method) { return FEE_METHOD[method] || FEE_METHOD.other; }
function seasonName(s) { return s === 'summer' ? '하계' : '동계'; }
function feePeriodForEvent(event = currentEvent()) {
  if (!event) return [];
  const eventYear = Number(event.year) || new Date().getFullYear();
  if (event.season !== 'winter') {
    return [2,3,4,5,6,7].map(month => ({year:eventYear, month}));
  }

  // 동계 모임은 8월부터 다음 해 1월까지의 실제 납부액을 반영합니다.
  // 모임 시작일이 1월이면 직전 해 8월부터 해당 연도 1월까지로 해석합니다.
  const startDate = String(event.startDate || '');
  const startMatch = startDate.match(/^(\d{4})-(\d{2})/);
  let periodStartYear = eventYear;
  if (startMatch) {
    const startYear = Number(startMatch[1]);
    const startMonth = Number(startMatch[2]);
    periodStartYear = startMonth === 1 ? startYear - 1 : startYear;
  }
  return [8,9,10,11,12].map(month => ({year:periodStartYear, month}))
    .concat([{year:periodStartYear + 1, month:1}]);
}
function feePeriodLabel(event = currentEvent()) {
  const period = feePeriodForEvent(event);
  if (!period.length) return '-';
  const first = period[0], last = period[period.length - 1];
  return first.year === last.year
    ? `${first.year}년 ${first.month}~${last.month}월`
    : `${first.year}년 ${first.month}~12월 + ${last.year}년 1월`;
}
function paidFeeDetailsForMember(event, memberId) {
  if (!event || !memberId) return {amount:0, paidEntries:[], period:[]};
  const period = feePeriodForEvent(event);
  const keys = new Set(period.map(p => `${p.year}-${p.month}`));
  const paidEntries = state.fees
    .filter(f => f.memberId === memberId && f.status === 'paid' && keys.has(`${Number(f.year)}-${Number(f.month)}`))
    .sort((a,b) => Number(a.year)-Number(b.year) || Number(a.month)-Number(b.month));
  const amount = paidEntries.reduce((sum, f) => sum + Number(f.amount || 0), 0);
  return {amount, paidEntries, period};
}
function paidFeeForMember(event, memberId) {
  return paidFeeDetailsForMember(event, memberId).amount;
}
function settlementResultText(row) {
  return row.net > 0 ? `${money(row.net)} 납부` : row.net < 0 ? `${money(Math.abs(row.net))} 환급` : '정산 없음';
}

function distribute(amount, ids) {
  const result = {};
  const list = [...new Set(ids || [])];
  if (!list.length || !amount) return result;
  const total = Math.round(Number(amount) || 0);
  const base = Math.floor(total / list.length);
  let remainder = total - base * list.length;
  list.forEach((id, i) => result[id] = base + (i < remainder ? 1 : 0));
  return result;
}

function calculateSettlement(event = currentEvent()) {
  const rows = {};
  const eventMemberIds = new Set(event?.attendeeIds || []);
  state.members.forEach(m => {
    if (eventMemberIds.has(m.id)) rows[m.id] = {
      id:m.id, name:m.name, type:m.type, used:0, personalDue:0,
      feePaid:m.type === 'monthly' ? paidFeeForMember(event, m.id) : 0,
      advanced:0, net:0,
    };
  });
  let totalExpense = 0, commonBurden = 0, commonPaid = 0;
  const categoryTotals = {};
  for (const r of eventRecords(event?.id)) {
    const amount = Math.round(Number(r.amount) || 0);
    if (amount <= 0) continue;
    totalExpense += amount;
    categoryTotals[r.category] = (categoryTotals[r.category] || 0) + amount;
    const shares = distribute(amount, r.participantIds || []);
    Object.entries(shares).forEach(([id, share]) => {
      if (!rows[id]) {
        const m = member(id);
        if (m) rows[id] = {
          id, name:m.name, type:m.type, used:0, personalDue:0,
          feePaid:m.type === 'monthly' ? paidFeeForMember(event, id) : 0,
          advanced:0, net:0,
        };
      }
      if (!rows[id]) return;
      rows[id].used += share;
      if (rows[id].type === 'monthly') commonBurden += share;
      else rows[id].personalDue += share;
    });
    if (r.paymentSource === 'personal' && r.payerId && rows[r.payerId]) rows[r.payerId].advanced += amount;
    if (r.paymentSource === 'common') commonPaid += amount;
  }
  Object.values(rows).forEach(row => {
    // 월회비 회원: 실제 이용액 - 해당 반기 실제 납부회비 - 개인 선결제액.
    // 음수이면 납부한 금액이 더 많으므로 환급, 양수이면 추가 납부입니다.
    row.net = row.type === 'monthly'
      ? row.used - row.feePaid - row.advanced
      : row.personalDue - row.advanced;
  });
  const feeYear = event?.year || new Date().getFullYear();
  const feeIncome = state.fees.filter(f => Number(f.year) === Number(feeYear) && f.status === 'paid').reduce((s,f) => s + Number(f.amount || 0), 0);
  const fundAdjustment = state.fundTransactions.filter(t => Number(String(t.date || '').slice(0,4)) === Number(feeYear)).reduce((s,t) => s + (t.kind === 'income' ? Number(t.amount||0) : -Number(t.amount||0)), 0);
  const projectedFund = Number(state.settings.openingBalance || 0) + feeIncome + fundAdjustment - commonBurden;
  const eventFeePaid = Object.values(rows).reduce((sum, row) => sum + Number(row.feePaid || 0), 0);
  return {
    rows:Object.values(rows).sort((a,b) => a.name.localeCompare(b.name,'ko')),
    totalExpense, commonBurden, commonPaid, categoryTotals, feeIncome,
    eventFeePaid, fundAdjustment, projectedFund,
  };
}

function setPage(page) {
  currentPage = page;
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $$('.mobile-nav [data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  const [title, eyebrow] = PAGE_META[page] || PAGE_META.dashboard;
  $('#pageTitle').textContent = title; $('#pageEyebrow').textContent = eyebrow;
  renderPage();
  window.scrollTo({top:0, behavior:'smooth'});
}

function renderEventSelector() {
  const sel = $('#eventSelector');
  sel.innerHTML = state.events.slice().sort((a,b) => b.year-a.year || (a.season === 'winter' ? -1 : 1)).map(e => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
  sel.value = state.currentEventId || '';
}

function renderPage() {
  renderEventSelector();
  const renderers = { dashboard:renderDashboard, members:renderMembers, fees:renderFees, event:renderEvent, records:renderRecords, settlement:renderSettlement, report:renderReport, backup:renderBackup };
  (renderers[currentPage] || renderDashboard)();
}

function emptyState(title, message, button = '') {
  return `<div class="empty"><strong>${esc(title)}</strong><div>${esc(message)}</div>${button}</div>`;
}

function renderDashboard() {
  const e = currentEvent();
  if (!e) { $('#content').innerHTML = emptyState('모임이 없습니다.', '하계 또는 동계 모임을 먼저 만들어 주세요.', '<button class="btn btn-primary" data-action="new-event">모임 만들기</button>'); bindCommonActions(); return; }
  const recs = eventRecords(); const calc = calculateSettlement(e); const lodgers=lodgerIdsForEvent(e); const pct = e.attendeeIds.length ? Math.round((lodgers.length/e.attendeeIds.length)*100) : 0;
  const recent = recs.slice(-5).reverse();
  $('#content').innerHTML = `
    <section class="card hero">
      <p class="eyebrow">${e.year} ${seasonName(e.season)} GATHERING</p>
      <h2>${esc(e.title)}</h2>
      <p>${dateText(e.startDate)} ~ ${dateText(e.endDate)} · ${esc(e.location || '장소를 입력해 주세요')}<br>지출 건마다 실제 이용자를 선택하고 영수증과 현장 사진을 함께 남기세요.</p>
      <div class="hero-actions"><button class="btn btn-primary" data-action="add-record">＋ 이용 기록 추가</button><button class="btn" data-page-jump="event">모임·참석자 설정</button><button class="btn" data-page-jump="report">보고서 보기</button><button class="btn" data-page-jump="backup">백업·설정</button></div>
    </section>
    <section class="grid grid-4 section-gap">
      <div class="card stat"><div class="stat-label">전체 지출</div><div class="stat-value">${money(calc.totalExpense)}</div><div class="stat-sub">${recs.filter(r=>Number(r.amount)>0).length}건</div></div>
      <div class="card stat"><div class="stat-label">모임 참석자</div><div class="stat-value">${e.attendeeIds.length}명</div><div class="stat-sub">숙박 ${lodgers.length}명 · ${pct}%</div></div>
      <div class="card stat"><div class="stat-label">공동회비 부담</div><div class="stat-value">${money(calc.commonBurden)}</div><div class="stat-sub">월회비 회원 실제 이용분</div></div>
      <div class="card stat"><div class="stat-label">예상 공동회비 잔액</div><div class="stat-value ${calc.projectedFund < 0 ? 'negative':'positive'}">${money(calc.projectedFund)}</div><div class="stat-sub">기초잔액 + 회비 - 부담액</div></div>
    </section>
    <section class="grid grid-2 section-gap">
      <div class="card">
        <div class="card-title-row"><div><h2>최근 이용 기록</h2><div class="help">음식점·마트·여행지·택시 기록을 시간순으로 확인합니다.</div></div><button class="btn btn-sm" data-page-jump="records">전체 보기</button></div>
        ${recent.length ? `<div class="list">${recent.map(recordListItem).join('')}</div>` : emptyState('아직 이용 기록이 없습니다.', '첫 지출이나 여행지를 등록해 주세요.', '<button class="btn btn-primary" data-action="add-record">첫 기록 추가</button>')}
      </div>
      <div class="card">
        <div class="card-title-row"><div><h2>오늘 빠른 점검</h2><div class="help">정산 전에 꼭 필요한 항목입니다.</div></div></div>
        ${checklistHtml(e, recs)}
        <div class="divider"></div>
        <div class="notice"><strong>휴대폰 단독 저장</strong><br>작성한 장부와 사진은 이 휴대폰에 자동 저장됩니다.<br><span class="small">모임 중에는 인터넷이 끊겨도 계속 작성할 수 있습니다. 모임 후 전체 전송 파일을 백업해 주세요.</span></div>
      </div>
    </section>`;
  bindCommonActions();
}

function checklistHtml(e, recs) {
  const receiptCount = recs.filter(r => (r.receiptIds || []).length).length;
  const photoCount = recs.filter(r => (r.photoIds || []).length).length;
  const items = [
    [state.members.length > 0, '회원 등록', `${state.members.length}명`],
    [e.attendeeIds.length > 0, '모임 참석자 선택', `${e.attendeeIds.length}명`],
    [lodgerIdsForEvent(e).length > 0, '숙박 이용 기록', `${lodgerIdsForEvent(e).length}명`],
    [recs.length > 0, '이용 기록 입력', `${recs.length}건`],
    [receiptCount > 0, '영수증 첨부', `${receiptCount}건`],
    [photoCount > 0, '이용 사진 첨부', `${photoCount}건`],
  ];
  return `<div class="list">${items.map(([ok,t,s]) => `<div class="list-item"><div class="list-item-main"><div class="list-item-title">${ok?'✓':'○'} ${t}</div></div><span class="badge ${ok?'ok':'warn'}">${s}</span></div>`).join('')}</div>`;
}
function recordListItem(r) { const cat=CATEGORY[r.category]||CATEGORY.other; return `<div class="list-item"><div class="list-item-main"><div class="list-item-title">${cat.icon} ${esc(r.place || cat.label)}</div><div class="list-item-sub">${dateTimeText(r.datetime)} · 이용자 ${(r.participantIds||[]).length}명 · ${member(r.payerId)?.name ? `결제 ${esc(member(r.payerId).name)}` : '지출 없음'}</div></div><div class="list-item-right"><strong>${money(r.amount)}</strong><button class="btn btn-sm" data-edit-record="${r.id}">수정</button></div></div>`; }

function renderMembers() {
  const members = state.members.slice().sort((a,b) => a.name.localeCompare(b.name,'ko'));
  $('#content').innerHTML = `
    <section class="grid grid-3">
      <div class="card stat"><div class="stat-label">전체 회원</div><div class="stat-value">${members.length}명</div><div class="stat-sub">활동 ${members.filter(m=>m.active!==false).length}명</div></div>
      <div class="card stat"><div class="stat-label">월회비 회원</div><div class="stat-value">${members.filter(m=>m.type==='monthly').length}명</div><div class="stat-sub">월 ${money(state.settings.monthlyFee)}</div></div>
      <div class="card stat"><div class="stat-label">모임별 정산</div><div class="stat-value">${members.filter(m=>m.type==='event').length}명</div><div class="stat-sub">실제 이용분만 납부</div></div>
    </section>
    <section class="card section-gap">
      <div class="card-title-row"><div><h2>회원 명단</h2><div class="help">회원 유형에 따라 공동회비 부담과 개인 납부가 자동 구분됩니다.</div></div><div class="inline-actions"><button class="btn" data-action="bulk-member">여러 명 빠른 등록</button><button class="btn btn-primary" data-action="add-member">＋ 회원 추가</button></div></div>
      ${members.length ? `<div class="table-wrap"><table><thead><tr><th>이름</th><th>유형</th><th>상태</th><th>메모</th><th class="center">관리</th></tr></thead><tbody>${members.map(m=>`<tr><td><strong>${esc(m.name)}</strong></td><td><span class="badge ${m.type==='monthly'?'primary':'dark'}">${m.type==='monthly'?'월회비':'모임별 정산'}</span></td><td><span class="badge ${m.active!==false?'ok':'warn'}">${m.active!==false?'활동':'휴회'}</span></td><td>${esc(m.note||'')}</td><td class="center"><button class="btn btn-sm" data-edit-member="${m.id}">수정</button></td></tr>`).join('')}</tbody></table></div>` : emptyState('등록된 회원이 없습니다.', '오늘 참석할 분들의 이름을 한 번에 등록해 보세요.', '<button class="btn btn-primary" data-action="bulk-member">여러 명 빠른 등록</button>')}
    </section>`;
  bindCommonActions();
}

function renderFees() {
  const e=currentEvent();
  const year=e?.year || new Date().getFullYear();
  const ms=state.members.filter(m=>m.type==='monthly' && m.active!==false).sort((a,b)=>a.name.localeCompare(b.name,'ko'));
  feeViewMonth=clamp(Number(feeViewMonth)||1,1,12);
  const paidFees=state.fees.filter(f=>Number(f.year)===Number(year)&&f.status==='paid');
  const paidTotal=paidFees.reduce((s,f)=>s+Number(f.amount||0),0);
  const monthPaid=paidFees.filter(f=>Number(f.month)===feeViewMonth);
  const monthPaidTotal=monthPaid.reduce((s,f)=>s+Number(f.amount||0),0);
  const txTotal=state.fundTransactions.filter(t=>Number(String(t.date||'').slice(0,4))===year).reduce((s,t)=>s+(t.kind==='income'?Number(t.amount||0):-Number(t.amount||0)),0);
  const calc=calculateSettlement(e);
  $('#content').innerHTML=`
    <section class="grid grid-4">
      <div class="card stat"><div class="stat-label">${year}년 회비 납부</div><div class="stat-value">${money(paidTotal)}</div><div class="stat-sub">연간 실제 입금액</div></div>
      <div class="card stat"><div class="stat-label">${feeViewMonth}월 납부 현황</div><div class="stat-value">${monthPaid.length}명 / ${ms.length}명</div><div class="stat-sub">${money(monthPaidTotal)}</div></div>
      <div class="card stat"><div class="stat-label">기타 공동회비 변동</div><div class="stat-value ${txTotal<0?'negative':'positive'}">${money(txTotal)}</div><div class="stat-sub">수입·지출 수동 기록</div></div>
      <div class="card stat"><div class="stat-label">예상 잔액</div><div class="stat-value ${calc.projectedFund<0?'negative':'positive'}">${money(calc.projectedFund)}</div><div class="stat-sub">하계·동계 이용분 반영</div></div>
    </section>
    <section class="card section-gap">
      <div class="card-title-row">
        <div><h2>${year}년 월회비 납부표</h2><div class="help">월별 일괄 입력 또는 회원별 수동 입력이 가능합니다. 납부 완료 기록도 미납으로 변경할 수 있으며, 표의 셀을 누르면 상태를 직접 수정할 수 있습니다.</div></div>
        <div class="inline-actions">
          <label class="compact-select"><span>상세 월</span><select id="feeViewMonth">${Array.from({length:12},(_,i)=>`<option value="${i+1}" ${feeViewMonth===i+1?'selected':''}>${i+1}월</option>`).join('')}</select></label>
          <button class="btn" data-action="manual-fee-entry">＋ 개별 납부 입력</button>
          <button class="btn btn-primary" data-action="bulk-fee-entry">${feeViewMonth}월 일괄 입력</button>
        </div>
      </div>
      ${ms.length ? `<div class="table-wrap"><table><thead><tr><th>회원</th>${Array.from({length:12},(_,i)=>`<th class="center">${i+1}월</th>`).join('')}<th class="num">합계</th></tr></thead><tbody>${ms.map(m=>{let sum=0;const cells=Array.from({length:12},(_,i)=>{const f=getFee(year,i+1,m.id),isPaid=f?.status==='paid',isExplicitUnpaid=f?.status==='unpaid';if(isPaid)sum+=Number(f.amount||0);const detail=isPaid?`${money(f.amount)} · ${dateText(f.paidDate)} · ${feeMethodLabel(f.method)}`:isExplicitUnpaid?`미납 처리 · ${f.statusMemo||f.memo||'사유 없음'}`:'미납';return `<td class="fee-cell"><button class="fee-toggle ${isPaid?'paid':isExplicitUnpaid?'unpaid':''}" data-fee-member="${m.id}" data-fee-month="${i+1}" title="${esc(detail)}">${isPaid?'✓':isExplicitUnpaid?'!':'-'}</button></td>`}).join('');return `<tr><td><strong>${esc(m.name)}</strong></td>${cells}<td class="num"><strong>${money(sum)}</strong></td></tr>`}).join('')}</tbody></table></div>` : emptyState('월회비 회원이 없습니다.', '회원 관리에서 회원 유형을 월회비로 지정해 주세요.')}
    </section>
    <section class="card section-gap">
      <div class="card-title-row"><div><h2>${year}년 ${feeViewMonth}월 납부 상세</h2><div class="help">납부 완료·미납 상태, 실제 납부액, 처리일, 입금 방법과 사유를 확인하고 수정할 수 있습니다.</div></div><button class="btn btn-sm" data-action="bulk-fee-entry">선택 월 일괄 입력</button></div>
      ${ms.length?`<div class="table-wrap"><table><thead><tr><th>회원</th><th>상태</th><th class="num">실제 납부액</th><th>납부일</th><th>입금 방법</th><th>메모·미납 사유</th><th class="center">관리</th></tr></thead><tbody>${ms.map(m=>{const f=getFee(year,feeViewMonth,m.id),isPaid=f?.status==='paid',isExplicitUnpaid=f?.status==='unpaid';return `<tr><td><strong>${esc(m.name)}</strong></td><td><span class="badge ${isPaid?'ok':'warn'}">${isPaid?'납부 완료':isExplicitUnpaid?'미납 처리':'미납'}</span></td><td class="num">${isPaid?money(f.amount):'-'}</td><td>${isPaid?dateText(f.paidDate):isExplicitUnpaid?dateText(f.statusDate):'-'}</td><td>${isPaid?esc(feeMethodLabel(f.method)):'-'}</td><td>${f?esc(isExplicitUnpaid?(f.statusMemo||f.memo||''):(f.memo||'')):'-'}</td><td class="center"><div class="inline-actions center-actions"><button class="btn btn-sm" data-fee-member="${m.id}" data-fee-month="${feeViewMonth}">${f?'수정':'입력'}</button>${isPaid?`<button class="btn btn-sm btn-danger" data-mark-unpaid="${f.id}">미납 처리</button>`:''}${f?`<button class="btn btn-sm btn-danger" data-delete-fee="${f.id}">삭제</button>`:''}</div></td></tr>`}).join('')}</tbody></table></div>`:emptyState('월회비 회원이 없습니다.','')}
    </section>
    <section class="grid grid-2 section-gap">
      <div class="card"><div class="card-title-row"><div><h2>공동회비 기준</h2></div></div><div class="form-grid"><div class="field"><label>월회비 금액</label><input id="monthlyFeeInput" type="number" min="0" step="1000" value="${Number(state.settings.monthlyFee||0)}"></div><div class="field"><label>${year}년 기초 잔액</label><input id="openingBalanceInput" type="number" step="1000" value="${Number(state.settings.openingBalance||0)}"></div></div><div class="help section-gap">월회비 회원이 실제 이용한 지출 몫만 공동회비 부담으로 계산됩니다.</div></div>
      <div class="card"><div class="card-title-row"><div><h2>기타 수입·지출</h2></div><button class="btn btn-sm" data-action="add-fund-tx">＋ 기록</button></div>${state.fundTransactions.length?`<div class="list">${state.fundTransactions.slice().sort((a,b)=>String(b.date).localeCompare(String(a.date))).slice(0,8).map(t=>`<div class="list-item"><div><div class="list-item-title">${esc(t.description)}</div><div class="list-item-sub">${dateText(t.date)}</div></div><div class="list-item-right"><strong class="${t.kind==='expense'?'negative':'positive'}">${t.kind==='expense'?'-':'+'}${money(t.amount)}</strong><button class="btn btn-sm btn-danger" data-delete-fund="${t.id}">삭제</button></div></div>`).join('')}</div>`:emptyState('기타 거래가 없습니다.','지원금·이자·별도 지출을 기록할 수 있습니다.')}</div>
    </section>`;
  bindCommonActions();
  $('#feeViewMonth')?.addEventListener('change',ev=>{feeViewMonth=Number(ev.target.value)||1;renderFees()});
  $('#monthlyFeeInput')?.addEventListener('change',ev=>{state.settings.monthlyFee=Number(ev.target.value||0);queueSave();renderFees()});
  $('#openingBalanceInput')?.addEventListener('change',ev=>{state.settings.openingBalance=Number(ev.target.value||0);queueSave();renderFees()});
  $$('[data-fee-member]').forEach(btn=>btn.addEventListener('click',()=>openFeeEntryModal(btn.dataset.feeMember,Number(btn.dataset.feeMonth))));
  $$('[data-mark-unpaid]').forEach(btn=>btn.addEventListener('click',()=>openMarkUnpaidModal(btn.dataset.markUnpaid)));
  $$('[data-delete-fee]').forEach(btn=>btn.addEventListener('click',()=>deleteFeeRecord(btn.dataset.deleteFee)));
  $$('[data-delete-fund]').forEach(btn=>btn.addEventListener('click',()=>{if(confirm('이 거래를 삭제할까요?')){state.fundTransactions=state.fundTransactions.filter(t=>t.id!==btn.dataset.deleteFund);queueSave();renderFees()}}));
}

function upsertFee({year,month,memberId,amount,paidDate,method,memo,status='paid',statusDate='',statusMemo=''}) {
  let fee=getFee(year,month,memberId);
  const isPaid=status==='paid';
  const payload={year:Number(year),month:Number(month),memberId,amount:isPaid?Number(amount||0):0,status:isPaid?'paid':'unpaid',paidDate:isPaid?(paidDate||''):'',method:isPaid?(method||'auto'):'other',memo:memo||'',statusDate:isPaid?'':(statusDate||new Date().toISOString().slice(0,10)),statusMemo:isPaid?'':(statusMemo||memo||''),updatedAt:new Date().toISOString()};
  if(fee) {
    if(!isPaid && fee.status==='paid') fee.previousPayment={amount:Number(fee.amount||0),paidDate:fee.paidDate||'',method:fee.method||'auto',memo:fee.memo||'',changedAt:new Date().toISOString()};
    Object.assign(fee,payload);
  } else { fee={id:uid('fee'),...payload,createdAt:new Date().toISOString()}; state.fees.push(fee); }
  return fee;
}

function openMarkUnpaidModal(id) {
  const fee=state.fees.find(f=>f.id===id);
  if(!fee) return;
  const name=member(fee.memberId)?.name||'회원';
  openModal({title:'회비 미납 처리',body:`<div class="notice"><strong>${esc(name)} · ${fee.month}월</strong><br>현재 납부 완료된 ${money(fee.amount)} 기록을 미납으로 변경합니다. 기록은 삭제하지 않고 상태 변경 이력으로 보관됩니다.</div><div class="form-grid section-gap"><div class="field"><label>미납 처리일</label><input id="unpaidStatusDate" type="date" value="${new Date().toISOString().slice(0,10)}"></div><div class="field"><label class="required">미납 처리 사유</label><input id="unpaidStatusMemo" placeholder="예: 입금 착오 확인, 납부 취소, 다른 회원 입금으로 잘못 확인"></div></div>`,footer:`<button class="btn" id="cancelModal">취소</button><button class="btn btn-danger" id="confirmMarkUnpaid">미납으로 변경</button>`,onOpen:root=>{
    $('#cancelModal',root).onclick=closeModal;
    $('#confirmMarkUnpaid',root).onclick=()=>{const statusDate=$('#unpaidStatusDate',root).value,statusMemo=$('#unpaidStatusMemo',root).value.trim();if(!statusDate)return toast('미납 처리일을 입력해 주세요.','error');if(!statusMemo)return toast('미납 처리 사유를 입력해 주세요.','error');upsertFee({year:fee.year,month:fee.month,memberId:fee.memberId,status:'unpaid',statusDate,statusMemo,memo:statusMemo});queueSave();closeModal();renderFees();toast(`${name} 회원의 ${fee.month}월 회비를 미납 처리했습니다.`,'ok')};
  }});
}

function deleteFeeRecord(id) {
  const fee=state.fees.find(f=>f.id===id);
  if(!fee || !confirm(`${member(fee.memberId)?.name||'회원'}의 ${fee.month}월 납부 내역을 삭제할까요?`)) return;
  state.fees=state.fees.filter(f=>f.id!==id);
  queueSave(); renderFees(); toast('회비 납부 내역을 삭제했습니다.','ok');
}

function openFeeEntryModal(memberId='', month=feeViewMonth) {
  const e=currentEvent(); const year=e?.year||new Date().getFullYear();
  const monthlyMembers=state.members.filter(m=>m.type==='monthly'&&m.active!==false).sort((a,b)=>a.name.localeCompare(b.name,'ko'));
  if(!monthlyMembers.length) return toast('월회비 회원을 먼저 등록해 주세요.','error');
  const initialMember=memberId&&monthlyMembers.some(m=>m.id===memberId)?memberId:monthlyMembers[0].id;
  openModal({title:'개별 회비 납부 입력',body:`<div class="form-grid">
    <div class="field"><label>회원</label><select id="feeMember">${monthlyMembers.map(m=>`<option value="${m.id}" ${m.id===initialMember?'selected':''}>${esc(m.name)}</option>`).join('')}</select></div>
    <div class="field"><label>납부 대상 월</label><select id="feeMonth">${Array.from({length:12},(_,i)=>`<option value="${i+1}" ${Number(month)===i+1?'selected':''}>${i+1}월</option>`).join('')}</select></div>
    <div class="field"><label>납부 상태</label><select id="feeStatus"><option value="paid">납부 완료</option><option value="unpaid">미납 처리</option></select></div>
    <div class="field"><label id="feeAmountLabel">실제 납부액</label><input id="feeAmount" type="number" min="0" step="1000"></div>
    <div class="field"><label id="feeDateLabel">납부일</label><input id="feePaidDate" type="date"></div>
    <div class="field"><label>입금 방법</label><select id="feeMethod">${Object.entries(FEE_METHOD).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div>
    <div class="field field-full"><label id="feeMemoLabel">메모</label><input id="feeMemo" placeholder="예: 8월 자동이체, 2개월분 선납"></div>
    <div class="field field-full"><div id="feeExistingNotice" class="notice"></div></div>
  </div>`,footer:`<button class="btn" id="cancelModal">취소</button><button class="btn btn-primary" id="saveFeeEntry">납부 내역 저장</button>`,onOpen:root=>{
    const applyStatusUi=()=>{const unpaid=$('#feeStatus',root).value==='unpaid';$('#feeAmount',root).disabled=unpaid;$('#feeMethod',root).disabled=unpaid;$('#feeAmountLabel',root).textContent=unpaid?'납부액 (미납은 0원)':'실제 납부액';$('#feeDateLabel',root).textContent=unpaid?'미납 처리일':'납부일';$('#feeMemoLabel',root).textContent=unpaid?'미납 처리 사유':'메모';$('#feeMemo',root).placeholder=unpaid?'예: 입금 착오, 납부 취소, 확인 오류':'예: 8월 자동이체, 2개월분 선납';};
    const load=()=>{const mid=$('#feeMember',root).value,mon=Number($('#feeMonth',root).value),f=getFee(year,mon,mid),isUnpaid=f?.status==='unpaid';$('#feeStatus',root).value=isUnpaid?'unpaid':'paid';$('#feeAmount',root).value=isUnpaid?(f?.previousPayment?.amount??Number(state.settings.monthlyFee||20000)):(f?.amount??Number(state.settings.monthlyFee||20000));$('#feePaidDate',root).value=isUnpaid?(f?.statusDate||new Date().toISOString().slice(0,10)):(f?.paidDate||new Date().toISOString().slice(0,10));$('#feeMethod',root).value=isUnpaid?(f?.previousPayment?.method||'auto'):(f?.method||'auto');$('#feeMemo',root).value=isUnpaid?(f?.statusMemo||f?.memo||''):(f?.memo||'');$('#feeExistingNotice',root).innerHTML=f?(isUnpaid?`<strong>현재 미납 처리된 내역입니다.</strong><br>${dateText(f.statusDate)} · ${esc(f.statusMemo||f.memo||'사유 없음')}`:`<strong>기존 납부 내역을 수정합니다.</strong><br>${money(f.amount)} · ${dateText(f.paidDate)} · ${esc(feeMethodLabel(f.method))}`):'<strong>새 회비 상태를 입력합니다.</strong><br>납부 완료 또는 미납 처리를 직접 선택할 수 있습니다.';applyStatusUi();};
    $('#cancelModal',root).onclick=closeModal; $('#feeMember',root).onchange=load; $('#feeMonth',root).onchange=load; $('#feeStatus',root).onchange=applyStatusUi; load();
    $('#saveFeeEntry',root).onclick=()=>{const mid=$('#feeMember',root).value,mon=Number($('#feeMonth',root).value),status=$('#feeStatus',root).value,amount=Number($('#feeAmount',root).value||0),entryDate=$('#feePaidDate',root).value,memo=$('#feeMemo',root).value.trim();if(!entryDate)return toast(status==='paid'?'납부일을 입력해 주세요.':'미납 처리일을 입력해 주세요.','error');if(status==='paid'&&amount<=0)return toast('실제 납부액을 입력해 주세요.','error');if(status==='unpaid'&&!memo)return toast('미납 처리 사유를 입력해 주세요.','error');upsertFee({year,month:mon,memberId:mid,amount,paidDate:entryDate,method:$('#feeMethod',root).value,memo,status,statusDate:entryDate,statusMemo:memo});feeViewMonth=mon;queueSave();closeModal();renderFees();toast(status==='paid'?'개별 회비 납부 내역을 저장했습니다.':'해당 회원을 미납 처리했습니다.','ok')};
  }});
}

function openBulkFeeModal(month=feeViewMonth) {
  const e=currentEvent(); const year=e?.year||new Date().getFullYear();
  const monthlyMembers=state.members.filter(m=>m.type==='monthly'&&m.active!==false).sort((a,b)=>a.name.localeCompare(b.name,'ko'));
  if(!monthlyMembers.length) return toast('월회비 회원을 먼저 등록해 주세요.','error');
  openModal({title:'월별 회비 일괄 입력',wide:true,body:`<div class="form-grid">
    <div class="field"><label>납부 대상 월</label><select id="bulkFeeMonth">${Array.from({length:12},(_,i)=>`<option value="${i+1}" ${Number(month)===i+1?'selected':''}>${i+1}월</option>`).join('')}</select></div>
    <div class="field"><label>1인 납부액</label><input id="bulkFeeAmount" type="number" min="0" step="1000" value="${Number(state.settings.monthlyFee||20000)}"></div>
    <div class="field"><label>공통 납부일</label><input id="bulkFeeDate" type="date" value="${new Date().toISOString().slice(0,10)}"></div>
    <div class="field"><label>입금 방법</label><select id="bulkFeeMethod">${Object.entries(FEE_METHOD).map(([k,v])=>`<option value="${k}" ${k==='auto'?'selected':''}>${v}</option>`).join('')}</select></div>
    <div class="field field-full"><label>공통 메모</label><input id="bulkFeeMemo" placeholder="예: 8월 자동이체 확인"></div>
    <div class="field field-full"><div class="card-title-row"><div><label class="field-label">납부 처리할 회원</label><div class="help">선택한 회원만 저장되며, 기존 내역이 있으면 입력값으로 수정됩니다.</div></div><span id="bulkFeeCount" class="badge primary"></span></div><div class="quick-selects"><button class="btn btn-sm" id="bulkSelectAll">전체 선택</button><button class="btn btn-sm" id="bulkSelectUnpaid">미납자만</button><button class="btn btn-sm" id="bulkClear">전체 해제</button></div><div class="checkbox-grid">${monthlyMembers.map(m=>`<label class="check-card"><input class="bulk-fee-check" type="checkbox" value="${m.id}" checked><div><strong>${esc(m.name)}</strong><span class="bulk-fee-status" data-member="${m.id}"></span></div></label>`).join('')}</div></div>
  </div>`,footer:`<button class="btn" id="cancelModal">취소</button><button class="btn btn-primary" id="saveBulkFee">선택 회원 일괄 저장</button>`,onOpen:root=>{
    const boxes=()=>$$('.bulk-fee-check',root); const mon=()=>Number($('#bulkFeeMonth',root).value);
    const refresh=()=>{boxes().forEach(b=>{const f=getFee(year,mon(),b.value);const label=$(`.bulk-fee-status[data-member="${b.value}"]`,root);if(label)label.textContent=f?.status==='paid'?`기존 ${money(f.amount)} · ${dateText(f.paidDate)}`:f?.status==='unpaid'?`미납 처리 · ${f.statusMemo||f.memo||''}`:'현재 미납'});$('#bulkFeeCount',root).textContent=`${boxes().filter(b=>b.checked).length}명 선택`};
    $('#cancelModal',root).onclick=closeModal; $('#bulkFeeMonth',root).onchange=refresh; boxes().forEach(b=>b.onchange=refresh);
    $('#bulkSelectAll',root).onclick=()=>{boxes().forEach(b=>b.checked=true);refresh()}; $('#bulkClear',root).onclick=()=>{boxes().forEach(b=>b.checked=false);refresh()}; $('#bulkSelectUnpaid',root).onclick=()=>{boxes().forEach(b=>b.checked=getFee(year,mon(),b.value)?.status!=='paid');refresh()}; refresh();
    $('#saveBulkFee',root).onclick=()=>{const selected=boxes().filter(b=>b.checked).map(b=>b.value),amount=Number($('#bulkFeeAmount',root).value||0),paidDate=$('#bulkFeeDate',root).value;if(!selected.length)return toast('납부 처리할 회원을 선택해 주세요.','error');if(amount<=0)return toast('1인 납부액을 입력해 주세요.','error');if(!paidDate)return toast('납부일을 입력해 주세요.','error');selected.forEach(mid=>upsertFee({year,month:mon(),memberId:mid,amount,paidDate,method:$('#bulkFeeMethod',root).value,memo:$('#bulkFeeMemo',root).value.trim()}));feeViewMonth=mon();queueSave();closeModal();renderFees();toast(`${feeViewMonth}월 회비 ${selected.length}명의 납부 내역을 저장했습니다.`,'ok')};
  }});
}

function renderEvent() {
  const e=currentEvent(); if(!e){renderDashboard();return;}
  $('#content').innerHTML=`
    <section class="card">
      <div class="card-title-row"><div><h2>${esc(e.title)}</h2><div class="help">연 2회 하계·동계 모임을 관리합니다.</div></div><button class="btn" data-action="new-event">＋ 새 하계·동계 모임</button></div>
      <div class="form-grid">
        <div class="field"><label>모임명</label><input id="eventTitle" value="${esc(e.title)}"></div>
        <div class="field"><label>구분</label><select id="eventSeason"><option value="summer" ${e.season==='summer'?'selected':''}>하계</option><option value="winter" ${e.season==='winter'?'selected':''}>동계</option></select></div>
        <div class="field"><label>시작일</label><input id="eventStart" type="date" value="${e.startDate||''}"></div>
        <div class="field"><label>종료일</label><input id="eventEnd" type="date" value="${e.endDate||''}"></div>
        <div class="field"><label>지역·장소</label><input id="eventLocation" value="${esc(e.location||'')}" placeholder="예: 전주 한옥마을"></div>
        <div class="field"><label>상태</label><select id="eventStatus">${Object.entries(STATUS_LABEL).map(([k,v])=>`<option value="${k}" ${e.status===k?'selected':''}>${v}</option>`).join('')}</select></div>
        <div class="field field-full"><label>모임 메모</label><textarea id="eventNotes" placeholder="집결 장소, 준비물, 특이사항 등">${esc(e.notes||'')}</textarea></div>
      </div>
    </section>
    <section class="card section-gap">
      <div class="card-title-row"><div><h2>전체 모임 참석자</h2><div class="help">중간 합류·조기 귀가 포함, 모임에 한 번이라도 참여하는 회원입니다.</div></div><button class="btn btn-sm" data-select-group="attendees">선택</button></div>
      ${chipsHtml(e.attendeeIds,'등록된 참석자가 없습니다.')}
    </section>
    <section class="card section-gap"><div class="notice"><strong>숙박 기록 위치 변경</strong><br>숙박자·숙박비·숙소 사진·예약 확인서는 이제 <b>이용 기록 → 숙박</b>에서 한 번에 관리합니다. 모임 설정에는 전체 참석자만 등록해 주세요.<div class="section-gap"><button class="btn btn-primary" data-action="add-lodging-record">🏡 숙박 기록 추가</button><button class="btn" data-page-jump="records">이용 기록으로 이동</button></div></div></section>`;
  bindCommonActions();
  const fields=[['#eventTitle','title'],['#eventStart','startDate'],['#eventEnd','endDate'],['#eventLocation','location'],['#eventStatus','status'],['#eventNotes','notes']];
  fields.forEach(([sel,key])=>$(sel)?.addEventListener('change',ev=>{e[key]=ev.target.value; if(key==='startDate') e.year=Number(ev.target.value.slice(0,4))||e.year; queueSave();renderEventSelector()}));
  $('#eventSeason')?.addEventListener('change',ev=>{e.season=ev.target.value;queueSave()});
  $$('[data-select-group]').forEach(btn=>btn.addEventListener('click',()=>openGroupSelector(btn.dataset.selectGroup)));
}
function chipsHtml(ids, placeholder) { return ids?.length ? `<div class="member-list">${ids.map(id=>member(id)).filter(Boolean).map(m=>`<span class="member-chip selected">${esc(m.name)}</span>`).join('')}</div>` : `<div class="empty"><div>${esc(placeholder)}</div></div>`; }

function renderRecords() {
  const e=currentEvent(); const all=eventRecords(); const filtered=recordFilter==='all'?all:all.filter(r=>r.category===recordFilter);
  const lodging=all.filter(r=>r.category==='lodging'); const lodgers=lodgerIdsForEvent(e);
  const legacyOnly=!lodging.length && (e.lodgerIds||[]).length>0;
  $('#content').innerHTML=`
    <section class="card">
      <div class="card-title-row"><div><h2>이용 기록 ${all.length}건</h2><div class="help">숙박·음식점·마트·여행지마다 실제 이용자, 결제자, 영수증, 현장 사진을 함께 저장합니다.</div></div><div class="inline-actions"><button class="btn" data-action="add-lodging-record">🏡 숙박 기록</button><button class="btn btn-primary" data-action="add-record">＋ 기록 추가</button></div></div>
      <div class="tabs"><button class="tab ${recordFilter==='all'?'active':''}" data-filter="all">전체</button>${Object.entries(CATEGORY).map(([k,v])=>`<button class="tab ${recordFilter===k?'active':''}" data-filter="${k}">${v.icon} ${v.label}</button>`).join('')}</div>
    </section>
    <section class="card section-gap"><div class="card-title-row"><div><h2>🏡 숙박 이용 현황</h2><div class="help">숙박 기록에서 선택한 이용자가 자동 집계됩니다.</div></div><span class="badge primary">${lodgers.length}명</span></div>${chipsHtml(lodgers,'아직 숙박 기록이 없습니다.')}${legacyOnly?`<div class="notice warn section-gap"><strong>이전 버전 숙박자 명단이 남아 있습니다.</strong><br>숙소명·숙박비·사진과 함께 정식 이용 기록으로 옮겨 주세요.<div class="section-gap"><button class="btn btn-primary" data-action="add-lodging-record">기존 명단으로 숙박 기록 만들기</button></div></div>`:''}</section>
    <section class="section-gap">${filtered.length?`<div class="record-grid">${filtered.map(recordCard).join('')}</div>`:emptyState('해당 이용 기록이 없습니다.','지출이나 여행지를 등록하고 영수증·사진을 첨부해 주세요.','<button class="btn btn-primary" data-action="add-record">＋ 기록 추가</button>')}</section>`;
  bindCommonActions();
  $$('[data-filter]').forEach(b=>b.addEventListener('click',()=>{recordFilter=b.dataset.filter;renderRecords()}));
}
function recordCard(r) {
  const cat=CATEGORY[r.category]||CATEGORY.other; const photo=attachment((r.photoIds||[])[0]);
  return `<article class="record-card"><div class="record-cover">${photo&&photo.contentType?.startsWith('image/')?`<img src="${esc(photo.url)}" alt="${esc(r.place)}">`:cat.icon}</div><div class="record-body"><div class="record-top"><div><div class="record-title">${esc(r.place||cat.label)}</div><div class="record-meta"><span>${cat.label}</span><span>${dateTimeText(r.datetime)}</span></div></div><span class="badge ${Number(r.amount)>0?'primary':'ok'}">${Number(r.amount)>0?'지출':'방문 기록'}</span></div><div class="record-amount">${money(r.amount)}</div><div class="record-meta"><span>이용 ${(r.participantIds||[]).length}명</span><span>${r.payerId?`결제 ${esc(member(r.payerId)?.name||'-')}`:'결제 없음'}</span><span>영수증 ${(r.receiptIds||[]).length}장</span><span>사진 ${(r.photoIds||[]).length}장</span></div>${r.description?`<div class="help">${esc(r.description)}</div>`:''}<div class="record-actions"><button class="btn btn-sm" data-edit-record="${r.id}">수정</button><button class="btn btn-sm btn-danger" data-delete-record="${r.id}">삭제</button></div></div></article>`;
}

function renderSettlement() {
  const e=currentEvent(); const calc=calculateSettlement(e);
  const payers=calc.rows.filter(r=>r.net>0); const refunds=calc.rows.filter(r=>r.net<0);
  $('#content').innerHTML=`
    <section class="grid grid-4">
      <div class="card stat"><div class="stat-label">총지출</div><div class="stat-value">${money(calc.totalExpense)}</div></div>
      <div class="card stat"><div class="stat-label">해당 모임 납부회비</div><div class="stat-value">${money(calc.eventFeePaid)}</div><div class="stat-sub">월회비 회원 ${feePeriodLabel(e)} 실제 납부액</div></div>
      <div class="card stat"><div class="stat-label">추가 납부 대상</div><div class="stat-value">${payers.length}명</div><div class="stat-sub">${money(payers.reduce((s,r)=>s+r.net,0))}</div></div>
      <div class="card stat"><div class="stat-label">환급 대상</div><div class="stat-value">${refunds.length}명</div><div class="stat-sub">${money(Math.abs(refunds.reduce((s,r)=>s+r.net,0)))}</div></div>
    </section>
    <section class="card section-gap">
      <div class="card-title-row"><div><h2>개인별 정산 결과</h2><div class="help">월회비 회원은 ${feePeriodLabel(e)} 실제 납부회비에서 이용액을 정산합니다. 최종값이 음수이면 환급, 양수이면 추가 납부입니다. 개인 선결제액도 환급에 반영됩니다.</div></div><button class="btn" data-page-jump="report">보고서로 보기</button></div>
      ${calc.rows.length?`<div class="table-wrap"><table><thead><tr><th>회원</th><th>유형</th><th class="num">실제 이용액</th><th class="num">해당 모임 회비</th><th class="num">선결제</th><th class="num">최종 결과</th></tr></thead><tbody>${calc.rows.map(r=>`<tr><td><strong>${esc(r.name)}</strong></td><td><span class="badge ${r.type==='monthly'?'primary':'dark'}">${r.type==='monthly'?'월회비':'모임별'}</span></td><td class="num">${money(r.used)}</td><td class="num">${r.type==='monthly'?money(r.feePaid):'-'}</td><td class="num">${money(r.advanced)}</td><td class="num"><strong style="color:${r.net>0?'#c04557':r.net<0?'#168163':'#596174'}">${settlementResultText(r)}</strong></td></tr>`).join('')}</tbody></table></div>`:emptyState('정산 대상이 없습니다.','참석자와 이용 기록을 먼저 등록해 주세요.')}
    </section>
    <section class="grid grid-2 section-gap">
      <div class="card"><div class="card-title-row"><h2>추가 납부할 회원</h2></div>${payers.length?`<div class="list">${payers.map(r=>`<div class="list-item"><strong>${esc(r.name)}</strong><strong style="color:#c04557">${money(r.net)}</strong></div>`).join('')}</div>`:emptyState('납부 대상이 없습니다.','')}</div>
      <div class="card"><div class="card-title-row"><h2>환급할 회원</h2></div>${refunds.length?`<div class="list">${refunds.map(r=>`<div class="list-item"><strong>${esc(r.name)}</strong><strong style="color:#168163">${money(Math.abs(r.net))}</strong></div>`).join('')}</div>`:emptyState('환급 대상이 없습니다.','')}</div>
    </section>
    <section class="card section-gap"><div class="notice warn"><strong>정산 기준</strong><br>하계는 2~7월, 동계는 8월~다음 해 1월의 실제 납부 완료 회비만 반영합니다. 미납 처리된 금액은 제외됩니다. 숙박비는 실제 숙박자, 음식점·마트·택시는 당시 이용자만 선택했는지 확인하세요.</div></section>`;
  bindCommonActions();
}

function renderReport() {
  const e=currentEvent(); const recs=eventRecords(); const receiptCount=recs.reduce((s,r)=>s+(r.receiptIds||[]).length,0); const photoCount=recs.reduce((s,r)=>s+(r.photoIds||[]).length,0);
  $('#content').innerHTML=`
    <section class="card hero"><p class="eyebrow">PHOTO SETTLEMENT REPORT</p><h2>${esc(e?.title||'모임 보고서')}</h2><p>PDF 보관용 보고서와 카카오톡에서 바로 열어볼 수 있는 PNG 이미지를 함께 만들 수 있습니다.</p><div class="hero-actions"><button class="btn btn-primary" data-action="open-report">보고서 미리보기·PDF</button><button class="btn" data-action="share-kakao-summary">카톡으로 요약 공유</button><button class="btn" data-action="share-kakao-full">카톡으로 전체 공유</button><button class="btn" data-action="download-kakao-summary">요약 PNG 저장</button><button class="btn" data-action="download-kakao-full">전체 PNG 저장</button><button class="btn" data-action="download-report">HTML 보고서 저장</button></div></section>
    <section class="grid grid-3 section-gap"><div class="card stat"><div class="stat-label">이용 기록</div><div class="stat-value">${recs.length}건</div></div><div class="card stat"><div class="stat-label">영수증·증빙</div><div class="stat-value">${receiptCount}장</div></div><div class="card stat"><div class="stat-label">보고서 사진</div><div class="stat-value">${photoCount}장</div></div></section>
    <section class="grid grid-2 section-gap">
      <div class="card"><div class="card-title-row"><h2>출력 형식</h2></div><div class="list"><div class="list-item"><span>공식 보관용 PDF</span><span class="badge ok">A4 인쇄</span></div><div class="list-item"><span>카톡용 정산 요약 PNG</span><span class="badge primary">정산표 중심</span></div><div class="list-item"><span>카톡용 전체 보고서 PNG</span><span class="badge primary">사진 포함</span></div><div class="list-item"><span>월회비 개인별 잔액 정산</span><span class="badge ok">${feePeriodLabel(e)} 반영</span></div><div class="list-item"><span>영수증 부록</span><span class="badge ok">포함</span></div></div></div>
      <div class="card"><div class="card-title-row"><h2>발행 전 확인</h2></div>${checklistHtml(e,recs)}<div class="notice section-gap"><strong>카카오톡 공유 팁</strong><br>먼저 ‘카톡용 정산 요약 PNG’를 올리고, 사진까지 공유할 때만 ‘전체 보고서 PNG’를 추가하세요. 원본 PDF는 공식 보관용으로 함께 저장하는 것이 좋습니다.</div></div>
    </section>`;
  bindCommonActions();
}

function renderBackup() {
  $('#content').innerHTML=`
    <section class="grid grid-2">
      <div class="card"><div class="card-title-row"><div><h2>휴대폰 전체 백업</h2><div class="help">회원·회비·모임·정산과 모든 영수증·사진을 전송 파일 하나로 보관합니다.</div></div></div><div class="inline-actions"><button class="btn btn-primary" data-action="share-backup">카카오톡·드라이브로 백업 공유</button><button class="btn" data-action="download-backup">전체 전송 파일(.rosa) 저장</button></div><div class="notice warn section-gap">휴대폰 분실·교체에 대비해 모임이 끝날 때마다 카카오톡 나에게 보내기, Google Drive 등에 보관해 주세요.</div></div>
      <div class="card"><div class="card-title-row"><div><h2>복원·PC 이동</h2><div class="help">PC에서 만든 전송 파일 또는 이 휴대폰의 백업 파일을 가져옵니다.</div></div></div><div class="inline-actions"><button class="btn" data-action="import-json">전송 파일 가져오기</button><button class="btn" data-action="export-json">장부 JSON만 저장</button></div><div class="help section-gap">사진까지 옮기려면 반드시 .rosa 전송 파일을 이용하세요.</div></div>
    </section>
    <section class="grid grid-2 section-gap">
      <div class="card"><div class="card-title-row"><h2>앱 설치</h2></div><button class="btn btn-primary btn-block" data-action="install-app">휴대폰 홈 화면에 앱 설치</button><div class="help section-gap">이미 설치했다면 이 버튼이 표시되지 않거나 설치 안내만 나옵니다.</div></div>
      <div class="card"><div class="card-title-row"><h2>저장 상태</h2></div><div class="list"><div class="list-item"><span>저장 위치</span><span class="badge ok">이 휴대폰</span></div><div class="list-item"><span>오프라인 입력</span><span class="badge ok">지원</span></div><div class="list-item"><span>사진 첨부</span><span class="badge primary">기록당 4장</span></div><div class="list-item"><span>사용 중인 저장공간</span><span id="storageUsageBadge" class="badge">확인 중</span></div><div class="list-item"><span>저장 보호 요청</span><span id="storagePersistBadge" class="badge">확인 중</span></div></div></div>
    </section>
    <section class="card section-gap"><div class="card-title-row"><h2>기본 설정</h2></div><div class="form-grid"><div class="field"><label>모임 이름</label><input id="clubNameSetting" value="${esc(state.settings.clubName||'우리 모임')}"></div><div class="field"><label>월회비</label><input id="monthlyFeeSetting" type="number" step="1000" value="${Number(state.settings.monthlyFee||0)}"></div></div></section>`;
  bindCommonActions();
  $('#clubNameSetting')?.addEventListener('change',e=>{state.settings.clubName=e.target.value.trim()||'우리 모임';queueSave()});
  $('#monthlyFeeSetting')?.addEventListener('change',e=>{state.settings.monthlyFee=Number(e.target.value||0);queueSave()});
  updateStorageInfo();
}

function bindCommonActions() {
  $$('[data-page-jump]').forEach(b=>b.addEventListener('click',()=>setPage(b.dataset.pageJump)));
  $$('[data-action="add-record"]').forEach(b=>b.addEventListener('click',()=>openRecordModal()));
  $$('[data-action="add-lodging-record"]').forEach(b=>b.addEventListener('click',()=>openRecordModal(null,'lodging')));
  $$('[data-edit-record]').forEach(b=>b.addEventListener('click',()=>openRecordModal(b.dataset.editRecord)));
  $$('[data-delete-record]').forEach(b=>b.addEventListener('click',()=>deleteRecord(b.dataset.deleteRecord)));
  $$('[data-action="add-member"]').forEach(b=>b.addEventListener('click',()=>openMemberModal()));
  $$('[data-action="bulk-member"]').forEach(b=>b.addEventListener('click',openBulkMemberModal));
  $$('[data-edit-member]').forEach(b=>b.addEventListener('click',()=>openMemberModal(b.dataset.editMember)));
  $$('[data-action="new-event"]').forEach(b=>b.addEventListener('click',openNewEventModal));
  $$('[data-action="copy-network"]').forEach(b=>b.addEventListener('click',copyNetwork));
  $$('[data-action="add-fund-tx"]').forEach(b=>b.addEventListener('click',openFundTxModal));
  $$('[data-action="pay-current-month"]').forEach(b=>b.addEventListener('click',payCurrentMonth));
  $$('[data-action="manual-fee-entry"]').forEach(b=>b.addEventListener('click',()=>openFeeEntryModal('',feeViewMonth)));
  $$('[data-action="bulk-fee-entry"]').forEach(b=>b.addEventListener('click',()=>openBulkFeeModal(feeViewMonth)));
  $$('[data-action="open-report"]').forEach(b=>b.addEventListener('click',()=>openReport(false)));
  $$('[data-action="download-report"]').forEach(b=>b.addEventListener('click',()=>openReport(true)));
  $$('[data-action="download-kakao-summary"]').forEach(b=>b.addEventListener('click',()=>downloadKakaoImage(false,b)));
  $$('[data-action="download-kakao-full"]').forEach(b=>b.addEventListener('click',()=>downloadKakaoImage(true,b)));
  $$('[data-action="share-kakao-summary"]').forEach(b=>b.addEventListener('click',()=>shareKakaoImage(false,b)));
  $$('[data-action="share-kakao-full"]').forEach(b=>b.addEventListener('click',()=>shareKakaoImage(true,b)));
  $$('[data-action="download-backup"]').forEach(b=>b.addEventListener('click',()=>downloadFullBackup(b)));
  $$('[data-action="share-backup"]').forEach(b=>b.addEventListener('click',()=>shareFullBackup(b)));
  $$('[data-action="export-json"]').forEach(b=>b.addEventListener('click',exportJson));
  $$('[data-action="import-json"]').forEach(b=>b.addEventListener('click',()=>$('#jsonImportInput').click()));
  $$('[data-action="install-app"]').forEach(b=>b.addEventListener('click',installMobileApp));
}


async function makeBackupFile() {
  const pkg = await buildMobileTransferPackage();
  const blob = new Blob([JSON.stringify(pkg)], {type:'application/json'});
  const filename = `ROSA_휴대폰전체백업_${new Date().toISOString().slice(0,10).replaceAll('-','')}.rosa`;
  return new File([blob], filename, {type:'application/json'});
}

async function downloadFullBackup(button) {
  const originalText = button?.textContent || '전체 전송 파일 저장';
  if (button) { button.disabled = true; button.textContent = '사진과 장부 묶는 중...'; }
  try {
    const file = await makeBackupFile();
    downloadBlob(file, file.name);
    state.settings.lastBackupAt = new Date().toISOString();
    queueSave(0);
    toast(`전체 전송 파일을 저장했습니다. (${(file.size/1024/1024).toFixed(1)}MB)`, 'ok');
  } catch (err) {
    toast(err.message || '전체 백업에 실패했습니다.', 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = originalText; }
  }
}

async function shareFullBackup(button) {
  const originalText = button?.textContent || '백업 공유';
  if (button) { button.disabled = true; button.textContent = '백업 만드는 중...'; }
  try {
    const file = await makeBackupFile();
    if (navigator.canShare?.({files:[file]})) {
      await navigator.share({title:'ROSA 모임정산 전체 백업', text:'회원·회비·이용 기록·사진 전체 백업입니다.', files:[file]});
      state.settings.lastBackupAt = new Date().toISOString();
      queueSave(0);
      toast('백업 파일을 공유했습니다.', 'ok');
    } else {
      downloadBlob(file, file.name);
      toast('이 브라우저는 파일 직접 공유를 지원하지 않아 다운로드로 저장했습니다.', 'warn');
    }
  } catch (err) {
    if (err?.name !== 'AbortError') toast(err.message || '백업 공유에 실패했습니다.', 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = originalText; }
  }
}

function copyNetwork() { toast('이 버전은 PC 연결 없이 휴대폰에서 단독 실행됩니다.', 'ok'); }

async function installMobileApp() {
  if (window.matchMedia('(display-mode: standalone)').matches) return toast('이미 앱으로 설치되어 있습니다.', 'ok');
  if (installPromptEvent) {
    installPromptEvent.prompt();
    const result = await installPromptEvent.userChoice;
    installPromptEvent = null;
    return toast(result.outcome === 'accepted' ? '앱 설치를 시작했습니다.' : '설치를 취소했습니다.', result.outcome === 'accepted' ? 'ok' : '');
  }
  toast('Chrome 메뉴의 “홈 화면에 추가” 또는 “앱 설치”를 선택해 주세요.', 'warn');
}

function openModal({title, body, footer='', wide=false, onOpen}) {
  const root=$('#modalRoot');
  root.innerHTML=`<div class="modal-backdrop"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true"><header class="modal-head"><h2>${esc(title)}</h2><button class="modal-close" aria-label="닫기">×</button></header><div class="modal-body">${body}</div>${footer?`<footer class="modal-foot">${footer}</footer>`:''}</section></div>`;
  $('.modal-close',root).addEventListener('click',closeModal); $('.modal-backdrop',root).addEventListener('click',e=>{if(e.target.classList.contains('modal-backdrop'))closeModal()});
  onOpen?.(root);
}
function closeModal(){ $('#modalRoot').innerHTML=''; }

function openMemberModal(id=null) {
  const m=id?member(id):{name:'',type:'monthly',active:true,note:''};
  openModal({title:id?'회원 수정':'회원 추가',body:`<div class="form-grid"><div class="field"><label class="required">이름</label><input id="memberName" value="${esc(m.name)}" autofocus></div><div class="field"><label>회원 유형</label><select id="memberType"><option value="monthly" ${m.type==='monthly'?'selected':''}>월회비 회원</option><option value="event" ${m.type==='event'?'selected':''}>모임별 정산 회원</option></select></div><div class="field"><label>상태</label><select id="memberActive"><option value="true" ${m.active!==false?'selected':''}>활동</option><option value="false" ${m.active===false?'selected':''}>휴회</option></select></div><div class="field"><label>메모</label><input id="memberNote" value="${esc(m.note||'')}"></div></div>`,footer:`${id?'<button class="btn btn-danger" id="deleteMemberBtn">회원 삭제</button>':''}<button class="btn" id="cancelModal">취소</button><button class="btn btn-primary" id="saveMemberBtn">저장</button>`,onOpen:root=>{
    $('#cancelModal',root).onclick=closeModal;
    $('#saveMemberBtn',root).onclick=()=>{const name=$('#memberName',root).value.trim();if(!name)return toast('이름을 입력해 주세요.','error');if(id){Object.assign(m,{name,type:$('#memberType',root).value,active:$('#memberActive',root).value==='true',note:$('#memberNote',root).value.trim()})}else state.members.push({id:uid('mem'),name,type:$('#memberType',root).value,active:true,note:$('#memberNote',root).value.trim()});queueSave();closeModal();renderPage()};
    $('#deleteMemberBtn',root)?.addEventListener('click',()=>{const used=state.records.some(r=>r.payerId===id||(r.participantIds||[]).includes(id))||state.events.some(e=>(e.attendeeIds||[]).includes(id));if(used)return toast('모임 또는 지출 기록에 사용된 회원은 삭제 대신 휴회로 바꿔 주세요.','error');if(confirm('회원 정보를 삭제할까요?')){state.members=state.members.filter(x=>x.id!==id);queueSave();closeModal();renderMembers()}});
  }});
}

function openBulkMemberModal() {
  openModal({title:'여러 명 빠른 등록',body:`<div class="field"><label>회원 이름</label><textarea id="bulkNames" rows="10" placeholder="한 줄에 한 명씩 입력하세요.\n김민수\n박영호\n이현수"></textarea></div><div class="field section-gap"><label>기본 회원 유형</label><select id="bulkType"><option value="monthly">월회비 회원</option><option value="event">모임별 정산 회원</option></select></div><div class="notice section-gap">등록 후 개별 회원의 유형을 따로 수정할 수 있습니다.</div>`,footer:`<button class="btn" id="cancelModal">취소</button><button class="btn btn-primary" id="saveBulkBtn">한 번에 등록</button>`,onOpen:root=>{
    $('#cancelModal',root).onclick=closeModal; $('#saveBulkBtn',root).onclick=()=>{const names=$('#bulkNames',root).value.split(/\r?\n|,/).map(v=>v.trim()).filter(Boolean);if(!names.length)return toast('이름을 입력해 주세요.','error');const type=$('#bulkType',root).value;let count=0;names.forEach(name=>{if(!state.members.some(m=>m.name===name)){state.members.push({id:uid('mem'),name,type,active:true,note:''});count++}});queueSave();closeModal();renderMembers();toast(`${count}명을 등록했습니다.`,'ok')};
  }});
}

function openNewEventModal() {
  const year=new Date().getFullYear();
  openModal({title:'새 하계·동계 모임',body:`<div class="form-grid"><div class="field"><label>연도</label><input id="newEventYear" type="number" value="${year}"></div><div class="field"><label>구분</label><select id="newEventSeason"><option value="summer">하계</option><option value="winter">동계</option></select></div><div class="field"><label>시작일</label><input id="newEventStart" type="date"></div><div class="field"><label>종료일</label><input id="newEventEnd" type="date"></div></div>`,footer:`<button class="btn" id="cancelModal">취소</button><button class="btn btn-primary" id="createEventBtn">만들기</button>`,onOpen:root=>{
    $('#cancelModal',root).onclick=closeModal; $('#createEventBtn',root).onclick=()=>{const y=Number($('#newEventYear',root).value)||year;const s=$('#newEventSeason',root).value;const evt={id:uid('evt'),year:y,season:s,title:`${y}년 ${seasonName(s)} 모임`,startDate:$('#newEventStart',root).value,endDate:$('#newEventEnd',root).value,location:'',status:'preparing',attendeeIds:[],lodgerIds:[],notes:'',createdAt:new Date().toISOString()};state.events.push(evt);state.currentEventId=evt.id;queueSave();closeModal();setPage('event')};
  }});
}

function openGroupSelector(group) {
  const e=currentEvent(); const selected=new Set(e.attendeeIds||[]); const candidates=activeMembers();
  openModal({title:'전체 참석자 선택',body:`<div class="quick-selects"><button class="btn btn-sm" id="selectAllGroup">전체 선택</button><button class="btn btn-sm" id="clearGroup">전체 해제</button></div><div class="checkbox-grid">${candidates.map(m=>`<label class="check-card"><input type="checkbox" value="${m.id}" ${selected.has(m.id)?'checked':''}><div><strong>${esc(m.name)}</strong><span>${m.type==='monthly'?'월회비':'모임별 정산'}</span></div></label>`).join('')||'<div class="empty">선택할 회원이 없습니다.</div>'}</div>`,footer:`<button class="btn" id="cancelModal">취소</button><button class="btn btn-primary" id="applyGroup">적용</button>`,onOpen:root=>{
    $('#cancelModal',root).onclick=closeModal; $('#selectAllGroup',root).onclick=()=>$$('input[type=checkbox]',root).forEach(i=>i.checked=true);$('#clearGroup',root).onclick=()=>$$('input[type=checkbox]',root).forEach(i=>i.checked=false);$('#applyGroup',root).onclick=()=>{const ids=$$('input[type=checkbox]:checked',root).map(i=>i.value);e.attendeeIds=ids;e.lodgerIds=(e.lodgerIds||[]).filter(id=>ids.includes(id));queueSave();closeModal();renderEvent()};
  }});
}

function openFundTxModal() {
  openModal({title:'기타 공동회비 거래',body:`<div class="form-grid"><div class="field"><label>구분</label><select id="fundKind"><option value="income">수입</option><option value="expense">지출</option></select></div><div class="field"><label>일자</label><input id="fundDate" type="date" value="${new Date().toISOString().slice(0,10)}"></div><div class="field"><label>금액</label><input id="fundAmount" type="number" min="0" step="1000"></div><div class="field"><label>내용</label><input id="fundDesc" placeholder="예: 이자, 지원금, 별도 지출"></div></div>`,footer:`<button class="btn" id="cancelModal">취소</button><button class="btn btn-primary" id="saveFund">저장</button>`,onOpen:root=>{$('#cancelModal',root).onclick=closeModal;$('#saveFund',root).onclick=()=>{const amount=Number($('#fundAmount',root).value||0),desc=$('#fundDesc',root).value.trim();if(!amount||!desc)return toast('금액과 내용을 입력해 주세요.','error');state.fundTransactions.push({id:uid('fund'),kind:$('#fundKind',root).value,date:$('#fundDate',root).value,amount,description:desc});queueSave();closeModal();renderFees()}}});
}
function payCurrentMonth(){feeViewMonth=new Date().getMonth()+1;openBulkFeeModal(feeViewMonth)}

function participantCheckHtml(selected, candidates) { const set=new Set(selected); return candidates.map(m=>`<label class="check-card"><input class="participant-check" type="checkbox" value="${m.id}" ${set.has(m.id)?'checked':''}><div><strong>${esc(m.name)}</strong><span>${m.type==='monthly'?'월회비':'모임별 정산'}</span></div></label>`).join(''); }
function participantSummary(ids){return ids.length?ids.map(id=>`<span class="member-chip selected">${esc(member(id)?.name||'')}</span>`).join(''):'<span class="placeholder">실제 이용자를 선택해 주세요.</span>'}

function openRecordModal(recordId=null, presetCategory=null) {
  const e=currentEvent(); if(!e)return toast('모임을 먼저 만들어 주세요.','error'); if(!e.attendeeIds.length)return toast('모임 설정에서 참석자를 먼저 선택해 주세요.','error');
  const existing=recordId?state.records.find(r=>r.id===recordId):null;
  const defaultDate=`${e.startDate||new Date().toISOString().slice(0,10)}T12:00`;
  const category=presetCategory||'restaurant';
  const lodgingDefaults=lodgerIdsForEvent(e);
  const defaultParticipants=category==='lodging'?lodgingDefaults:(['taxi','driver'].includes(category)?[]:[...e.attendeeIds]);
  const draft=existing?JSON.parse(JSON.stringify(existing)):{id:uid('rec'),eventId:e.id,category,place:'',datetime:defaultDate,amount:0,payerId:'',paymentSource:'personal',participantIds:defaultParticipants,description:'',receiptIds:[],photoIds:[],createdAt:new Date().toISOString()};
  const existingReceipts=(draft.receiptIds||[]).map(attachment).filter(Boolean), existingPhotos=(draft.photoIds||[]).map(attachment).filter(Boolean);
  openModal({title:existing?'이용 기록 수정':draft.category==='lodging'?'숙박 기록 추가':'이용 기록 추가',wide:true,body:`
    <div class="form-grid">
      <div class="field"><label class="required">분류</label><select id="recordCategory">${Object.entries(CATEGORY).map(([k,v])=>`<option value="${k}" ${draft.category===k?'selected':''}>${v.icon} ${v.label}</option>`).join('')}</select></div>
      <div class="field"><label class="required">장소·사용처</label><input id="recordPlace" value="${esc(draft.place)}" placeholder="예: ○○펜션, 전주갈비, CU 편의점"></div>
      <div class="field"><label class="required">이용 일시</label><input id="recordDateTime" type="datetime-local" value="${String(draft.datetime||'').slice(0,16)}"></div>
      <div class="field"><label>지출 금액</label><input id="recordAmount" type="number" min="0" step="100" value="${Number(draft.amount||0)}" placeholder="여행지 기록만 남길 때는 0"></div>
      <div class="field"><label>결제자</label><select id="recordPayer"><option value="">지출 없음·선택 안 함</option>${e.attendeeIds.map(id=>member(id)).filter(Boolean).map(m=>`<option value="${m.id}" ${draft.payerId===m.id?'selected':''}>${esc(m.name)}</option>`).join('')}</select></div>
      <div class="field"><label>결제 재원</label><select id="paymentSource"><option value="personal" ${draft.paymentSource==='personal'?'selected':''}>회원 개인 선결제</option><option value="common" ${draft.paymentSource==='common'?'selected':''}>공동회비에서 직접 결제</option></select></div>
      <div class="field field-full"><label class="required">실제 이용자</label><div id="participantBox" class="multi-select-box">${participantSummary(draft.participantIds)}<button type="button" class="btn btn-sm select-trigger" id="toggleParticipants">선택 ▼</button></div><div id="participantPanel" class="upload-box" style="display:none;margin-top:8px"><div class="quick-selects"><button type="button" class="btn btn-sm" id="selectAttendees">참석자 전체</button><button type="button" class="btn btn-sm" id="selectLodgers">숙박 기록 이용자</button><button type="button" class="btn btn-sm" id="clearParticipants">전체 해제</button></div><input class="modal-search" id="participantSearch" placeholder="이름 검색"><div id="participantChecks" class="checkbox-grid">${participantCheckHtml(draft.participantIds,attendees(e))}</div></div><div class="help"><span id="participantCount">${draft.participantIds.length}명 선택</span> · <span id="perPersonPreview">예상 1인당 ${money(draft.participantIds.length?Number(draft.amount||0)/draft.participantIds.length:0)}</span></div></div>
      <div class="field field-full"><label>설명·이용 메모</label><textarea id="recordDescription" placeholder="주문 메뉴, 구입 품목, 이동 구간, 여행지 설명 등을 입력하세요.">${esc(draft.description||'')}</textarea></div>
      <div class="field field-full"><label>영수증·증빙</label><div class="upload-box"><div class="upload-actions"><label class="btn"><input id="receiptFiles" type="file" accept="image/*,application/pdf" capture="environment" multiple>📷 영수증 촬영·첨부</label></div><div id="receiptUploadStatus" class="upload-status">카드 영수증, 계좌이체 화면, 예약 확인서, 택시 결제 내역</div><div id="receiptPreview" class="upload-preview">${attachmentPreviewHtml(existingReceipts,'receipt')}</div></div></div>
      <div class="field field-full"><label>이용·현장 사진 <span class="badge primary">최대 ${MAX_RECORD_PHOTOS}장</span></label><div class="upload-box"><div class="upload-actions"><label class="btn"><input id="photoFiles" type="file" accept="image/*" capture="environment" multiple>📷 장소·음식·여행 사진</label></div><div id="photoUploadStatus" class="upload-status">현재 ${existingPhotos.length}장 · 최대 ${MAX_RECORD_PHOTOS}장까지 첨부할 수 있습니다.</div><div id="photoPreview" class="upload-preview">${attachmentPreviewHtml(existingPhotos,'photo')}</div></div></div>
    </div>`,footer:`<button class="btn" id="cancelModal">취소</button><button class="btn btn-primary" id="saveRecordBtn">${existing?'수정 저장':'기록 저장'}</button>`,onOpen:root=>setupRecordForm(root,draft,existing)});
}

function attachmentPreviewHtml(list, kind){return list.map(a=>`<div class="thumb" data-existing-attachment="${a.id}">${a.contentType==='application/pdf'?'<div style="display:grid;place-items:center;width:100%;height:100%;font-size:11px">PDF</div>':`<img src="${esc(a.url)}" alt="첨부">`}<button type="button" class="remove" data-remove-attachment="${a.id}" data-kind="${kind}">×</button></div>`).join('')}

function setupRecordForm(root,draft,existing){
  const e=currentEvent(); const removed=new Set();
  const updateParticipants=()=>{
    draft.participantIds=$$('.participant-check:checked',root).map(i=>i.value);
    const box=$('#participantBox',root); box.innerHTML=`${participantSummary(draft.participantIds)}<button type="button" class="btn btn-sm select-trigger" id="toggleParticipants">선택 ▲</button>`;
    $('#toggleParticipants',root).onclick=()=>{const p=$('#participantPanel',root);p.style.display=p.style.display==='none'?'block':'none'};
    $('#participantCount',root).textContent=`${draft.participantIds.length}명 선택`;
    const amount=Number($('#recordAmount',root).value||0);$('#perPersonPreview',root).textContent=`예상 1인당 ${money(draft.participantIds.length?amount/draft.participantIds.length:0)}`;
  };
  $('#toggleParticipants',root).onclick=()=>{const p=$('#participantPanel',root);p.style.display=p.style.display==='none'?'block':'none'};
  $$('.participant-check',root).forEach(i=>i.onchange=updateParticipants);
  $('#selectAttendees',root).onclick=()=>{$$('.participant-check',root).forEach(i=>i.checked=true);updateParticipants()};
  $('#selectLodgers',root).onclick=()=>{const ids=lodgerIdsForEvent(e);$$('.participant-check',root).forEach(i=>i.checked=ids.includes(i.value));updateParticipants()};
  $('#clearParticipants',root).onclick=()=>{$$('.participant-check',root).forEach(i=>i.checked=false);updateParticipants()};
  $('#participantSearch',root).oninput=ev=>{$$('.check-card',root).forEach(c=>c.style.display=c.textContent.includes(ev.target.value.trim())?'flex':'none')};
  $('#recordAmount',root).oninput=updateParticipants;
  $('#recordCategory',root).onchange=ev=>{if(existing)return;const cat=ev.target.value;const ids=cat==='lodging'?lodgerIdsForEvent(e):[];$$('.participant-check',root).forEach(i=>i.checked=(cat==='lodging'?ids.includes(i.value):['taxi','driver'].includes(cat)?false:true));updateParticipants()};
  const renderNewPreviews=(inputId,containerId)=>{const input=$(`#${inputId}`,root),container=$(`#${containerId}`,root);$$('[data-new-preview]',container).forEach(x=>{const img=$('img',x);if(img?.src?.startsWith('blob:'))URL.revokeObjectURL(img.src);x.remove()});[...input.files].forEach(file=>{const d=document.createElement('div');d.className='thumb';d.dataset.newPreview='1';if(file.type.startsWith('image/')){const img=document.createElement('img');img.src=URL.createObjectURL(file);d.appendChild(img)}else d.innerHTML='<div style="display:grid;place-items:center;width:100%;height:100%;font-size:11px">PDF</div>';container.appendChild(d)})};
  const survivingPhotoCount=()=>Math.max(0,(draft.photoIds||[]).filter(id=>!removed.has(id)).length);
  const updatePhotoStatus=()=>{const selected=$('#photoFiles',root)?.files?.length||0,total=survivingPhotoCount()+selected,remaining=Math.max(0,MAX_RECORD_PHOTOS-total);const status=$('#photoUploadStatus',root);if(status)status.textContent=`현장 사진 ${total}/${MAX_RECORD_PHOTOS}장 · ${remaining?`${remaining}장 더 첨부 가능`:'첨부 한도에 도달했습니다.'}`};
  $('#receiptFiles',root).onchange=ev=>{renderNewPreviews('receiptFiles','receiptPreview');$('#receiptUploadStatus',root).textContent=ev.target.files.length?`${ev.target.files.length}개 파일 선택됨 · 저장 버튼을 누르면 업로드됩니다.`:'첨부할 파일을 선택해 주세요.'};
  $('#photoFiles',root).onchange=ev=>{const input=ev.target,current=survivingPhotoCount(),available=Math.max(0,MAX_RECORD_PHOTOS-current),files=[...input.files];if(files.length>available){if(!available){input.value='';toast(`이용·현장 사진은 최대 ${MAX_RECORD_PHOTOS}장까지 첨부할 수 있습니다.`,'error')}else{const dt=new DataTransfer();files.slice(0,available).forEach(file=>dt.items.add(file));input.files=dt.files;toast(`현장 사진은 남은 ${available}장만 선택했습니다. 한 기록당 최대 ${MAX_RECORD_PHOTOS}장입니다.`,'warn')}}renderNewPreviews('photoFiles','photoPreview');updatePhotoStatus()};
  $$('[data-remove-attachment]',root).forEach(btn=>btn.onclick=()=>{removed.add(btn.dataset.removeAttachment);btn.closest('.thumb').remove();if(btn.dataset.kind==='photo')updatePhotoStatus()});
  updatePhotoStatus();
  $('#cancelModal',root).onclick=closeModal;
  $('#saveRecordBtn',root).onclick=async()=>{
    const place=$('#recordPlace',root).value.trim(),datetime=$('#recordDateTime',root).value,amount=Number($('#recordAmount',root).value||0);updateParticipants();
    if(!place||!datetime)return toast('장소와 이용 일시를 입력해 주세요.','error');
    if(amount>0&&!draft.participantIds.length)return toast('실제 이용자를 한 명 이상 선택해 주세요.','error');
    if(amount>0&&$('#paymentSource',root).value==='personal'&&!$('#recordPayer',root).value)return toast('개인 선결제라면 결제자를 선택해 주세요.','error');
    const retainedPhotoCount=(draft.photoIds||[]).filter(id=>!removed.has(id)).length,newPhotoCount=$('#photoFiles',root).files.length;
    if(retainedPhotoCount+newPhotoCount>MAX_RECORD_PHOTOS)return toast(`이용·현장 사진은 한 기록당 최대 ${MAX_RECORD_PHOTOS}장까지 저장할 수 있습니다.`,'error');
    const btn=$('#saveRecordBtn',root);btn.disabled=true;btn.textContent='휴대폰 저장소 확인 중...';
    const uploaded=[];
    try{
      clearTimeout(saveTimer);
      await api('/api/health');
      const receiptFiles=[...$('#receiptFiles',root).files], photoFiles=[...$('#photoFiles',root).files];
      const setProgress=(kind,text)=>{const el=$(`#${kind==='receipt'?'receiptUploadStatus':'photoUploadStatus'}`,root);if(el)el.textContent=text;btn.textContent=text};
      const newReceipts=await uploadFiles(receiptFiles,'receipt',text=>setProgress('receipt',text));uploaded.push(...newReceipts);
      const newPhotos=await uploadFiles(photoFiles,'photo',text=>setProgress('photo',text));uploaded.push(...newPhotos);
      btn.textContent='휴대폰에 저장 중...';

      const nextState=JSON.parse(JSON.stringify(state));
      nextState.attachments=nextState.attachments.filter(a=>!removed.has(a.id));
      nextState.attachments.push(...newReceipts,...newPhotos);
      const nextDraft={...draft,category:$('#recordCategory',root).value,place,datetime,amount,payerId:$('#recordPayer',root).value,paymentSource:$('#paymentSource',root).value,description:$('#recordDescription',root).value.trim(),receiptIds:[...(draft.receiptIds||[]).filter(id=>!removed.has(id)),...newReceipts.map(a=>a.id)],photoIds:[...(draft.photoIds||[]).filter(id=>!removed.has(id)),...newPhotos.map(a=>a.id)],updatedAt:new Date().toISOString()};
      const idx=nextState.records.findIndex(r=>r.id===nextDraft.id);if(idx>=0)nextState.records[idx]=nextDraft;else nextState.records.push(nextDraft);
      syncLegacyLodgers(nextState,e.id);
      state=await persistSnapshot(nextState);
      setSync('자동 저장됨','ok');
      removed.forEach(id=>deleteLocalAttachment(id).catch(()=>{}));
      closeModal();renderPage();toast(existing?'이용 기록과 사진을 수정했습니다.':'이용 기록과 사진을 저장했습니다.','ok');
    }catch(err){
      uploaded.forEach(a=>deleteLocalAttachment(a.id).catch(()=>{}));
      toast(err.message||'사진 저장에 실패했습니다.','error');btn.disabled=false;btn.textContent=existing?'수정 저장':'기록 저장';
    }
  };
}

async function imageToJpeg(file){
  if(!file.type.startsWith('image/')||file.type==='image/gif')return file;
  if(file.size<1200*1024 && ['image/jpeg','image/png','image/webp'].includes(file.type))return file;
  let url='';
  try{
    url=URL.createObjectURL(file);
    const img=await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error('사진 미리보기를 읽지 못했습니다.'));image.src=url});
    const maxSide=2000,scale=Math.min(1,maxSide/Math.max(img.naturalWidth||img.width,img.naturalHeight||img.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round((img.naturalWidth||img.width)*scale));canvas.height=Math.max(1,Math.round((img.naturalHeight||img.height)*scale));
    canvas.getContext('2d',{alpha:false}).drawImage(img,0,0,canvas.width,canvas.height);
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('사진 변환에 실패했습니다.')),'image/jpeg',0.88));
    return new File([blob],`${file.name.replace(/\.[^.]+$/,'')||'photo'}.jpg`,{type:'image/jpeg',lastModified:file.lastModified});
  }catch(_){return file}finally{if(url)URL.revokeObjectURL(url)}
}

async function uploadFiles(files,kind,onStatus){
  const out=[];
  for(let i=0;i<files.length;i++){
    onStatus?.(`${kind==='receipt'?'영수증':'사진'} ${i+1}/${files.length} 휴대폰 저장 중...`);
    const prepared=await imageToJpeg(files[i]);
    const meta=await storeMobileAttachment(prepared);
    out.push({...meta,kind,caption:'',reportUse:true});
  }
  if(files.length)onStatus?.(`${files.length}개 파일 휴대폰 저장 완료`);
  return out;
}
function deleteRecord(id){const r=state.records.find(x=>x.id===id);if(!r||!confirm(`${r.place} 기록을 삭제할까요?`))return;const ids=[...(r.receiptIds||[]),...(r.photoIds||[])];state.records=state.records.filter(x=>x.id!==id);state.attachments=state.attachments.filter(a=>!ids.includes(a.id));syncLegacyLodgers(state,r.eventId);ids.forEach(a=>deleteLocalAttachment(a).catch(()=>{}));queueSave();renderRecords();toast('기록을 삭제했습니다.','ok')}


async function buildReportHtml() {
  const e=currentEvent(),calc=calculateSettlement(e),recs=eventRecords(),lodgers=lodgerIdsForEvent(e);
  const photoIds=recs.flatMap(r=>r.photoIds||[]),receiptIds=recs.flatMap(r=>r.receiptIds||[]); const imageMap={};
  for(const id of [...new Set([...photoIds,...receiptIds])]){const a=attachment(id);if(a&&a.contentType?.startsWith('image/')){try{imageMap[id]=await urlToDataUrl(a.url)}catch(_){imageMap[id]=a.url}}}
  const coverId=photoIds[0];
  const recordSections=recs.map((r,idx)=>{const cat=CATEGORY[r.category]||CATEGORY.other;const photos=(r.photoIds||[]).map(id=>imageMap[id]).filter(Boolean);return `<section class="record"><div class="record-head"><div><span class="cat">${cat.icon} ${cat.label}</span><h2>${esc(r.place||cat.label)}</h2><p>${dateTimeText(r.datetime)} · 실제 이용자 ${(r.participantIds||[]).length}명</p></div><div class="amount">${money(r.amount)}</div></div><div class="details"><span><b>이용자</b> ${esc(memberNames(r.participantIds).join(', ')||'-')}</span><span><b>결제자</b> ${esc(member(r.payerId)?.name||'공동회비·지출 없음')}</span><span><b>결제 방식</b> ${r.paymentSource==='common'?'공동회비 직접 결제':'회원 개인 선결제'}</span></div>${r.description?`<p class="desc">${esc(r.description)}</p>`:''}${photos.length?`<div class="photos ${photos.length===1?'one':''}">${photos.map(src=>`<img src="${src}">`).join('')}</div>`:'<div class="no-photo">등록된 이용 사진 없음</div>'}</section>`}).join('');
  const receipts=receiptIds.map(id=>{const a=attachment(id);if(!a)return'';if(a.contentType==='application/pdf')return `<div class="receipt pdf">PDF 증빙: ${esc(a.originalName)}</div>`;return `<div class="receipt"><img src="${imageMap[id]||a.url}"><small>${esc(a.originalName||'영수증')}</small></div>`}).join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(e.title)} 정산 보고서</title><style>
  @page{size:A4;margin:14mm}*{box-sizing:border-box}body{font-family:"Malgun Gothic",Arial,sans-serif;color:#182033;margin:0;line-height:1.55}header.cover{min-height:250mm;display:flex;flex-direction:column;justify-content:flex-end;page-break-after:always;background:#172033;color:#fff;padding:22mm;position:relative;overflow:hidden}.cover:after{content:"";position:absolute;width:150mm;height:150mm;border-radius:50%;right:-55mm;top:-55mm;background:linear-gradient(135deg,#5975ff,#28aa9c);opacity:.55}.cover .cover-photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.35}.cover>div{position:relative;z-index:2}.cover h1{font-size:34pt;margin:0 0 8px}.cover p{font-size:13pt;color:#dbe2f4}.tag{font-size:10pt;letter-spacing:.15em;color:#aebcff;font-weight:bold}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:0 0 20px}.kpi{border:1px solid #dfe4ed;border-radius:12px;padding:12px}.kpi small{display:block;color:#6f7788}.kpi strong{display:block;font-size:17pt;margin-top:5px}.section-title{font-size:19pt;margin:0 0 14px;border-bottom:3px solid #526df5;padding-bottom:7px}.overview{page-break-after:always}table{width:100%;border-collapse:collapse;font-size:9.5pt}th,td{border-bottom:1px solid #e5e8ef;padding:8px;text-align:left}th{background:#f4f6fa}.num{text-align:right}.record{page-break-inside:avoid;border:1px solid #dfe4ed;border-radius:14px;padding:15px;margin:0 0 16px}.record-head{display:flex;justify-content:space-between;gap:12px}.record-head h2{margin:4px 0;font-size:17pt}.record-head p{margin:0;color:#6f7788}.cat{font-size:9pt;color:#526df5;font-weight:bold}.amount{font-size:17pt;font-weight:bold;white-space:nowrap}.details{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0;font-size:9.5pt;color:#4e5769}.desc{background:#f6f7fa;padding:10px;border-radius:9px}.photos{display:grid;grid-template-columns:repeat(2,1fr);gap:7px}.photos.one{grid-template-columns:1fr}.photos img{width:100%;height:68mm;object-fit:cover;border-radius:9px}.no-photo{color:#9aa1af;background:#f7f8fa;padding:16px;text-align:center;border-radius:9px}.receipt-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}.receipt{border:1px solid #dfe4ed;border-radius:9px;padding:6px;page-break-inside:avoid}.receipt img{width:100%;height:75mm;object-fit:contain}.receipt small{display:block;color:#6f7788;word-break:break-all}.receipt.pdf{height:40mm;display:grid;place-items:center}.page-break{page-break-before:always}.printbar{position:fixed;top:10px;right:10px;z-index:99}@media print{.printbar{display:none}}@media(max-width:700px){.summary{grid-template-columns:repeat(2,1fr)}.photos,.receipt-grid{grid-template-columns:1fr}header.cover{min-height:100vh}}
  </style></head><body><button class="printbar" onclick="window.print()">인쇄 · PDF 저장</button><header class="cover">${coverId?`<img class="cover-photo" src="${imageMap[coverId]||attachment(coverId)?.url}">`:''}<div><div class="tag">ROSA GATHER LEDGER</div><h1>${esc(e.title)}</h1><p>${dateText(e.startDate)} ~ ${dateText(e.endDate)}<br>${esc(e.location||'')}</p></div></header>
  <section class="overview"><h1 class="section-title">모임 및 정산 개요</h1><div class="summary"><div class="kpi"><small>전체 지출</small><strong>${money(calc.totalExpense)}</strong></div><div class="kpi"><small>참석자</small><strong>${e.attendeeIds.length}명</strong></div><div class="kpi"><small>숙박자</small><strong>${lodgers.length}명</strong></div><div class="kpi"><small>공동회비 부담</small><strong>${money(calc.commonBurden)}</strong></div></div><h2>참석자</h2><p>${esc(memberNames(e.attendeeIds).join(', ')||'-')}</p><h2>실제 숙박자</h2><p>${esc(memberNames(lodgers).join(', ')||'-')}</p><h2>지출 분류별 요약</h2><table><thead><tr><th>분류</th><th class="num">금액</th></tr></thead><tbody>${Object.entries(calc.categoryTotals).map(([k,v])=>`<tr><td>${CATEGORY[k]?.icon||''} ${CATEGORY[k]?.label||k}</td><td class="num">${money(v)}</td></tr>`).join('')}</tbody></table><h2>개인별 정산</h2><p style="font-size:9pt;color:#6f7788">월회비 회원은 ${feePeriodLabel(e)} 실제 납부회비를 반영합니다. 음수 결과는 환급입니다.</p><table><thead><tr><th>회원</th><th>유형</th><th class="num">이용액</th><th class="num">납부회비</th><th class="num">선결제</th><th class="num">최종</th></tr></thead><tbody>${calc.rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${r.type==='monthly'?'월회비':'모임별'}</td><td class="num">${money(r.used)}</td><td class="num">${r.type==='monthly'?money(r.feePaid):'-'}</td><td class="num">${money(r.advanced)}</td><td class="num">${settlementResultText(r)}</td></tr>`).join('')}</tbody></table></section>
  <section><h1 class="section-title">장소별 이용 기록</h1>${recordSections||'<p>등록된 이용 기록이 없습니다.</p>'}</section><section class="page-break"><h1 class="section-title">영수증·증빙 부록</h1><div class="receipt-grid">${receipts||'<p>등록된 영수증이 없습니다.</p>'}</div></section></body></html>`;
}

function safeFileName(value) { return String(value || '모임').replace(/[\\/:*?"<>|]/g,'_').replace(/\s+/g,' ').trim(); }
function canvasRoundRect(ctx,x,y,w,h,r,fill,stroke='') {
  const radius=Math.min(r,w/2,h/2); ctx.beginPath(); ctx.roundRect(x,y,w,h,radius);
  if(fill){ctx.fillStyle=fill;ctx.fill()} if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=1;ctx.stroke()}
}
function canvasText(ctx,text,x,y,{font='32px "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',color='#172033',align='left',baseline='top'}={}) {
  ctx.font=font;ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline=baseline;ctx.fillText(String(text??''),x,y);
}
function wrapCanvasText(ctx,text,maxWidth,maxLines=99) {
  const chars=[...String(text??'')],lines=[];let line='';
  for(const ch of chars){const test=line+ch;if(ctx.measureText(test).width>maxWidth&&line){lines.push(line);line=ch;if(lines.length>=maxLines)break}else line=test}
  if(lines.length<maxLines&&line)lines.push(line);
  if(lines.length===maxLines&&chars.join('').length>lines.join('').length){let last=lines[lines.length-1];while(last&&ctx.measureText(`${last}…`).width>maxWidth)last=last.slice(0,-1);lines[lines.length-1]=`${last}…`}
  return lines;
}
function drawWrapped(ctx,text,x,y,maxWidth,lineHeight,opts={}) { const lines=wrapCanvasText(ctx,text,maxWidth,opts.maxLines||99);lines.forEach((line,i)=>canvasText(ctx,line,x,y+i*lineHeight,opts));return lines.length*lineHeight; }
async function canvasImageFromUrl(url) {
  if(!url)return null;return await new Promise(resolve=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>resolve(null);img.src=url});
}
function drawCoverImage(ctx,img,x,y,w,h) {
  if(!img)return;const scale=Math.max(w/img.naturalWidth,h/img.naturalHeight);const sw=w/scale,sh=h/scale,sx=(img.naturalWidth-sw)/2,sy=(img.naturalHeight-sh)/2;ctx.drawImage(img,sx,sy,sw,sh,x,y,w,h);
}
function drawKakaoMetric(ctx,x,y,w,label,value) { canvasRoundRect(ctx,x,y,w,132,18,'#f4f6fb','#e2e6ef');canvasText(ctx,label,x+22,y+20,{font:'500 23px "Malgun Gothic",sans-serif',color:'#697286'});canvasText(ctx,value,x+22,y+59,{font:'700 36px "Malgun Gothic",sans-serif'}); }
function drawKakaoSectionTitle(ctx,title,y) { canvasText(ctx,title,64,y,{font:'700 34px "Malgun Gothic",sans-serif'});ctx.fillStyle='#526df5';ctx.fillRect(64,y+49,952,4);return y+76; }
function drawKakaoTableHeader(ctx,cols,y,widths) { let x=64;ctx.fillStyle='#eef1f7';ctx.fillRect(64,y,952,54);cols.forEach((c,i)=>{canvasText(ctx,c,x+12,y+14,{font:'700 21px "Malgun Gothic",sans-serif',color:'#3c465a',align:i>=2?'right':'left'});x+=widths[i]});return y+54; }
function resultColor(row){return row.net>0?'#c04557':row.net<0?'#168163':'#596174'}
async function buildKakaoCanvas(includePhotos=false) {
  const e=currentEvent(),calc=calculateSettlement(e),recs=eventRecords(e?.id),lodgers=lodgerIdsForEvent(e);
  const categories=Object.entries(calc.categoryTotals);
  const recordList=includePhotos?recs.slice(0,24):[];
  const receiptIds=includePhotos?[...new Set(recs.flatMap(r=>r.receiptIds||[]))].slice(0,9):[];
  const photoCounts=recordList.map(r=>Math.min(MAX_RECORD_PHOTOS,(r.photoIds||[]).length));
  const photoGridHeight=count=>count?Math.ceil(count/2)*274+12:0;
  const headerH=390,metricH=176,categoryH=110+Math.max(1,categories.length)*58,settlementH=124+Math.max(1,calc.rows.length)*68;
  const recordsH=includePhotos?(110+recordList.reduce((s,r,i)=>s+210+photoGridHeight(photoCounts[i]),0)):0;
  const receiptRows=Math.ceil(receiptIds.length/3),receiptsH=includePhotos&&receiptRows?(120+receiptRows*330):0;
  const height=Math.min(30000,headerH+metricH+categoryH+settlementH+recordsH+receiptsH+300);
  const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=height;const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#ffffff';ctx.fillRect(0,0,1080,height);
  const coverId=recs.flatMap(r=>r.photoIds||[])[0];const cover=coverId?await canvasImageFromUrl(attachment(coverId)?.url):null;
  if(cover){drawCoverImage(ctx,cover,0,0,1080,330);ctx.fillStyle='rgba(20,28,48,.66)';ctx.fillRect(0,0,1080,330)}else{const g=ctx.createLinearGradient(0,0,1080,330);g.addColorStop(0,'#172033');g.addColorStop(1,'#526df5');ctx.fillStyle=g;ctx.fillRect(0,0,1080,330)}
  canvasText(ctx,'ROSA GATHER LEDGER',64,54,{font:'700 21px "Malgun Gothic",sans-serif',color:'#bfcaff'});
  drawWrapped(ctx,e?.title||'모임 결산 보고서',64,100,900,58,{font:'700 49px "Malgun Gothic",sans-serif',color:'#fff',maxLines:2});
  canvasText(ctx,`${dateText(e?.startDate)} ~ ${dateText(e?.endDate)}  ·  ${e?.location||''}`,64,252,{font:'500 24px "Malgun Gothic",sans-serif',color:'#edf0fa'});
  canvasText(ctx,includePhotos?'카카오톡용 전체 결산 보고서':'카카오톡용 결산 요약',64,350,{font:'700 25px "Malgun Gothic",sans-serif',color:'#526df5'});
  let y=414;const gap=14,mw=(952-gap*3)/4;
  drawKakaoMetric(ctx,64,y,mw,'전체 지출',money(calc.totalExpense));drawKakaoMetric(ctx,64+(mw+gap),y,mw,'참석자',`${e?.attendeeIds?.length||0}명`);drawKakaoMetric(ctx,64+2*(mw+gap),y,mw,'숙박자',`${lodgers.length}명`);drawKakaoMetric(ctx,64+3*(mw+gap),y,mw,'반기 납부회비',money(calc.eventFeePaid));y+=176;
  y=drawKakaoSectionTitle(ctx,'지출 분류별 요약',y);if(categories.length){categories.forEach(([key,value])=>{canvasText(ctx,`${CATEGORY[key]?.icon||'•'} ${CATEGORY[key]?.label||key}`,78,y+13,{font:'500 23px "Malgun Gothic",sans-serif'});canvasText(ctx,money(value),1002,y+13,{font:'700 23px "Malgun Gothic",sans-serif',align:'right'});ctx.fillStyle='#e8ebf1';ctx.fillRect(64,y+55,952,1);y+=58})}else{canvasText(ctx,'등록된 지출이 없습니다.',78,y+12,{font:'500 23px "Malgun Gothic",sans-serif',color:'#8b93a2'});y+=58}
  y+=18;y=drawKakaoSectionTitle(ctx,`개인별 정산 · 월회비 ${feePeriodLabel(e)} 반영`,y);const widths=[150,110,160,180,150,202];y=drawKakaoTableHeader(ctx,['회원','유형','이용액','납부회비','선결제','최종'],y,widths);
  calc.rows.forEach((r,idx)=>{if(idx%2===1){ctx.fillStyle='#fafbfc';ctx.fillRect(64,y,952,68)}let x=64;const vals=[r.name,r.type==='monthly'?'월회비':'모임별',money(r.used),r.type==='monthly'?money(r.feePaid):'-',money(r.advanced),settlementResultText(r)];vals.forEach((v,i)=>{canvasText(ctx,v,x+(i>=2?widths[i]-12:12),y+20,{font:`${i===5?'700':'500'} 21px "Malgun Gothic",sans-serif`,color:i===5?resultColor(r):'#263044',align:i>=2?'right':'left'});x+=widths[i]});ctx.fillStyle='#e8ebf1';ctx.fillRect(64,y+67,952,1);y+=68});
  if(!calc.rows.length){canvasText(ctx,'정산 대상이 없습니다.',78,y+20,{font:'500 23px "Malgun Gothic",sans-serif',color:'#8b93a2'});y+=68}
  canvasRoundRect(ctx,64,y+22,952,78,16,'#f2f5ff');canvasText(ctx,`계산 기준: 월회비 회원은 실제 이용액 - ${feePeriodLabel(e)} 납부회비 - 개인 선결제액`,86,y+43,{font:'500 22px "Malgun Gothic",sans-serif',color:'#455584'});canvasText(ctx,'결과가 음수이면 환급, 양수이면 추가 납부입니다.',86,y+72,{font:'700 22px "Malgun Gothic",sans-serif',color:'#35487c'});y+=128;
  if(includePhotos){
    y=drawKakaoSectionTitle(ctx,'장소별 이용 기록',y);
    for(const r of recordList){const cat=CATEGORY[r.category]||CATEGORY.other;canvasRoundRect(ctx,64,y,952,190,18,'#ffffff','#dde2ec');canvasText(ctx,`${cat.icon} ${cat.label}`,88,y+24,{font:'700 21px "Malgun Gothic",sans-serif',color:'#526df5'});drawWrapped(ctx,r.place||cat.label,88,y+62,650,38,{font:'700 31px "Malgun Gothic",sans-serif',maxLines:2});canvasText(ctx,money(r.amount),990,y+28,{font:'700 30px "Malgun Gothic",sans-serif',align:'right'});canvasText(ctx,`${dateTimeText(r.datetime)} · 이용 ${(r.participantIds||[]).length}명`,88,y+139,{font:'500 21px "Malgun Gothic",sans-serif',color:'#6d7688'});canvasText(ctx,member(r.payerId)?.name?`결제 ${member(r.payerId).name}`:'공동회비·지출 없음',990,y+139,{font:'500 21px "Malgun Gothic",sans-serif',color:'#6d7688',align:'right'});y+=210;
      const ids=(r.photoIds||[]).slice(0,MAX_RECORD_PHOTOS),imgs=[];for(const id of ids)imgs.push(await canvasImageFromUrl(attachment(id)?.url));const good=imgs.filter(Boolean);if(good.length){const single=good.length===1,iw=single?952:469,rows=Math.ceil(good.length/2);good.forEach((img,i)=>{const col=single?0:i%2,row=single?0:Math.floor(i/2),x=64+col*(iw+14),py=y+row*274;canvasRoundRect(ctx,x,py,iw,260,14,'#eef1f6');ctx.save();ctx.beginPath();ctx.roundRect(x,py,iw,260,14);ctx.clip();drawCoverImage(ctx,img,x,py,iw,260);ctx.restore()});y+=rows*274+12}
    }
    if(recordList.length<recs.length){canvasText(ctx,`이용 기록 ${recs.length-recordList.length}건은 PDF 보고서에서 확인하세요.`,64,y,{font:'500 21px "Malgun Gothic",sans-serif',color:'#6d7688'});y+=52}
    if(receiptIds.length){y=drawKakaoSectionTitle(ctx,'영수증·증빙 미리보기',y);for(let i=0;i<receiptIds.length;i++){const a=attachment(receiptIds[i]),col=i%3,row=Math.floor(i/3),x=64+col*322,ry=y+row*330;canvasRoundRect(ctx,x,ry,308,306,14,'#f7f8fb','#dde2ec');if(a?.contentType?.startsWith('image/')){const img=await canvasImageFromUrl(a.url);if(img){ctx.save();ctx.beginPath();ctx.roundRect(x+10,ry+10,288,250,10);ctx.clip();drawCoverImage(ctx,img,x+10,ry+10,288,250);ctx.restore()}}else{canvasText(ctx,'PDF 증빙',x+154,ry+112,{font:'700 26px "Malgun Gothic",sans-serif',color:'#596174',align:'center'});}drawWrapped(ctx,a?.originalName||'영수증',x+14,ry+268,280,23,{font:'500 17px "Malgun Gothic",sans-serif',color:'#697286',maxLines:1})}y+=receiptRows*330}
  }
  canvasText(ctx,`ROSA Gather Ledger · ${new Date().toLocaleDateString('ko-KR')}`,64,height-58,{font:'500 19px "Malgun Gothic",sans-serif',color:'#9299a8'});canvasText(ctx,'공식 보관용 PDF와 원본 영수증을 함께 보관하세요.',1016,height-58,{font:'500 19px "Malgun Gothic",sans-serif',color:'#9299a8',align:'right'});
  return canvas;
}
async function makeKakaoImageFile(includePhotos) {
  const canvas = await buildKakaoCanvas(includePhotos);
  const blob = await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PNG 변환에 실패했습니다.')),'image/png'));
  const suffix = includePhotos ? '카톡용_전체결산보고서' : '카톡용_결산요약';
  return new File([blob], `${safeFileName(currentEvent()?.title)}_${suffix}.png`, {type:'image/png'});
}

async function downloadKakaoImage(includePhotos,button) {
  const original=button?.textContent||'카톡용 이미지 저장';if(button){button.disabled=true;button.textContent='이미지 만드는 중...'}
  try{const file=await makeKakaoImageFile(includePhotos);downloadBlob(file,file.name);toast(`카카오톡용 PNG를 저장했습니다. (${(file.size/1024/1024).toFixed(1)}MB)`,'ok')}catch(err){toast(`이미지 생성 실패: ${err.message}`,'error')}finally{if(button){button.disabled=false;button.textContent=original}}
}

async function shareKakaoImage(includePhotos,button) {
  const original=button?.textContent||'카톡으로 공유';if(button){button.disabled=true;button.textContent='이미지 만드는 중...'}
  try{
    const file=await makeKakaoImageFile(includePhotos);
    if(navigator.canShare?.({files:[file]})){
      await navigator.share({title:currentEvent()?.title||'ROSA 모임정산',text:includePhotos?'사진이 포함된 전체 결산보고서입니다.':'개인별 정산이 포함된 결산 요약입니다.',files:[file]});
      toast('공유할 앱을 선택해 전송했습니다.','ok');
    }else{
      downloadBlob(file,file.name);toast('파일 직접 공유를 지원하지 않아 PNG로 저장했습니다.','warn');
    }
  }catch(err){if(err?.name!=='AbortError')toast(`이미지 공유 실패: ${err.message}`,'error')}finally{if(button){button.disabled=false;button.textContent=original}}
}

async function urlToDataUrl(url){const blob=await fetch(url).then(r=>r.blob());return await new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=rej;fr.readAsDataURL(blob)})}
async function openReport(download){const win=download?null:window.open('','_blank');if(win)win.document.write('<p style="font-family:sans-serif;padding:30px">보고서를 만드는 중입니다...</p>');try{const html=await buildReportHtml();if(download){const blob=new Blob([html],{type:'text/html;charset=utf-8'});downloadBlob(blob,`${currentEvent().title}_정산보고서.html`);toast('HTML 보고서를 저장했습니다.','ok')}else{win.document.open();win.document.write(html);win.document.close()}}catch(err){if(win)win.close();toast(`보고서 생성 실패: ${err.message}`,'error')}}
function downloadBlob(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},1000)}
function exportJson(){downloadBlob(new Blob([JSON.stringify(stateWithoutRuntimeUrls(state),null,2)],{type:'application/json'}),`ROSA_모임정산_${new Date().toISOString().slice(0,10)}.json`)}

async function importJsonFile(file){
  try{
    const parsed=JSON.parse(await file.text());
    if(parsed?.format==='ROSA_GATHER_TRANSFER_V1'){
      if(!confirm('현재 휴대폰의 장부와 사진을 가져온 전송 파일로 교체할까요?'))return;
      state=await importMobileTransferPackage(parsed);normalizeState();renderPage();toast('장부와 사진을 모두 가져왔습니다.','ok');return;
    }
    const candidate=parsed.state && parsed.members===undefined ? parsed.state : parsed;
    if(!candidate.members||!candidate.events)throw new Error('ROSA 모임정산 데이터가 아닙니다.');
    if(!confirm('현재 장부 데이터를 가져온 파일로 교체할까요? 기존 사진 저장소는 유지됩니다.'))return;
    state=candidate;normalizeState();await saveState();renderPage();toast('JSON 장부 데이터를 가져왔습니다.','ok');
  }catch(err){toast(`가져오기 실패: ${err.message}`,'error')}
}


async function updateStorageInfo() {
  const usageEl = $('#storageUsageBadge');
  const persistEl = $('#storagePersistBadge');
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (usageEl && estimate) {
      const usage = Number(estimate.usage || 0), quota = Number(estimate.quota || 0);
      const usageMb = usage / 1024 / 1024;
      const quotaGb = quota / 1024 / 1024 / 1024;
      usageEl.textContent = quota ? `${usageMb.toFixed(1)}MB / ${quotaGb.toFixed(1)}GB` : `${usageMb.toFixed(1)}MB`;
      usageEl.className = 'badge ok';
    }
    const persisted = await navigator.storage?.persisted?.();
    if (persistEl) {
      persistEl.textContent = persisted ? '보호됨' : '브라우저 정책 적용';
      persistEl.className = `badge ${persisted ? 'ok' : 'warn'}`;
    }
  } catch (_) {
    if (usageEl) usageEl.textContent = '확인 불가';
    if (persistEl) persistEl.textContent = '확인 불가';
  }
}

function updateOnlineBadge() {
  if (activeSaves) return;
  setSync(navigator.onLine ? '휴대폰에 자동 저장됨' : '오프라인 · 휴대폰에 저장됨', 'ok');
}

async function bootstrap(){
  try{
    serverInfo={app:'ROSA Gather Mobile',version:MOBILE_APP_VERSION,networkUrl:'휴대폰 단독 저장'};
    state=await api('/api/state');normalizeState();
    $$('.nav-item, .mobile-nav [data-page]').forEach(b=>b.addEventListener('click',()=>setPage(b.dataset.page)));
    $('#quickAddBtn').addEventListener('click',()=>openRecordModal());$('#mobileAddBtn').addEventListener('click',()=>openRecordModal());
    $('#eventSelector').addEventListener('change',e=>{state.currentEventId=e.target.value;queueSave();renderPage()});
    $('#jsonImportInput').addEventListener('change',e=>{if(e.target.files[0])importJsonFile(e.target.files[0]);e.target.value='' });
    const installTop=$('#installTopBtn');
    installTop?.addEventListener('click',installMobileApp);
    window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPromptEvent=e;if(installTop){installTop.hidden=false;installTop.textContent='앱 설치'}});
    window.addEventListener('appinstalled',()=>{installPromptEvent=null;if(installTop)installTop.hidden=true;toast('ROSA 모임정산 앱 설치가 완료되었습니다.','ok')});
    if(window.matchMedia('(display-mode: standalone)').matches && installTop)installTop.hidden=true;
    if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});
    if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{});
    window.addEventListener('online',updateOnlineBadge);window.addEventListener('offline',updateOnlineBadge);

    const params=new URLSearchParams(location.search);
    const requestedPage=params.get('page');
    if(requestedPage && PAGE_META[requestedPage])currentPage=requestedPage;
    renderPage();updateOnlineBadge();
    if(params.get('action')==='record')setTimeout(()=>openRecordModal(),120);
    if(params.size && history.replaceState)history.replaceState({},'',location.pathname);
  }catch(err){setSync('휴대폰 저장소 오류','warn');$('#content').innerHTML=`<div class="notice danger"><strong>휴대폰 저장소를 열지 못했습니다.</strong><br>${esc(err.message)}<br>Chrome 저장공간 권한과 시크릿 모드 여부를 확인해 주세요.</div>`}
}

document.addEventListener('DOMContentLoaded',bootstrap);