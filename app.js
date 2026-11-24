const RTC = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const MAX_FILE_BYTES = 25 * 1024 * 1024;
let mode = 'login';
let token = localStorage.getItem('rc_token') || '';
let me = null;
let ws = null;
let wsReconnectTimer = null;

// activeChat = { kind: 'dm' | 'group', id: string }
let activeChat = null;
let friends = [];
let incomingReqs = [];
let chatsMeta = [];
let groupsMeta = [];
let userProfiles = {};
let pendingCaller = null;
let groupModalMode = 'create';
let selectedGroupMembers = new Set();
const fileStore = new Map();

// Saved accounts for quick switching: [{ username, nickname, avatar_url, token }]
let savedAccounts = JSON.parse(localStorage.getItem('rc_saved_accounts') || '[]');
let accountsExpanded = false;

function persistSavedAccount(userObj, authToken) {
  if (!userObj || !userObj.username) return;
  const entry = {
    username: userObj.username,
    nickname: userObj.nickname || '',
    avatar_url: userObj.avatar_url || '',
    token: authToken || token || ''
  };
  savedAccounts = [entry, ...savedAccounts.filter((a) => a.username !== entry.username)].slice(0, 8);
  localStorage.setItem('rc_saved_accounts', JSON.stringify(savedAccounts));
}

function setPopoverFeedback(msg, isErr = false) {
  const el = document.getElementById('popFeedback');
  if (!el) return;
  el.style.color = isErr ? '#ff6961' : 'var(--green)';
  el.textContent = msg || '';
}

function syncProfilePopoverUi() {
  if (!me) return;
  document.getElementById('popNick').textContent = displayNameOf(me.username);
  document.getElementById('popLoginText').textContent = '@' + me.username;
  document.getElementById('popAv').innerHTML = renderAvatarHtml(me.username);
  const remBtn = document.getElementById('popRemoveAvBtn');
  if (remBtn) remBtn.classList.toggle('hidden', !me.avatar_url);

  const box = document.getElementById('popAccountsBox');
  const arrow = document.getElementById('popAccArrow');
  if (arrow) arrow.textContent = accountsExpanded ? '⌄' : '›';
  if (!box) return;
  if (!accountsExpanded) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  if (!savedAccounts.length) {
    box.innerHTML = '<div class="item-sub" style="padding:6px;">Других сохранённых аккаунтов пока нет</div>';
    return;
  }
  box.innerHTML = savedAccounts.map((acc) => {
    const isCurrent = acc.username === me.username;
    const label = acc.nickname || acc.username;
    const avInner = acc.avatar_url
      ? '<img src="' + esc(acc.avatar_url) + '" alt="' + esc(label) + '" />'
      : esc(label.slice(0, 2).toUpperCase());
    return (
      '<div class="pop-acc-item ' + (isCurrent ? 'current' : '') + '" data-switch-user="' + esc(acc.username) + '">' +
        '<div class="item-left">' +
          '<div class="avatar" style="width:28px;height:28px;font-size:11px;">' + avInner + '</div>' +
          '<div style="min-width:0">' +
            '<div class="item-name" style="font-size:12.5px;">' + esc(label) + '</div>' +
            '<div class="item-sub" style="font-size:10.5px;">@' + esc(acc.username) + '</div>' +
          '</div>' +
        '</div>' +
        '<span class="item-sub" style="font-size:11px;color:' + (isCurrent ? 'var(--green)' : 'var(--text)') + ';">' + (isCurrent ? 'Активен' : 'Войти') + '</span>' +
      '</div>'
    );
  }).join('');

  box.querySelectorAll('[data-switch-user]').forEach((row) => {
    const targetU = row.dataset.switchUser;
    if (targetU && targetU !== me.username) {
      row.addEventListener('click', () => switchToSavedAccount(targetU));
    }
  });
}

function toggleProfilePopover(ev) {
  if (ev) ev.stopPropagation();
  const pop = document.getElementById('profilePopover');
  if (!pop || !me) return;
  const willOpen = pop.classList.contains('hidden');
  closeVoiceContextMenu();
  accountsExpanded = false;
  setPopoverFeedback('');
  if (willOpen) {
    syncProfilePopoverUi();
    pop.classList.remove('hidden');
  } else {
    pop.classList.add('hidden');
  }
}

function closeProfilePopover() {
  const pop = document.getElementById('profilePopover');
  if (pop) pop.classList.add('hidden');
  accountsExpanded = false;
}

document.addEventListener('click', (e) => {
  const pop = document.getElementById('profilePopover');
  if (pop && !pop.classList.contains('hidden') && !pop.contains(e.target)) {
    closeProfilePopover();
  }
});

async function copyMyLogin() {
  if (!me || !me.username) return;
  const loginStr = me.username;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(loginStr);
    } else {
      const ta = document.createElement('textarea');
      ta.value = loginStr;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setPopoverFeedback('Логин «' + loginStr + '» скопирован ✓');
  } catch {
    setPopoverFeedback('Не удалось скопировать логин', true);
  }
}

async function persistAvatarChange(nextAvatarUrl, doneMsg) {
  if (!me || !token) return;
  const prevAvatar = me.avatar_url || '';
  me.avatar_url = nextAvatarUrl || '';
  refreshMeUi();
  syncProfilePopoverUi();
  renderLists();
  updateActiveHeaderTitle();
  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ nickname: me.nickname || '', avatar_url: me.avatar_url })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      me.avatar_url = prevAvatar;
      refreshMeUi();
      syncProfilePopoverUi();
      setPopoverFeedback(data.error || 'Ошибка обновления аватарки', true);
      return;
    }
    me = data.user || me;
    persistSavedAccount(me, token);
    refreshMeUi();
    syncProfilePopoverUi();
    renderLists();
    updateActiveHeaderTitle();
    setPopoverFeedback(doneMsg);
  } catch {
    setPopoverFeedback('Ошибка сети при сохранении аватарки', true);
  }
}

function onPopoverAvatarChange(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file || !me) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const maxDim = 200;
      let w = img.width, h = img.height;
      if (w > h && w > maxDim) { h = Math.round((h * maxDim) / w); w = maxDim; }
      else if (h >= w && h > maxDim) { w = Math.round((w * maxDim) / h); h = maxDim; }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      persistAvatarChange(dataUrl, 'Новая аватарка установлена ✓');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
  ev.target.value = '';
}

function removePopoverAvatar() {
  persistAvatarChange('', 'Аватарка удалена ✓');
}

function openProfileFromPopover() {
  closeProfilePopover();
  openSettings();
  switchSettingsTab('profile');
}

function toggleAccountSwitcher() {
  accountsExpanded = !accountsExpanded;
  syncProfilePopoverUi();
}

async function switchToSavedAccount(targetUsername) {
  const acc = savedAccounts.find((a) => a.username === targetUsername);
  if (!acc || !acc.token) {
    setPopoverFeedback('Для этого аккаунта нужен вход с паролем', true);
    logoutAndSwitchAccount(targetUsername);
    return;
  }
  closeProfilePopover();
  endCall(false, false);
  stopMicTest();
  toggleGifPicker(false);
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} ws = null; }
  token = acc.token;
  localStorage.setItem('rc_token', token);
  activeChat = null;
  await checkSession();
}

function logoutAndSwitchAccount(prefillUsername = '') {
  closeProfilePopover();
  logout();
  setMode('login');
  const uInp = document.getElementById('u');
  const pInp = document.getElementById('p');
  if (uInp) uInp.value = prefillUsername || '';
  if (pInp) pInp.value = '';
  if (uInp) uInp.focus();
}

// Mesh call state for 1-to-1 and group calls
let callContext = null;
let callInitiator = null;
let inCall = false;
let isRingingOutgoing = false;
let callConnectedAt = 0;
let callTimerInterval = null;
let ringTimer = null;
let ringAudioCtx = null;

const peerConnections = new Map();
const remoteAudios = new Map();
const remoteStreams = new Map();

let rawMicStream = null, micStream = null, camStream = null, scrStream = null;
let micAudioCtx = null, micGainNode = null, micAnalyser = null, speakRaf = null;
let micMuted = false, deafened = false, micMutedBeforeDeaf = false;
let localPreviewVisible = false;

let ctxTargetUser = null;
let peerVolumes = JSON.parse(localStorage.getItem('rc_peer_volumes') || '{}');
let peerMutedMap = JSON.parse(localStorage.getItem('rc_peer_muted') || '{}');
let blockedUsers = new Set(JSON.parse(localStorage.getItem('rc_blocked_users') || '[]'));

let selectedMicId = localStorage.getItem('rc_mic_id') || '';
let selectedSpkId = localStorage.getItem('rc_spk_id') || '';
let micGainPercent = Number(localStorage.getItem('rc_mic_gain') || 100);
let noiseSuppressionEnabled = localStorage.getItem('rc_ns') === 'true';

let testStream = null, testCtx = null, testRaf = null;
let mediaRecorder = null, voiceChunks = [], recInterval = null, recSeconds = 0;
let currentPlayingAudio = null, currentPlayingUi = null;

let uiZoom = Number(localStorage.getItem('rc_zoom') || 1);
let pttEnabled = localStorage.getItem('rc_ptt_enabled') === 'true';
let pttKey = localStorage.getItem('rc_ptt_key') || 'KeyV';
let clearCacheOnExit = localStorage.getItem('rc_clear_cache_exit') === 'true';
let gifDebounceTimer = null;

function ruPlural(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

function formatCallClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (hrs > 0) {
    return String(hrs).padStart(2, '0') + ':' + String(mins).padStart(2, '0') + ':' + String(rem).padStart(2, '0');
  }
  return String(mins).padStart(2, '0') + ':' + String(rem).padStart(2, '0');
}

function formatDurationWords(sec) {
  const s = Math.max(0, Math.floor(sec));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const parts = [];
  if (hrs > 0) parts.push(hrs + ' ' + ruPlural(hrs, 'час', 'часа', 'часов'));
  if (mins > 0) parts.push(mins + ' ' + ruPlural(mins, 'минута', 'минуты', 'минут'));
  if (!parts.length) parts.push(Math.max(1, rem) + ' ' + ruPlural(Math.max(1, rem), 'секунда', 'секунды', 'секунд'));
  return parts.join(' ');
}

function formatCallDateTime(isoOrDate) {
  const d = isoOrDate ? new Date(isoOrDate) : new Date();
  if (isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return dd + '.' + mm + '.' + yyyy + ' ' + hh + ':' + min;
}

function startCallTimer() {
  stopCallTimer();
  callConnectedAt = Date.now();
  const el = document.getElementById('callTimer');
  if (el) {
    el.textContent = '00:00';
    el.classList.remove('hidden');
  }
  callTimerInterval = setInterval(() => {
    if (!callConnectedAt) return;
    const elapsedSec = Math.floor((Date.now() - callConnectedAt) / 1000);
    if (el) el.textContent = formatCallClock(elapsedSec);
  }, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  const el = document.getElementById('callTimer');
  if (el) {
    el.classList.add('hidden');
    el.textContent = '00:00';
  }
}

function parseCallLogMessage(text) {
  const raw = String(text || '');
  if (!raw.startsWith('__CALL__:')) return null;
  try {
    return JSON.parse(raw.slice('__CALL__:'.length));
  } catch {
    return null;
  }
}

function emitCallLog(ctx, initiatorUsername, durationSec, completed) {
  if (!me || !ctx) return;
  const payload = {
    initiator: initiatorUsername || me.username,
    durationSec: completed ? Math.max(1, Math.floor(durationSec || 0)) : 0,
    completed: !!completed,
    at: new Date().toISOString()
  };
  const encoded = '__CALL__:' + JSON.stringify(payload);

  if (ctx.kind === 'group') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'group-dm', groupId: ctx.id, text: encoded }));
    }
    if (activeChat && activeChat.kind === 'group' && activeChat.id === ctx.id) {
      appendMsg({
        id: 'call_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        sender: me.username,
        groupId: ctx.id,
        text: encoded,
        created_at: payload.at
      });
    }
  } else {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'dm', to: ctx.id, text: encoded }));
    }
    if (activeChat && activeChat.kind === 'dm' && activeChat.id === ctx.id) {
      appendMsg({
        id: 'call_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        sender: me.username,
        recipient: ctx.id,
        text: encoded,
        created_at: payload.at
      });
    }
  }
}

function normalizeGroupItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || raw.groupId || raw._id || '').trim();
  if (!id) return null;
  const rawMembers = Array.isArray(raw.members)
    ? raw.members
    : (Array.isArray(raw.participants) ? raw.participants : []);
  const membersSet = new Set(
    rawMembers
      .map((m) => (typeof m === 'string' ? m : (m && (m.username || m.user))))
      .filter(Boolean)
  );
  if (me && me.username) membersSet.add(me.username);
  return {
    id,
    title: String(raw.title || raw.name || '').trim(),
    members: [...membersSet],
    lastMessage: raw.lastMessage || raw.last_message || '',
    profiles: raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : {}
  };
}

function saveCachedGroups() {
  if (!me || !me.username) return;
  try {
    localStorage.setItem('rc_groups_' + me.username, JSON.stringify(groupsMeta));
  } catch {}
}

function loadCachedGroups() {
  if (!me || !me.username) return [];
  try {
    const raw = JSON.parse(localStorage.getItem('rc_groups_' + me.username) || '[]');
    return Array.isArray(raw) ? raw.map(normalizeGroupItem).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function upsertGroup(rawGroup) {
  const norm = normalizeGroupItem(rawGroup);
  if (!norm) return null;
  const idx = groupsMeta.findIndex((g) => g.id === norm.id);
  if (idx >= 0) {
    groupsMeta[idx] = {
      ...groupsMeta[idx],
      ...norm,
      members: norm.members.length ? norm.members : groupsMeta[idx].members,
      lastMessage: norm.lastMessage || groupsMeta[idx].lastMessage || ''
    };
  } else {
    groupsMeta.unshift(norm);
  }
  saveCachedGroups();
  return getGroupById(norm.id);
}

function getGroupById(groupId) {
  return groupsMeta.find((g) => g.id === groupId) || null;
}

function getGroupTitle(group) {
  if (!group) return 'Группа';
  if (group.title && group.title.trim()) return group.title.trim();
  const others = (group.members || []).filter((u) => !me || u !== me.username);
  const names = (others.length ? others : (group.members || [])).map(displayNameOf);
  return names.join(', ') || 'Групповой чат';
}

function getGroupInitials(group) {
  const title = getGroupTitle(group);
  const words = title.split(/[\s,]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return title.slice(0, 2).toUpperCase() || 'ГР';
}

function updateGroupPickedCounter() {
  const el = document.getElementById('groupPickedCount');
  if (el) el.textContent = String(selectedGroupMembers.size);
}

function openGroupModal(nextMode) {
  groupModalMode = nextMode || 'create';
  selectedGroupMembers = new Set();
  updateGroupPickedCounter();

  const titleField = document.getElementById('groupTitleField');
  const titleInp = document.getElementById('groupTitleInput');
  const heading = document.getElementById('groupModalTitle');
  const submitBtn = document.getElementById('groupModalSubmitBtn');
  const errEl = document.getElementById('groupModalErr');
  errEl.textContent = '';

  const currentGroup = (activeChat && activeChat.kind === 'group') ? getGroupById(activeChat.id) : null;
  const existingSet = new Set((currentGroup && currentGroup.members) || []);

  if (groupModalMode === 'invite' && currentGroup) {
    heading.textContent = 'Пригласить в «' + getGroupTitle(currentGroup) + '»';
    titleField.classList.add('hidden');
    submitBtn.textContent = 'Добавить в группу';
  } else {
    groupModalMode = 'create';
    heading.textContent = 'Создать групповой чат';
    titleField.classList.remove('hidden');
    titleInp.value = '';
    submitBtn.textContent = 'Создать';
  }

  const allKnownFriends = getAllKnownFriends();
  const candidates = allKnownFriends.filter((f) => !(groupModalMode === 'invite' && existingSet.has(f.username)));
  const picker = document.getElementById('groupFriendsPicker');

  if (!candidates.length) {
    picker.innerHTML = '<div class="item-sub">Нет доступных друзей для добавления. Сначала добавь друзей во вкладке «Друзья».</div>';
  } else {
    picker.innerHTML = candidates.map((f) => (
      '<div class="member-pick-row" data-pick-user="' + esc(f.username) + '">' +
        '<div class="item-left">' +
          '<div class="avatar">' + renderAvatarHtml(f.username) + '</div>' +
          '<div>' +
            '<div class="item-name">' + esc(displayNameOf(f.username)) + '</div>' +
            '<div class="item-sub">@' + esc(f.username) + '</div>' +
          '</div>' +
        '</div>' +
        '<span class="member-pick-pill">+</span>' +
      '</div>'
    )).join('');

    picker.querySelectorAll('[data-pick-user]').forEach((row) => {
      const uName = row.dataset.pickUser;
      const pill = row.querySelector('.member-pick-pill');
      row.addEventListener('click', () => {
        if (selectedGroupMembers.has(uName)) {
          selectedGroupMembers.delete(uName);
          row.classList.remove('selected');
          if (pill) pill.textContent = '+';
        } else {
          selectedGroupMembers.add(uName);
          row.classList.add('selected');
          if (pill) pill.textContent = 'Добавлен';
        }
        updateGroupPickedCounter();
      });
    });
  }

  document.getElementById('groupModal').classList.remove('hidden');
}

function closeGroupModal() {
  document.getElementById('groupModal').classList.add('hidden');
}

async function submitGroupModal() {
  const errEl = document.getElementById('groupModalErr');
  const chosen = [...selectedGroupMembers];
  if (!chosen.length) {
    errEl.textContent = 'Нажми хотя бы на одного друга, чтобы добавить его';
    return;
  }

  if (groupModalMode === 'invite' && activeChat && activeChat.kind === 'group') {
    try {
      const res = await fetch('/api/groups/' + encodeURIComponent(activeChat.id) + '/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ members: chosen })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        errEl.textContent = data.error || 'Не удалось добавить участников';
        return;
      }
      const grpData = data.group || data;
      if (grpData && (grpData.id || grpData.groupId || grpData._id)) {
        upsertGroup({ ...grpData, id: grpData.id || grpData.groupId || grpData._id || activeChat.id });
      } else {
        const cur = getGroupById(activeChat.id);
        if (cur) upsertGroup({ ...cur, members: [...new Set([...cur.members, ...chosen])] });
      }
      closeGroupModal();
      switchTab('chats');
      renderLists();
      updateActiveHeaderTitle();
      await refreshSocial();
      openGroupChat(activeChat.id);
    } catch {
      errEl.textContent = 'Ошибка сети';
    }
    return;
  }

  const title = document.getElementById('groupTitleInput').value.trim();
  try {
    const res = await fetch('/api/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ title, members: chosen })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errEl.textContent = data.error || 'Не удалось создать группу';
      return;
    }
    const rawGrp = data.group || (data.id ? data : null);
    const createdId = (rawGrp && (rawGrp.id || rawGrp.groupId || rawGrp._id)) || ('grp_' + Date.now());
    const createdGroup = upsertGroup({
      ...(rawGrp || {}),
      id: createdId,
      title: (rawGrp && rawGrp.title) || title,
      members: (rawGrp && Array.isArray(rawGrp.members) && rawGrp.members.length)
        ? rawGrp.members
        : [me && me.username, ...chosen].filter(Boolean)
    });

    closeGroupModal();
    switchTab('chats');
    renderLists();
    await refreshSocial();
    if (createdGroup && createdGroup.id) {
      openGroupChat(createdGroup.id);
    }
  } catch {
    errEl.textContent = 'Ошибка сети';
  }
}

function getPeerVolume(username) {
  if (!username) return 100;
  const v = Number(peerVolumes[username]);
  return Number.isFinite(v) ? Math.max(0, Math.min(200, v)) : 100;
}

function isPeerMuted(username) {
  return !!(username && peerMutedMap[username]);
}

function isUserBlocked(username) {
  return !!(username && blockedUsers.has(username));
}

function applyRemotePeerAudioSettings(username) {
  if (!username) return;
  const muted = isPeerMuted(username) || isUserBlocked(username) || deafened;
  const volPct = muted ? 0 : getPeerVolume(username);
  const clampedVol = Math.min(1, volPct / 100);

  const aud = remoteAudios.get(username);
  if (aud) {
    aud.muted = muted;
    aud.volume = clampedVol;
  }
  const rv = document.getElementById('remoteVideo_' + username);
  if (rv) {
    rv.muted = muted;
    rv.volume = clampedVol;
  }
}

function openVoiceContextMenu(ev, username) {
  ev.preventDefault();
  ev.stopPropagation();
  closeProfilePopover();
  const target = username || (activeChat && activeChat.kind === 'dm' ? activeChat.id : null);
  if (!target || (me && target === me.username)) return;
  ctxTargetUser = target;

  const menu = document.getElementById('voiceContextMenu');
  const vol = getPeerVolume(target);
  const muted = isPeerMuted(target);
  const blocked = isUserBlocked(target);

  document.getElementById('ctxTargetLabel').textContent = displayNameOf(target);
  document.getElementById('ctxVolPercent').textContent = vol + '%';
  document.getElementById('ctxVolSlider').value = String(vol);
  document.getElementById('ctxMuteBtn').classList.toggle('active', muted);
  document.getElementById('ctxMuteState').textContent = muted ? '✓' : '';
  document.getElementById('ctxBlockBtn').classList.toggle('active', blocked);
  document.getElementById('ctxBlockState').textContent = blocked ? '✓' : '';

  menu.classList.remove('hidden');
  const pad = 10;
  const mw = menu.offsetWidth || 245;
  const mh = menu.offsetHeight || 190;
  const x = Math.max(pad, Math.min(window.innerWidth - mw - pad, ev.clientX));
  const y = Math.max(pad, Math.min(window.innerHeight - mh - pad, ev.clientY));
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function closeVoiceContextMenu() {
  const menu = document.getElementById('voiceContextMenu');
  if (menu) menu.classList.add('hidden');
  ctxTargetUser = null;
}

function onCtxVolumeChange(val) {
  if (!ctxTargetUser) return;
  const v = Math.max(0, Math.min(200, Number(val) || 0));
  peerVolumes[ctxTargetUser] = v;
  localStorage.setItem('rc_peer_volumes', JSON.stringify(peerVolumes));
  document.getElementById('ctxVolPercent').textContent = v + '%';
  if (v > 0 && isPeerMuted(ctxTargetUser)) {
    peerMutedMap[ctxTargetUser] = false;
    localStorage.setItem('rc_peer_muted', JSON.stringify(peerMutedMap));
    document.getElementById('ctxMuteBtn').classList.remove('active');
    document.getElementById('ctxMuteState').textContent = '';
  }
  applyRemotePeerAudioSettings(ctxTargetUser);
}

function toggleCtxMuteUser() {
  if (!ctxTargetUser) return;
  const next = !isPeerMuted(ctxTargetUser);
  peerMutedMap[ctxTargetUser] = next;
  localStorage.setItem('rc_peer_muted', JSON.stringify(peerMutedMap));
  document.getElementById('ctxMuteBtn').classList.toggle('active', next);
  document.getElementById('ctxMuteState').textContent = next ? '✓' : '';
  applyRemotePeerAudioSettings(ctxTargetUser);
}

function toggleCtxBlockUser() {
  if (!ctxTargetUser) return;
  const target = ctxTargetUser;
  if (blockedUsers.has(target)) {
    blockedUsers.delete(target);
  } else {
    blockedUsers.add(target);
    cleanupPeerConnection(target);
  }
  localStorage.setItem('rc_blocked_users', JSON.stringify([...blockedUsers]));
  const blocked = isUserBlocked(target);
  document.getElementById('ctxBlockBtn').classList.toggle('active', blocked);
  document.getElementById('ctxBlockState').textContent = blocked ? '✓' : '';
  applyRemotePeerAudioSettings(target);
  renderLists();
  if (activeChat && activeChat.kind === 'dm' && activeChat.id === target) {
    openChat(target);
  }
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('voiceContextMenu');
  if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target)) {
    closeVoiceContextMenu();
  }
});

let sfxCtx = null;
function getSfxCtx() {
  if (deafened) return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!sfxCtx || sfxCtx.state === 'closed') {
    try { sfxCtx = new Ctx(); } catch { return null; }
  }
  if (sfxCtx.state === 'suspended') {
    sfxCtx.resume().catch(() => {});
  }
  return sfxCtx;
}

function closeSfxCtx() {
  if (sfxCtx) {
    try { sfxCtx.close(); } catch {}
    sfxCtx = null;
  }
}

function playTone(freq, startOffset, duration, type = 'sine', volume = 0.09, endFreq = null) {
  if (deafened) return;
  const ctx = getSfxCtx();
  if (!ctx) return;
  const run = () => {
    try {
      const now = ctx.currentTime + startOffset;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, now + duration);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(volume, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    } catch {}
  };
  if (ctx.state === 'suspended') {
    ctx.resume().then(run).catch(() => {});
  } else {
    run();
  }
}

function playDiscordSfx(name) {
  if (deafened && name !== 'undeaf') return;
  if (name === 'join') {
    playTone(587.33, 0, 0.065, 'triangle', 0.11);
    playTone(880, 0.06, 0.11, 'triangle', 0.11);
  } else if (name === 'leave') {
    playTone(880, 0, 0.065, 'triangle', 0.10);
    playTone(440, 0.06, 0.12, 'triangle', 0.10);
  } else if (name === 'mute') {
    playTone(420, 0, 0.055, 'sine', 0.10, 220);
  } else if (name === 'unmute') {
    playTone(260, 0, 0.055, 'sine', 0.10, 520);
  } else if (name === 'deaf') {
    playTone(392, 0, 0.055, 'sine', 0.10, 210);
    playTone(261.63, 0.055, 0.075, 'sine', 0.10, 146.83);
  } else if (name === 'undeaf') {
    const prevDeaf = deafened;
    deafened = false;
    playTone(261.63, 0, 0.055, 'sine', 0.10, 392);
    playTone(392, 0.055, 0.075, 'sine', 0.10, 587.33);
    deafened = prevDeaf;
  } else if (name === 'message') {
    playTone(659.25, 0, 0.06, 'sine', 0.085);
    playTone(987.77, 0.055, 0.085, 'sine', 0.08);
  } else if (name === 'incoming') {
    playTone(783.99, 0, 0.085, 'triangle', 0.09);
    playTone(1046.5, 0.09, 0.12, 'triangle', 0.09);
  }
}

function setPanelOpacity(transparencyPct) {
  const tr = Math.max(0, Math.min(75, Number(transparencyPct) || 0));
  const alpha = ((100 - tr) / 100).toFixed(2);
  document.documentElement.style.setProperty('--panel-alpha', alpha);
  localStorage.setItem('rc_panel_transparency', String(tr));
  const lbl = document.getElementById('panelOpacityVal');
  const sl = document.getElementById('panelOpacitySlider');
  if (lbl) lbl.textContent = tr + '%';
  if (sl && Number(sl.value) !== tr) sl.value = String(tr);
}

function setUiZoom(val) {
  const clamped = Math.max(0.8, Math.min(1.3, Number(val) || 1));
  uiZoom = Math.round(clamped * 20) / 20;
  document.documentElement.style.setProperty('--ui-zoom', String(uiZoom));
  localStorage.setItem('rc_zoom', String(uiZoom));
  const lbl = document.getElementById('zoomVal');
  const sl = document.getElementById('zoomSlider');
  if (lbl) lbl.textContent = Math.round(uiZoom * 100) + '%';
  if (sl && Number(sl.value) !== Math.round(uiZoom * 100)) sl.value = String(Math.round(uiZoom * 100));
}

function setMinimalMode(enabled) {
  const on = !!enabled;
  document.body.classList.toggle('minimal-mode', on);
  localStorage.setItem('rc_minimal_mode', on ? '1' : '0');
  const cb = document.getElementById('minimalModeToggle');
  if (cb) cb.checked = on;
  syncThemeEffect();
}

function setClearCacheOnExit(enabled) {
  clearCacheOnExit = !!enabled;
  localStorage.setItem('rc_clear_cache_exit', clearCacheOnExit ? '1' : '0');
  const cb = document.getElementById('clearCacheOnExitToggle');
  if (cb) cb.checked = clearCacheOnExit;
}

function clearLocalCacheNow() {
  const keepToken = localStorage.getItem('rc_token') || '';
  const keepAccounts = localStorage.getItem('rc_saved_accounts') || '';
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k !== 'rc_token' && k !== 'rc_saved_accounts') keysToRemove.push(k);
  }
  keysToRemove.forEach((k) => localStorage.removeItem(k));
  if (keepToken) localStorage.setItem('rc_token', keepToken);
  if (keepAccounts) localStorage.setItem('rc_saved_accounts', keepAccounts);
  recentStickers = ['🔥', '😂', '😎', '🐸', '💀', '🎉'];
  renderRecentStickers();
  const inp = document.getElementById('msgInput');
  if (inp) inp.value = '';
  const st = document.getElementById('cacheClearStatus');
  if (st) {
    st.style.color = '#30d158';
    st.textContent = 'Локальный кэш очищен';
  }
}

function cleanupAllBackgroundLoops() {
  stopBgLoop();
  stopCallTimer();
  stopIncomingRing();
  stopRingTone();
  stopMicTest();
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (speakRaf) { cancelAnimationFrame(speakRaf); speakRaf = null; }
  if (recInterval) { clearInterval(recInterval); recInterval = null; }
  closeSfxCtx();
}

window.addEventListener('beforeunload', () => {
  if (clearCacheOnExit) clearLocalCacheNow();
  cleanupAllBackgroundLoops();
});

function setPttEnabled(enabled) {
  pttEnabled = !!enabled;
  localStorage.setItem('rc_ptt_enabled', pttEnabled ? '1' : '0');
  const cb = document.getElementById('pttEnabledToggle');
  if (cb) cb.checked = pttEnabled;
  if (inCall && pttEnabled) {
    micMuted = true;
    applyMicMuteState();
    updateCallButtons();
  }
}

function setPttKey(code) {
  pttKey = code || 'KeyV';
  localStorage.setItem('rc_ptt_key', pttKey);
  const sel = document.getElementById('pttKeySelect');
  if (sel && sel.value !== pttKey) sel.value = pttKey;
}

window.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
  const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select';

  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); setUiZoom(uiZoom + 0.05); return; }
    if (e.key === '-') { e.preventDefault(); setUiZoom(uiZoom - 0.05); return; }
    if (e.key === '0') { e.preventDefault(); setUiZoom(1); return; }
  }

  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.code === 'KeyM' && inCall) { e.preventDefault(); toggleMic(); return; }
    if (e.code === 'KeyD' && inCall) { e.preventDefault(); toggleDeaf(); return; }
    if (e.code === 'KeyH' && inCall) { e.preventDefault(); endCall(); return; }
  }

  if (!isTyping && inCall && pttEnabled && e.code === pttKey && !e.repeat) {
    micMuted = false;
    if (deafened) {
      deafened = false;
      peerConnections.forEach((_, u) => applyRemotePeerAudioSettings(u));
    }
    applyMicMuteState();
    updateCallButtons();
  }
});

window.addEventListener('keyup', (e) => {
  if (inCall && pttEnabled && e.code === pttKey) {
    micMuted = true;
    applyMicMuteState();
    updateCallButtons();
  }
});

// Lightweight background effect loop (runs ONLY when an effect is active and page is visible)
let bgEffect = 'none';
let bgParticles = [];
let bgRaf = null;

function stopBgLoop() {
  if (bgRaf) {
    cancelAnimationFrame(bgRaf);
    bgRaf = null;
  }
  const canvas = document.getElementById('bgCanvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function spawnParticle(canvas, effect, randomY = true) {
  const w = canvas.width || window.innerWidth;
  const h = canvas.height || window.innerHeight;
  if (effect === 'sakura') {
    return {
      x: Math.random() * w, y: randomY ? Math.random() * h : -14,
      w: 7 + Math.random() * 5, h: 4.5 + Math.random() * 3.5,
      vy: 0.7 + Math.random() * 0.9, vx: -0.55 - Math.random() * 0.7,
      rot: Math.random() * Math.PI * 2, vrot: (Math.random() - 0.5) * 0.045,
      phase: Math.random() * Math.PI * 2, a: 0.62 + Math.random() * 0.34
    };
  }
  if (effect === 'rain') {
    return {
      x: Math.random() * w, y: randomY ? Math.random() * h : -28,
      len: 14 + Math.random() * 14, vy: 7 + Math.random() * 5,
      vx: -1.1 - Math.random() * 0.8, a: 0.38 + Math.random() * 0.42
    };
  }
  if (effect === 'embers') {
    return {
      x: Math.random() * w, y: randomY ? Math.random() * h : h + 10,
      r: 2 + Math.random() * 2.5, vy: -(0.6 + Math.random() * 1.15),
      vx: (Math.random() - 0.5) * 0.65, phase: Math.random() * Math.PI * 2,
      a: 0.55 + Math.random() * 0.4
    };
  }
  return null;
}

function rebuildBgParticles() {
  const canvas = document.getElementById('bgCanvas');
  if (!canvas) return;
  bgParticles = [];
  if (bgEffect === 'none' || document.hidden) {
    stopBgLoop();
    return;
  }
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const count = bgEffect === 'rain' ? 20 : 14;
  for (let i = 0; i < count; i++) {
    const p = spawnParticle(canvas, bgEffect, true);
    if (p) bgParticles.push(p);
  }
  if (!bgRaf) {
    bgRaf = requestAnimationFrame(renderBgLoop);
  }
}

function renderBgLoop() {
  bgRaf = null;
  if (bgEffect === 'none' || document.hidden) return;
  const canvas = document.getElementById('bgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const w = canvas.width;
  const h = canvas.height;
  const accentRgb = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '10, 132, 255';
  for (let i = 0; i < bgParticles.length; i++) {
    const p = bgParticles[i];
    if (bgEffect === 'sakura') {
      p.phase += 0.025; p.rot += p.vrot;
      p.x += p.vx + Math.sin(p.phase) * 0.5; p.y += p.vy;
      if (p.y > h + 16 || p.x < -20 || p.x > w + 20) { bgParticles[i] = spawnParticle(canvas, 'sakura', false); continue; }
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.fillStyle = 'rgba(255, 168, 198, ' + p.a + ')';
      ctx.beginPath(); ctx.ellipse(0, 0, p.w, p.h, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    } else if (bgEffect === 'rain') {
      p.x += p.vx; p.y += p.vy;
      if (p.y > h + 30 || p.x < -30 || p.x > w + 30) { bgParticles[i] = spawnParticle(canvas, 'rain', false); continue; }
      ctx.strokeStyle = 'rgba(' + accentRgb + ', ' + p.a + ')'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.vx * 2.2, p.y + p.len); ctx.stroke();
    } else if (bgEffect === 'embers') {
      p.phase += 0.03; p.x += p.vx + Math.cos(p.phase) * 0.35; p.y += p.vy;
      if (p.y < -14 || p.x < -15 || p.x > w + 15) { bgParticles[i] = spawnParticle(canvas, 'embers', false); continue; }
      ctx.fillStyle = 'rgba(' + accentRgb + ', ' + p.a + ')';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
  }
  bgRaf = requestAnimationFrame(renderBgLoop);
}

window.addEventListener('resize', () => {
  if (bgEffect === 'none' || document.hidden) return;
  const canvas = document.getElementById('bgCanvas');
  if (!canvas) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
});

function setBgEffect(val) {
  bgEffect = val || 'none';
  rebuildBgParticles();
}

let recentStickers = JSON.parse(localStorage.getItem('rc_recent_stickers') || '["🔥","😂","😎","🐸","💀","🎉"]');
function saveRecentSticker(st) {
  const clean = String(st || '').trim();
  if (!clean) return;
  recentStickers = [clean, ...recentStickers.filter((x) => x !== clean)].slice(0, 8);
  localStorage.setItem('rc_recent_stickers', JSON.stringify(recentStickers));
  renderRecentStickers();
}
function renderRecentStickers() {
  const box = document.getElementById('recentStickersBox');
  if (!box) return;
  box.innerHTML = recentStickers.map((s) => '<button type="button" class="emoji-btn" data-sticker="' + esc(String(s)) + '">' + esc(String(s)) + '</button>').join('');
  box.querySelectorAll('.emoji-btn').forEach((btn) => {
    btn.addEventListener('click', () => insertSticker(btn.dataset.sticker || ''));
  });
}
function insertSticker(st) {
  const inp = document.getElementById('msgInput');
  if (!inp) return;
  inp.value = inp.value ? (inp.value + ' ' + st) : st;
  saveRecentSticker(st);
  onMsgInput();
  inp.focus();
}

const STICKER_REGEX = new RegExp(
  '(?:[\\u2600-\\u27BF\\u{1F300}-\\u{1FAFF}])(?:\\uFE0F|\\u200D[\\u2600-\\u27BF\\u{1F300}-\\u{1FAFF}])*',
  'gu'
);
function extractEmojis(str) {
  try { return String(str).match(STICKER_REGEX) || []; } catch { return []; }
}
function isSingleStickerMessage(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.startsWith('__VOICE__:') || trimmed.startsWith('__FILE__:') || trimmed.startsWith('__CALL__:')) return false;
  const emojis = extractEmojis(trimmed);
  return emojis.length === 1 && trimmed === emojis[0];
}

const THEMES = {
  discord: {
    bg: '#1e1f22', panelRgb: '49, 51, 56', accent: '#5865f2',
    glow2: 'rgba(88, 101, 242, 0.08)', wallpaper: 'none',
    overlay: 'rgba(30, 31, 34, 0.25)', effect: 'none'
  },
  emerald: {
    bg: '#050d09', panelRgb: '14, 30, 22', accent: '#30d158',
    glow2: 'rgba(16, 185, 129, 0.22)', wallpaper: "url('/backgrounds/green.jpg')",
    overlay: 'rgba(5, 13, 9, 0.52)', effect: 'rain'
  },
  violet: {
    bg: '#090710', panelRgb: '24, 18, 38', accent: '#bf5af2',
    glow2: 'rgba(255, 168, 198, 0.24)', wallpaper: "url('/backgrounds/purple.jpg')",
    overlay: 'rgba(9, 7, 16, 0.52)', effect: 'sakura'
  },
  dark: {
    bg: '#07090f', panelRgb: '18, 22, 33', accent: '#0a84ff',
    glow2: 'rgba(10, 132, 255, 0.22)', wallpaper: "url('/backgrounds/blue.jpg')",
    overlay: 'rgba(7, 9, 15, 0.52)', effect: 'none'
  },
  crimson: {
    bg: '#0f0608', panelRgb: '34, 15, 20', accent: '#ff453a',
    glow2: 'rgba(255, 69, 58, 0.24)', wallpaper: "url('/backgrounds/orange.jpg')",
    overlay: 'rgba(15, 6, 8, 0.55)', effect: 'embers'
  }
};

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
  return ((num >> 16) & 255) + ', ' + ((num >> 8) & 255) + ', ' + (num & 255);
}

let activeThemeName = 'dark';
function syncThemeEffect() {
  const t = THEMES[activeThemeName] || THEMES.dark;
  const isMinimal = document.body.classList.contains('minimal-mode');
  setBgEffect(isMinimal ? 'none' : (t.effect || 'none'));
}

function applyTheme(name) {
  const valid = THEMES[name] ? name : 'dark';
  activeThemeName = valid;
  const t = THEMES[valid];
  document.documentElement.style.setProperty('--bg', t.bg);
  document.documentElement.style.setProperty('--theme-wallpaper', t.wallpaper || 'none');
  document.documentElement.style.setProperty('--theme-overlay', t.overlay || 'rgba(7, 9, 15, 0.52)');
  document.documentElement.style.setProperty('--panel-rgb', t.panelRgb);
  document.documentElement.style.setProperty('--accent', t.accent);
  document.documentElement.style.setProperty('--accent-rgb', hexToRgb(t.accent));
  document.documentElement.style.setProperty('--glow-2', t.glow2);
  localStorage.setItem('rc_theme', valid);
  document.querySelectorAll('.theme-swatch').forEach((el) => {
    el.classList.toggle('active', el.dataset.theme === valid);
  });
  syncThemeEffect();
}

function setSidebarWidth(px) {
  const val = Math.max(210, Math.min(440, Number(px) || 295));
  document.documentElement.style.setProperty('--sidebar-w', val + 'px');
  localStorage.setItem('rc_sidebar_w', String(val));
}

(function initSavedAppearance() {
  document.documentElement.style.setProperty('--avatar-radius', '50%');
  const savedMinimal = localStorage.getItem('rc_minimal_mode');
  setMinimalMode(savedMinimal === null ? true : savedMinimal === '1');
  applyTheme(localStorage.getItem('rc_theme') || 'dark');
  const savedTr = localStorage.getItem('rc_panel_transparency');
  setPanelOpacity(savedTr !== null ? Number(savedTr) : 8);
  const savedW = localStorage.getItem('rc_sidebar_w');
  if (savedW) setSidebarWidth(savedW);
  setClearCacheOnExit(localStorage.getItem('rc_clear_cache_exit') === '1');
  setPttEnabled(localStorage.getItem('rc_ptt_enabled') === 'true');
  setPttKey(localStorage.getItem('rc_ptt_key') || 'KeyV');
  setUiZoom(localStorage.getItem('rc_zoom') || 1);
  renderRecentStickers();
})();

(function initSplitterDrag() {
  const resizer = document.getElementById('colResizer');
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault(); dragging = true; resizer.classList.add('dragging'); document.body.style.cursor = 'col-resize';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    setSidebarWidth((e.clientX / uiZoom) - 10);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; resizer.classList.remove('dragging'); document.body.style.cursor = '';
  });
})();

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function isSafeHttpUrl(raw) {
  try {
    const parsed = new URL(String(raw || ''));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch { return false; }
}
function displayNameOf(username) {
  if (!username) return 'User';
  if (me && username === me.username) return me.nickname || me.username;
  const p = userProfiles[username];
  return (p && p.nickname) ? p.nickname : username;
}
function avatarUrlOf(username) {
  if (!username) return '';
  if (me && username === me.username) return me.avatar_url || '';
  const p = userProfiles[username];
  return (p && p.avatar_url) ? p.avatar_url : '';
}
function renderAvatarHtml(username) {
  const url = avatarUrlOf(username);
  const title = displayNameOf(username);
  if (url) return '<img src="' + esc(url) + '" alt="' + esc(title) + '" />';
  return esc(title.slice(0, 2));
}

function setMode(m) {
  mode = m; setErr('');
  const isReg = m === 'register';
  document.getElementById('btnModeLogin').classList.toggle('active', !isReg);
  document.getElementById('btnModeReg').classList.toggle('active', isReg);
  document.getElementById('authThumb').style.transform = isReg ? 'translateX(100%)' : 'translateX(0%)';
  document.getElementById('authTitle').textContent = isReg ? 'Создать аккаунт' : 'С возвращением!';
  document.getElementById('p2Box').classList.toggle('hidden', !isReg);
  document.getElementById('authSubmit').textContent = isReg ? 'Зарегистрироваться' : 'Войти';
  document.getElementById('authSubmit').disabled = false;
}
function setErr(msg) { document.getElementById('err').textContent = msg; }

async function submitAuth() {
  const username = document.getElementById('u').value.trim();
  const password = document.getElementById('p').value;
  const p2 = document.getElementById('p2').value;
  if (!username || !password) return setErr('Введите логин и пароль');
  if (mode === 'register' && password !== p2) return setErr('Пароли не совпадают');

  const btn = document.getElementById('authSubmit');
  const endpoint = mode === 'register' ? '/api/register' : '/api/login';
  btn.disabled = true; setErr('');

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(data.error || 'Ошибка входа или регистрации');
    if (!data.token || !data.user) return setErr('Сервер вернул неполный ответ');
    token = data.token; me = data.user;
    localStorage.setItem('rc_token', token);
    persistSavedAccount(me, token);
    enterApp();
  } catch {
    setErr('Сервер недоступен');
  } finally {
    btn.disabled = false;
  }
}

async function checkSession() {
  if (!token) return;
  try {
    const res = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return logout();
    me = await res.json();
    persistSavedAccount(me, token);
    enterApp();
  } catch {}
}

function logout() {
  closeProfilePopover(); hideIncomingCallModal(); closeVoiceContextMenu(); closeGroupModal();
  endCall(false, false); stopMicTest(); toggleGifPicker(false); closeSfxCtx();
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws) { try { ws.onclose = null; ws.close(); } catch {} ws = null; }
  localStorage.removeItem('rc_token');
  token = ''; me = null; activeChat = null;
  document.getElementById('app').classList.add('hidden');
  document.getElementById('authWrap').classList.remove('hidden');
}

function refreshMeUi() {
  if (!me) return;
  userProfiles[me.username] = { nickname: me.nickname || '', avatar_url: me.avatar_url || '' };
  document.getElementById('meName').textContent = displayNameOf(me.username);
  document.getElementById('meLoginSub').textContent = '@' + me.username;
  document.getElementById('meAv').innerHTML = renderAvatarHtml(me.username);
  document.getElementById('localTag').textContent = displayNameOf(me.username) + ' (Вы)';
  document.getElementById('localAv').innerHTML = renderAvatarHtml(me.username);
  syncProfilePopoverUi();
}

function enterApp() {
  document.getElementById('authWrap').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  refreshMeUi();
  groupsMeta = loadCachedGroups();
  renderLists();
  connectWS();
  refreshSocial();
}

function switchTab(tab) {
  ['chats', 'friends', 'requests'].forEach((t) => {
    document.getElementById('tab' + t[0].toUpperCase() + t.slice(1)).classList.toggle('active', t === tab);
    document.getElementById('panel' + t[0].toUpperCase() + t.slice(1)).classList.toggle('hidden', t !== tab);
  });
  if (tab === 'friends' || tab === 'chats') renderLists();
}

function switchSettingsTab(tab) {
  ['appearance', 'audio', 'binds', 'profile'].forEach((t) => {
    const cap = t[0].toUpperCase() + t.slice(1);
    document.getElementById('sTab' + cap).classList.toggle('active', t === tab);
    document.getElementById('sPanel' + cap).classList.toggle('hidden', t !== tab);
  });
  if (tab === 'audio') populateAudioDevices();
  if (tab === 'profile') loadProfileForm();
}

async function openSettings() {
  closeProfilePopover();
  document.getElementById('settingsModal').classList.remove('hidden');
  document.getElementById('micGainSlider').value = micGainPercent;
  document.getElementById('micGainVal').textContent = micGainPercent + '%';
  document.getElementById('nsToggle').checked = noiseSuppressionEnabled;
  loadProfileForm();
  await populateAudioDevices();
}

function closeSettings() {
  stopMicTest();
  document.getElementById('settingsModal').classList.add('hidden');
}

function stopIncomingRing() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
}

function showIncomingCallModal(callerUsername, ctxObj) {
  if (isUserBlocked(callerUsername)) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'call-reject', to: callerUsername }));
    }
    return;
  }
  pendingCaller = { username: callerUsername, callContext: ctxObj || { kind: 'dm', id: callerUsername } };
  document.getElementById('incomingCallerName').textContent = displayNameOf(callerUsername);
  document.getElementById('incomingCallerLogin').textContent = (ctxObj && ctxObj.kind === 'group')
    ? ('Группа • @' + callerUsername)
    : ('@' + callerUsername);
  document.getElementById('incomingCallerAv').innerHTML = renderAvatarHtml(callerUsername);
  document.getElementById('incomingMeAv').innerHTML = me ? renderAvatarHtml(me.username) : 'Я';
  document.getElementById('incomingCallModal').classList.remove('hidden');
  stopIncomingRing();
  playDiscordSfx('incoming');
  ringTimer = setInterval(() => {
    if (!pendingCaller) return stopIncomingRing();
    playDiscordSfx('incoming');
  }, 2200);
}

function hideIncomingCallModal() {
  pendingCaller = null;
  stopIncomingRing();
  document.getElementById('incomingCallModal').classList.add('hidden');
}

async function acceptIncomingCall() {
  if (!pendingCaller) return;
  const { username: caller, callContext: ctxObj } = pendingCaller;
  hideIncomingCallModal();
  playDiscordSfx('join');
  callContext = ctxObj || { kind: 'dm', id: caller };
  callInitiator = caller;
  await openCallUI(false, [caller]);
  startCallTimer();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'call-accept', to: caller, callContext }));
  }
}

function rejectIncomingCall() {
  if (!pendingCaller) return;
  const caller = pendingCaller.username;
  hideIncomingCallModal();
  playDiscordSfx('leave');
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'call-reject', to: caller }));
  }
}

function loadProfileForm() {
  if (!me) return;
  document.getElementById('profileLoginReadonly').value = me.username;
  document.getElementById('profileNickInput').value = me.nickname || '';
  document.getElementById('profileAvPreview').innerHTML = renderAvatarHtml(me.username);
  document.getElementById('profileStatus').textContent = '';
}

function onAvatarFileChange(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file || !me) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const maxDim = 200;
      let w = img.width, h = img.height;
      if (w > h && w > maxDim) { h = Math.round((h * maxDim) / w); w = maxDim; }
      else if (h >= w && h > maxDim) { w = Math.round((w * maxDim) / h); h = maxDim; }
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      me.avatar_url = canvas.toDataURL('image/jpeg', 0.8);
      document.getElementById('profileAvPreview').innerHTML = renderAvatarHtml(me.username);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function clearAvatar() {
  if (!me) return;
  me.avatar_url = '';
  document.getElementById('profileAvPreview').innerHTML = renderAvatarHtml(me.username);
}

async function saveProfile() {
  if (!me || !token) return;
  const nick = document.getElementById('profileNickInput').value.trim().slice(0, 32);
  const st = document.getElementById('profileStatus');
  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ nickname: nick, avatar_url: me.avatar_url || '' })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      st.style.color = '#ff7b72';
      st.textContent = data.error || 'Ошибка сохранения';
      return;
    }
    me = data.user;
    persistSavedAccount(me, token);
    refreshMeUi();
    renderLists();
    updateActiveHeaderTitle();
    st.style.color = '#30d158';
    st.textContent = 'Сохранено!';
  } catch {
    st.style.color = '#ff7b72';
    st.textContent = 'Ошибка сети';
  }
}

async function populateAudioDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch {}
  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter((d) => d.kind === 'audioinput');
  const spks = devices.filter((d) => d.kind === 'audiooutput');

  document.getElementById('micSelect').innerHTML = mics.map((d, i) =>
    '<option value="' + esc(d.deviceId) + '" ' + (d.deviceId === selectedMicId ? 'selected' : '') + '>' + esc(d.label || ('Микрофон ' + (i + 1))) + '</option>'
  ).join('') || '<option value="">По умолчанию</option>';

  document.getElementById('spkSelect').innerHTML = spks.map((d, i) =>
    '<option value="' + esc(d.deviceId) + '" ' + (d.deviceId === selectedSpkId ? 'selected' : '') + '>' + esc(d.label || ('Динамики ' + (i + 1))) + '</option>'
  ).join('') || '<option value="">По умолчанию</option>';
}

async function applyOutputDeviceToAll() {
  if (!selectedSpkId) return;
  for (const aud of remoteAudios.values()) {
    if (aud && typeof aud.setSinkId === 'function') {
      try { await aud.setSinkId(selectedSpkId); } catch {}
    }
  }
}

async function changeAudioDevices() {
  selectedMicId = document.getElementById('micSelect').value;
  selectedSpkId = document.getElementById('spkSelect').value;
  localStorage.setItem('rc_mic_id', selectedMicId);
  localStorage.setItem('rc_spk_id', selectedSpkId);
  await applyOutputDeviceToAll();
  if (inCall) await rebuildCallMic();
}

function updateMicGain(val) {
  micGainPercent = Number(val);
  document.getElementById('micGainVal').textContent = micGainPercent + '%';
  localStorage.setItem('rc_mic_gain', String(micGainPercent));
  if (micGainNode) micGainNode.gain.value = micGainPercent / 100;
}

async function toggleNoiseSuppression(enabled) {
  noiseSuppressionEnabled = !!enabled;
  localStorage.setItem('rc_ns', String(noiseSuppressionEnabled));
  if (inCall) await rebuildCallMic();
}

async function toggleMicTest() {
  const btn = document.getElementById('micTestBtn');
  if (testStream) { stopMicTest(); return; }
  try {
    testStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: selectedMicId ? { exact: selectedMicId } : undefined,
        echoCancellation: noiseSuppressionEnabled,
        noiseSuppression: noiseSuppressionEnabled,
        autoGainControl: noiseSuppressionEnabled
      }
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    testCtx = new Ctx();
    const src = testCtx.createMediaStreamSource(testStream);
    const analyser = testCtx.createAnalyser();
    analyser.fftSize = 128;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    btn.textContent = 'Остановить';
    const loop = () => {
      if (!testStream || document.hidden) { testRaf = null; return; }
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const pct = Math.min(100, Math.round((avg / 90) * 100 * (micGainPercent / 100)));
      document.getElementById('micMeterFill').style.width = pct + '%';
      testRaf = requestAnimationFrame(loop);
    };
    loop();
  } catch {}
}

function stopMicTest() {
  if (testRaf) cancelAnimationFrame(testRaf);
  testRaf = null;
  if (testStream) { testStream.getTracks().forEach((t) => t.stop()); testStream = null; }
  if (testCtx) { try { testCtx.close(); } catch {} testCtx = null; }
  const btn = document.getElementById('micTestBtn');
  const fill = document.getElementById('micMeterFill');
  if (btn) btn.textContent = 'Проверить';
  if (fill) fill.style.width = '0%';
}

function getDraftKey() {
  if (!activeChat) return '';
  return 'rc_draft_' + activeChat.kind + '_' + activeChat.id;
}

function onMsgInput() {
  const dk = getDraftKey();
  if (!dk) return;
  const val = document.getElementById('msgInput').value;
  localStorage.setItem(dk, val);
  const found = extractEmojis(val);
  if (found.length > 0) saveRecentSticker(found[found.length - 1]);
}

function toggleGifPicker(forceState) {
  const picker = document.getElementById('gifPicker');
  if (!picker) return;
  const nextOpen = typeof forceState === 'boolean' ? forceState : picker.classList.contains('hidden');
  picker.classList.toggle('hidden', !nextOpen);
  if (nextOpen) {
    const inp = document.getElementById('gifSearchInput');
    if (inp) { inp.focus(); searchGifs(inp.value.trim() || 'trending'); }
  }
}

function handleGifEnter(rawVal) {
  const trimmed = String(rawVal || '').trim();
  if (isSafeHttpUrl(trimmed)) { sendGifUrl(trimmed, 'custom-gif'); return; }
  searchGifs(trimmed || 'trending');
}

function debouncedSearchGifs(q) {
  clearTimeout(gifDebounceTimer);
  const trimmed = String(q || '').trim();
  if (isSafeHttpUrl(trimmed)) return;
  gifDebounceTimer = setTimeout(() => searchGifs(trimmed || 'trending'), 300);
}

async function searchGifs(query) {
  const grid = document.getElementById('gifResultsGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="item-sub">Поиск гифок...</div>';
  try {
    const res = await fetch('/api/gifs?q=' + encodeURIComponent(query), {
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    });
    const data = await res.json().catch(() => ({}));
    const list = Array.isArray(data.results) ? data.results.filter((g) => g && isSafeHttpUrl(g.url)) : [];
    if (!list.length) {
      grid.innerHTML = '<div class="item-sub">Ничего не найдено — вставь любую https://...gif ссылку и жми Enter</div>';
      return;
    }
    grid.innerHTML = list.map((g) =>
      '<button type="button" class="gif-card" data-gif-url="' + esc(g.url) + '" data-gif-title="' + esc(g.title || 'gif') + '">' +
        '<img src="' + esc(isSafeHttpUrl(g.preview) ? g.preview : g.url) + '" alt="' + esc(g.title || 'GIF') + '" loading="lazy" />' +
      '</button>'
    ).join('');
    grid.querySelectorAll('[data-gif-url]').forEach((btn) => {
      btn.addEventListener('click', () => sendGifUrl(btn.dataset.gifUrl, btn.dataset.gifTitle));
    });
  } catch {
    grid.innerHTML = '<div class="item-sub">Ошибка загрузки GIF</div>';
  }
}

async function ensureSocketReady() {
  if (ws && ws.readyState === WebSocket.OPEN) return true;
  connectWS();
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (ws && ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

async function sendOutboundMessageText(encodedText) {
  if (!activeChat) return;
  const ok = await ensureSocketReady();
  if (!ok || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (activeChat.kind === 'group') {
    ws.send(JSON.stringify({ type: 'group-dm', groupId: activeChat.id, text: encodedText }));
    const g = getGroupById(activeChat.id);
    if (g) { g.lastMessage = encodedText; saveCachedGroups(); renderLists(); }
  } else {
    ws.send(JSON.stringify({ type: 'dm', to: activeChat.id, text: encodedText }));
  }
}

function sendGifUrl(url, title) {
  if (!url || !isSafeHttpUrl(url)) return;
  const safeName = String(title || 'animation').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'animation';
  const payload = JSON.stringify({ name: safeName + '.gif', size: 0, mime: 'image/gif', dataUrl: url });
  sendOutboundMessageText('__FILE__:' + payload);
  toggleGifPicker(false);
}

function normalizeUserEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return { username: entry, nickname: '', avatar_url: '' };
  const uname = String(entry.username || entry.user || entry.login || entry.name || '').trim();
  if (!uname) return null;
  return {
    username: uname,
    nickname: entry.nickname || entry.nick || '',
    avatar_url: entry.avatar_url || entry.avatarUrl || '',
    lastMessage: entry.lastMessage || entry.last_message || ''
  };
}

function getAllKnownFriends() {
  const map = new Map();
  for (const item of [...friends, ...chatsMeta]) {
    const n = normalizeUserEntry(item);
    if (n && (!me || n.username !== me.username) && !map.has(n.username)) {
      map.set(n.username, n);
    }
  }
  return [...map.values()];
}

async function refreshSocial() {
  if (!token) return;
  try {
    const [fRes, rRes, gRes] = await Promise.all([
      fetch('/api/friends', { headers: { Authorization: 'Bearer ' + token } }),
      fetch('/api/friends/requests', { headers: { Authorization: 'Bearer ' + token } }),
      fetch('/api/groups', { headers: { Authorization: 'Bearer ' + token } }).catch(() => null)
    ]);
    if (fRes.ok) {
      const fData = await fRes.json().catch(() => ({}));
      const rawFriends = Array.isArray(fData)
        ? fData
        : (Array.isArray(fData.friends) ? fData.friends : (Array.isArray(fData.users) ? fData.users : []));
      const rawChats = Array.isArray(fData.chats) ? fData.chats : rawFriends;
      friends = rawFriends.map(normalizeUserEntry).filter(Boolean);
      chatsMeta = rawChats.map(normalizeUserEntry).filter(Boolean);
      for (const item of [...friends, ...chatsMeta]) {
        userProfiles[item.username] = { nickname: item.nickname || '', avatar_url: item.avatar_url || '' };
      }
    }
    if (rRes.ok) {
      const rData = await rRes.json().catch(() => ({}));
      const rawInc = Array.isArray(rData)
        ? rData
        : (Array.isArray(rData.incoming) ? rData.incoming : (Array.isArray(rData.requests) ? rData.requests : []));
      incomingReqs = rawInc.map(normalizeUserEntry).filter(Boolean);
      for (const req of incomingReqs) {
        userProfiles[req.username] = { nickname: req.nickname || '', avatar_url: req.avatar_url || '' };
      }
    }
    if (gRes && gRes.ok) {
      const gData = await gRes.json().catch(() => ({}));
      const rawGroups = Array.isArray(gData)
        ? gData
        : (Array.isArray(gData.groups) ? gData.groups : (Array.isArray(gData.rooms) ? gData.rooms : []));
      const serverNormalized = rawGroups.map(normalizeGroupItem).filter(Boolean);
      const cached = loadCachedGroups();
      const mergedMap = new Map();
      for (const cg of cached) mergedMap.set(cg.id, cg);
      for (const sg of serverNormalized) {
        const prev = mergedMap.get(sg.id);
        mergedMap.set(sg.id, prev ? {
          ...prev,
          ...sg,
          members: sg.members.length ? sg.members : prev.members,
          lastMessage: sg.lastMessage || prev.lastMessage || ''
        } : sg);
      }
      groupsMeta = [...mergedMap.values()];
      saveCachedGroups();

      for (const grp of groupsMeta) {
        if (grp.profiles) {
          for (const [u, prof] of Object.entries(grp.profiles)) {
            userProfiles[u] = { nickname: (prof && prof.nickname) || '', avatar_url: (prof && prof.avatar_url) || '' };
          }
        }
      }
    }
    renderLists();
    updateActiveHeaderTitle();
  } catch {}
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return n + ' Б';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' КБ';
  return (n / (1024 * 1024)).toFixed(2) + ' МБ';
}

function formatPreviewText(txt) {
  if (!txt) return 'Открыть чат';
  if (txt.startsWith('__CALL__:')) {
    const info = parseCallLogMessage(txt);
    if (info && info.completed) return 'Звонок • ' + formatDurationWords(info.durationSec);
    return 'Пропущенный или отменённый звонок';
  }
  if (txt.startsWith('__VOICE__:')) return 'Голосовое сообщение';
  if (txt.startsWith('__FILE__:')) {
    try {
      const f = JSON.parse(txt.slice('__FILE__:'.length));
      if (f.mime === 'image/gif' || /\.gif(\?.*)?$/i.test(String(f.name || f.dataUrl || ''))) return 'Фото';
      return 'Файл: ' + (f.name || 'вложение');
    } catch { return 'Файл'; }
  }
  return txt;
}

function renderLists() {
  const badge = document.getElementById('reqBadge');
  if (incomingReqs.length > 0) {
    badge.textContent = String(incomingReqs.length);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  const gBox = document.getElementById('groupsList');
  if (gBox) {
    const groupRows = groupsMeta.map((g) => {
      const isAct = activeChat && activeChat.kind === 'group' && activeChat.id === g.id;
      const cnt = (g.members && g.members.length) || 1;
      const membersLabel = cnt + ' ' + ruPlural(cnt, 'участник', 'участника', 'участников');
      const subText = g.lastMessage ? formatPreviewText(g.lastMessage) : 'Нажми, чтобы открыть группу';
      return (
        '<div class="list-item ' + (isAct ? 'active' : '') + '" data-open-group="' + esc(g.id) + '">' +
          '<div class="item-left">' +
            '<div class="avatar group-av">' + esc(getGroupInitials(g)) + '</div>' +
            '<div style="min-width:0">' +
              '<div class="item-name">' + esc(getGroupTitle(g)) + '</div>' +
              '<div class="item-sub">' + esc(membersLabel + ' • ' + subText) + '</div>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
    });
    gBox.innerHTML = groupRows.length
      ? groupRows.join('')
      : '<div class="item-sub" style="padding:4px 6px;">Групп пока нет — нажми «+» сверху</div>';

    gBox.querySelectorAll('[data-open-group]').forEach((el) => {
      el.addEventListener('click', () => openGroupChat(el.dataset.openGroup));
    });
  }

  const cBox = document.getElementById('chatsList');
  const dmSource = chatsMeta.length ? chatsMeta : friends;
  const dmRows = dmSource.map((c) => {
    const isAct = activeChat && activeChat.kind === 'dm' && activeChat.id === c.username;
    const blocked = isUserBlocked(c.username);
    return (
      '<div class="list-item ' + (isAct ? 'active' : '') + '" data-open-dm="' + esc(c.username) + '">' +
        '<div class="item-left">' +
          '<div class="avatar">' + renderAvatarHtml(c.username) + '</div>' +
          '<div style="min-width:0">' +
            '<div class="item-name">' + esc(displayNameOf(c.username)) + (blocked ? ' (заблокирован)' : '') + '</div>' +
            '<div class="item-sub">' + esc(blocked ? 'Пользователь заблокирован' : formatPreviewText(c.lastMessage)) + '</div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  });

  cBox.innerHTML = dmRows.length
    ? dmRows.join('')
    : '<div class="item-sub" style="padding:6px;">Добавь друга во вкладке «Друзья»</div>';

  cBox.querySelectorAll('[data-open-dm]').forEach((el) => {
    el.addEventListener('click', () => openChat(el.dataset.openDm));
  });

  const fBox = document.getElementById('friendsList');
  const friendRows = getAllKnownFriends();
  fBox.innerHTML = friendRows.length
    ? friendRows.map((f) => {
      const blocked = isUserBlocked(f.username);
      return (
        '<div class="list-item ' + (activeChat && activeChat.kind === 'dm' && activeChat.id === f.username ? 'active' : '') + '" data-open-dm="' + esc(f.username) + '">' +
          '<div class="item-left">' +
            '<div class="avatar">' + renderAvatarHtml(f.username) + '</div>' +
            '<div style="min-width:0">' +
              '<div class="item-name">' + esc(displayNameOf(f.username)) + '</div>' +
              (blocked ? '<div class="item-sub" style="color:#ff6961;">Заблокирован</div>' : '<div class="item-sub">@' + esc(f.username) + '</div>') +
            '</div>' +
          '</div>' +
          '<div class="item-actions">' +
            '<button type="button" class="icon-btn" title="Позвонить" data-call-user="' + esc(f.username) + '">' +
              '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>' +
            '</button>' +
            '<button type="button" class="icon-btn danger" title="Удалить из друзей" data-remove-friend="' + esc(f.username) + '">' +
              '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
            '</button>' +
          '</div>' +
        '</div>'
      );
    }).join('')
    : '<div class="item-sub" style="padding:8px;">Пока никого нет</div>';

  fBox.querySelectorAll('[data-open-dm]').forEach((el) => {
    el.addEventListener('click', () => openChat(el.dataset.openDm));
  });
  fBox.querySelectorAll('[data-call-user]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      startDirectCallWith(btn.dataset.callUser);
    });
  });
  fBox.querySelectorAll('[data-remove-friend]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFriend(btn.dataset.removeFriend);
    });
  });

  const incBox = document.getElementById('incomingList');
  incBox.innerHTML = incomingReqs.length
    ? incomingReqs.map((r) => (
      '<div class="list-item">' +
        '<div class="item-left">' +
          '<div class="avatar">' + renderAvatarHtml(r.username) + '</div>' +
          '<div class="item-name">' + esc(displayNameOf(r.username)) + '</div>' +
        '</div>' +
        '<div class="item-actions">' +
          '<button type="button" class="sm-btn green" data-resp-user="' + esc(r.username) + '" data-resp-act="accept">Принять</button>' +
          '<button type="button" class="sm-btn red" data-resp-user="' + esc(r.username) + '" data-resp-act="decline">×</button>' +
        '</div>' +
      '</div>'
    )).join('')
    : '<div class="item-sub" style="padding:6px;">Нет входящих запросов</div>';

  incBox.querySelectorAll('[data-resp-user]').forEach((btn) => {
    btn.addEventListener('click', () => respondReq(btn.dataset.respUser, btn.dataset.respAct));
  });
}

async function sendFriendRequest() {
  const inp = document.getElementById('addFriendInput');
  const target = inp.value.trim();
  const st = document.getElementById('friendStatus');
  if (!target) return;
  try {
    const res = await fetch('/api/friends/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ username: target })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      st.style.color = '#ff7b72';
      st.textContent = data.error || 'Не удалось отправить запрос';
      return;
    }
    st.style.color = '#30d158';
    st.textContent = 'Запрос отправлен!';
    inp.value = '';
    refreshSocial();
  } catch { st.textContent = 'Ошибка сети'; }
}

async function respondReq(username, action) {
  await fetch('/api/friends/respond', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ username, action })
  });
  refreshSocial();
}

async function removeFriend(username) {
  await fetch('/api/friends/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ username })
  });
  friends = friends.filter((f) => f.username !== username);
  chatsMeta = chatsMeta.filter((c) => c.username !== username);
  if (activeChat && activeChat.kind === 'dm' && activeChat.id === username) activeChat = null;
  renderLists();
  refreshSocial();
}

function updateActiveHeaderTitle() {
  if (!activeChat) return;
  if (activeChat.kind === 'group') {
    const grp = getGroupById(activeChat.id) || { id: activeChat.id, title: 'Группа', members: [me && me.username].filter(Boolean) };
    const title = getGroupTitle(grp);
    const members = grp.members || [];
    const cnt = members.length || 1;
    document.getElementById('peerAv').className = 'avatar group-av';
    document.getElementById('peerAv').textContent = getGroupInitials(grp);
    document.getElementById('peerTitle').textContent = title;
    const memberNames = members.map(displayNameOf).join(', ');
    document.getElementById('peerSub').textContent = cnt + ' ' + ruPlural(cnt, 'участник', 'участника', 'участников') + (memberNames ? ' • ' + memberNames : '');
    document.getElementById('inviteGroupBtn').classList.remove('hidden');
  } else {
    const u = activeChat.id;
    document.getElementById('peerAv').className = 'avatar';
    document.getElementById('peerAv').innerHTML = renderAvatarHtml(u);
    document.getElementById('peerTitle').textContent = displayNameOf(u);
    document.getElementById('peerSub').textContent = '@' + u;
    document.getElementById('inviteGroupBtn').classList.add('hidden');
  }
  if (!inCall) document.getElementById('startCallBtn').classList.remove('hidden');
}

async function openChat(username) {
  activeChat = { kind: 'dm', id: username };
  renderLists();
  updateActiveHeaderTitle();
  document.getElementById('emojiBar').classList.remove('hidden');
  document.getElementById('composer').classList.remove('hidden');
  const inp = document.getElementById('msgInput');
  inp.placeholder = 'Написать сообщение для ' + displayNameOf(username) + '...';
  inp.value = localStorage.getItem(getDraftKey()) || '';

  const box = document.getElementById('messages');
  box.innerHTML = '';
  if (isUserBlocked(username)) {
    box.innerHTML = '<div class="empty-chat">Пользователь заблокирован. ПКМ по аватару или имени, чтобы разблокировать.</div>';
    return;
  }
  try {
    const res = await fetch('/api/dm?peer=' + encodeURIComponent(username), {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (res.ok) {
      const list = await res.json();
      if (!list.length) box.innerHTML = '<div class="empty-chat">Сообщений пока нет — напиши первым!</div>';
      else list.forEach(appendMsg);
    }
  } catch {}
}

async function openGroupChat(groupId) {
  if (!getGroupById(groupId)) {
    upsertGroup({ id: groupId, members: [me && me.username].filter(Boolean) });
  }
  activeChat = { kind: 'group', id: groupId };
  renderLists();
  updateActiveHeaderTitle();
  document.getElementById('emojiBar').classList.remove('hidden');
  document.getElementById('composer').classList.remove('hidden');
  const grp = getGroupById(groupId);
  const inp = document.getElementById('msgInput');
  inp.placeholder = 'Написать в группу «' + getGroupTitle(grp) + '»...';
  inp.value = localStorage.getItem(getDraftKey()) || '';

  const box = document.getElementById('messages');
  box.innerHTML = '';
  try {
    const res = await fetch('/api/groups/' + encodeURIComponent(groupId) + '/messages', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (res.ok) {
      const list = await res.json();
      if (!list.length) box.innerHTML = '<div class="empty-chat">Группа создана — напиши друзьям первым!</div>';
      else list.forEach(appendMsg);
    } else {
      box.innerHTML = '<div class="empty-chat">Группа создана — напиши друзьям первым!</div>';
    }
  } catch {
    box.innerHTML = '<div class="empty-chat">Группа создана — напиши друзьям первым!</div>';
  }
}

function fmtSec(sec) {
  if (!isFinite(sec) || sec <= 0) return '0:00';
  return Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
}
function normalizeVoiceSrc(rawSrc) {
  return String(rawSrc || '').replace(/^data:audio\/([a-zA-Z0-9.+-]+);[^,]*;base64,/, 'data:audio/$1;base64,');
}

function triggerFileDownload(fileKey) {
  const item = fileStore.get(fileKey);
  const btn = document.getElementById('dlBtn_' + fileKey);
  const statusEl = document.getElementById('dlStatus_' + fileKey);
  if (!item || !item.dataUrl) {
    if (btn) { btn.className = 'att-dl-btn error'; btn.textContent = 'Ошибка'; }
    if (statusEl) { statusEl.className = 'att-status-line err'; statusEl.textContent = 'Данные файла не найдены'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.className = 'att-dl-btn downloading'; btn.textContent = 'Скачиваю...'; }
  if (statusEl) { statusEl.className = 'att-status-line'; statusEl.textContent = 'Подготовка файла...'; }

  setTimeout(() => {
    try {
      if (isSafeHttpUrl(item.dataUrl)) {
        const a = document.createElement('a');
        a.href = item.dataUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.download = item.name || 'file';
        document.body.appendChild(a); a.click(); a.remove();
        if (btn) { btn.disabled = false; btn.className = 'att-dl-btn done'; btn.textContent = 'Открыто ✓'; }
        if (statusEl) { statusEl.className = 'att-status-line ok'; statusEl.textContent = 'Ссылка на файл открыта'; }
        return;
      }
      const parts = item.dataUrl.split(',');
      const mimeMatch = (parts[0] || '').match(/data:([^;]+)/);
      const mimeType = mimeMatch ? mimeMatch[1] : (item.mime || 'application/octet-stream');
      const bstr = atob(parts[1] || '');
      const u8 = new Uint8Array(bstr.length);
      for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
      const blob = new Blob([u8], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl; a.download = item.name || 'file';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
      if (btn) { btn.disabled = false; btn.className = 'att-dl-btn done'; btn.textContent = 'Скачано ✓'; }
      if (statusEl) { statusEl.className = 'att-status-line ok'; statusEl.textContent = 'Файл скачан (' + formatBytes(blob.size) + ')'; }
    } catch {
      if (btn) { btn.disabled = false; btn.className = 'att-dl-btn error'; btn.textContent = 'Повтор'; }
      if (statusEl) { statusEl.className = 'att-status-line err'; statusEl.textContent = 'Не удалось скачать файл'; }
    }
  }, 180);
}

function appendMsg(m) {
  if (m && m.sender && m.sender !== (me && me.username) && isUserBlocked(m.sender)) return;
  const box = document.getElementById('messages');
  const empty = box.querySelector('.empty-chat');
  if (empty) empty.remove();

  const rawText = String(m.text || '');
  const callInfo = parseCallLogMessage(rawText);
  if (callInfo) {
    const initName = displayNameOf(callInfo.initiator || m.sender);
    const whenStr = formatCallDateTime(callInfo.at || m.created_at);
    const row = document.createElement('div');
    row.className = 'call-log-row';
    const phoneIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.01-.24c1.12.37 2.33.57 3.58.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C9.61 21 3 14.39 3 6a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.46.57 3.58a1 1 0 0 1-.24 1.01l-2.2 2.2z"/></svg>';
    if (callInfo.completed) {
      row.innerHTML = (
        '<span class="call-log-icon">' + phoneIcon + '</span>' +
        '<span><span class="call-log-author">' + esc(initName) + '</span> начал звонок продолжительностью ' + esc(formatDurationWords(callInfo.durationSec)) + '.</span>' +
        (whenStr ? '<span class="call-log-date">' + esc(whenStr) + '</span>' : '')
      );
    } else {
      row.innerHTML = (
        '<span class="call-log-icon missed">' + phoneIcon + '</span>' +
        '<span><span class="call-log-author">' + esc(initName) + '</span> совершил звонок без ответа.</span>' +
        (whenStr ? '<span class="call-log-date">' + esc(whenStr) + '</span>' : '')
      );
    }
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
    return;
  }

  const isMine = me && m.sender === me.username;
  const dt = m.created_at ? new Date(m.created_at) : new Date();
  const hh = String(dt.getHours()).padStart(2, '0');
  const mm = String(dt.getMinutes()).padStart(2, '0');
  const bigSticker = isSingleStickerMessage(rawText);

  let bodyHtml = '';
  let fileKey = '';
  let purePhotoGif = false;

  if (rawText.startsWith('__VOICE__:data:audio/')) {
    const src = normalizeVoiceSrc(rawText.slice('__VOICE__:'.length));
    const vpId = 'vp_' + (m.id || (Date.now() + '_' + Math.random().toString(36).slice(2, 7)));
    bodyHtml = (
      '<div class="vp" id="' + vpId + '" data-src="' + esc(src) + '">' +
        '<button type="button" class="vp-play">▶</button>' +
        '<div class="vp-track"><div class="vp-fill"></div></div>' +
        '<span class="vp-dur">0:00</span>' +
      '</div>'
    );
  } else if (rawText.startsWith('__FILE__:')) {
    try {
      const f = JSON.parse(rawText.slice('__FILE__:'.length));
      const rawUrl = String(f.dataUrl || '');
      const isGif = f.mime === 'image/gif' || /^data:image\/gif;base64,/i.test(rawUrl) || /\.gif(\?.*)?$/i.test(String(f.name || rawUrl || ''));
      const isDataImg = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(rawUrl);
      const isHttpImg = isSafeHttpUrl(rawUrl) && (isGif || /\.(webp|png|jpe?g)(\?.*)?$/i.test(rawUrl));
      const isImg = isDataImg || isHttpImg;

      if (isGif && isImg) {
        purePhotoGif = true;
        bodyHtml = '<img class="att-gif" src="' + esc(rawUrl) + '" alt="photo" loading="lazy" />';
      } else {
        const safeSrc = isImg ? rawUrl : '';
        fileKey = 'fk_' + (m.id || (Date.now() + '_' + Math.random().toString(36).slice(2, 8)));
        fileStore.set(fileKey, { name: f.name || 'file', size: f.size || 0, mime: f.mime || 'application/octet-stream', dataUrl: rawUrl });
        const safeName = esc(f.name || 'file');
        const safeSize = f.size ? esc(formatBytes(f.size)) : '0 Б';
        bodyHtml = (
          (safeSrc ? '<img class="att-img" src="' + esc(safeSrc) + '" alt="' + safeName + '" loading="lazy" />' : '') +
          '<div class="att-file">' +
            '<div class="att-file-meta"><span class="att-file-name">📎 ' + safeName + '</span><span class="att-file-size">' + safeSize + '</span></div>' +
            '<button type="button" class="att-dl-btn" id="dlBtn_' + fileKey + '" data-file-key="' + fileKey + '">Скачать</button>' +
          '</div>' +
          '<div class="att-status-line" id="dlStatus_' + fileKey + '"></div>'
        );
      }
    } catch { bodyHtml = '<div class="msg-text">Вложение</div>'; }
  } else if (bigSticker) {
    bodyHtml = '<div class="msg-sticker-big">' + esc(rawText) + '</div>';
  } else {
    bodyHtml = '<div class="msg-text">' + esc(rawText) + '</div>';
  }

  const el = document.createElement('div');
  el.className = 'msg ' + (isMine ? 'mine' : 'other') + (bigSticker ? ' sticker-only' : '') + (purePhotoGif ? ' media-only' : '');
  const authorLabel = isMine ? 'Вы' : displayNameOf(m.sender);

  el.innerHTML = (
    '<div class="avatar">' + renderAvatarHtml(m.sender) + '</div>' +
    '<div class="msg-bubble">' +
      (purePhotoGif ? '' : (
        '<div class="msg-head">' +
          '<span class="msg-author">' + esc(authorLabel) + '</span>' +
          '<span class="msg-time">' + hh + ':' + mm + '</span>' +
        '</div>'
      )) +
      bodyHtml +
    '</div>'
  );
  box.appendChild(el);

  if (!isMine && m.sender) {
    el.querySelector('.avatar').addEventListener('contextmenu', (ev) => openVoiceContextMenu(ev, m.sender));
  }

  const vpEl = el.querySelector('.vp');
  if (vpEl) {
    vpEl.querySelector('.vp-play').addEventListener('click', () => toggleVoicePlay(vpEl.id));
    vpEl.querySelector('.vp-track').addEventListener('click', (ev) => seekVoice(vpEl.id, ev));
  }
  if (fileKey) {
    const dlBtn = el.querySelector('#dlBtn_' + fileKey);
    if (dlBtn) dlBtn.addEventListener('click', () => triggerFileDownload(fileKey));
  }
  box.scrollTop = box.scrollHeight;
}

function sendFileAttachment(file) {
  if (!file || !activeChat) return;
  if (file.size > MAX_FILE_BYTES) { alert('Файл слишком большой — лимит 25 МБ'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result !== 'string') return;
    const ext = (file.type && file.type.split('/')[1])
      ? file.type.split('/')[1].replace('jpeg', 'jpg').replace(/[^a-z0-9]+/gi, '')
      : 'png';
    const fileName = (file.name && file.name !== 'image.png') ? file.name : ('screenshot-' + Date.now() + '.' + (ext || 'png'));
    const payload = JSON.stringify({ name: fileName, size: file.size, mime: file.type || 'image/png', dataUrl: reader.result });
    sendOutboundMessageText('__FILE__:' + payload);
  };
  reader.readAsDataURL(file);
}

function onFileSelected(ev) {
  const inputEl = ev.target;
  const file = inputEl && inputEl.files && inputEl.files[0];
  if (!file) return;
  sendFileAttachment(file);
  inputEl.value = '';
}

window.addEventListener('paste', (e) => {
  if (!activeChat) return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) { e.preventDefault(); sendFileAttachment(file); return; }
    }
  }
});

function toggleVoicePlay(vpId) {
  const vp = document.getElementById(vpId);
  if (!vp) return;
  const src = vp.dataset.src;
  const playBtn = vp.querySelector('.vp-play');
  const fillEl = vp.querySelector('.vp-fill');
  const durEl = vp.querySelector('.vp-dur');

  if (currentPlayingUi && currentPlayingUi !== vp) {
    if (currentPlayingAudio) { try { currentPlayingAudio.pause(); } catch {} }
    const prevBtn = currentPlayingUi.querySelector('.vp-play');
    if (prevBtn) prevBtn.textContent = '▶';
  }
  if (!vp._audio) {
    const aud = new Audio();
    aud.preload = 'auto';
    aud.src = src;
    aud.addEventListener('loadedmetadata', () => { if (isFinite(aud.duration) && aud.duration > 0) durEl.textContent = fmtSec(aud.duration); });
    aud.addEventListener('timeupdate', () => {
      if (isFinite(aud.duration) && aud.duration > 0) {
        fillEl.style.width = ((aud.currentTime / aud.duration) * 100) + '%';
        durEl.textContent = fmtSec(aud.currentTime);
      }
    });
    aud.addEventListener('ended', () => {
      playBtn.textContent = '▶'; fillEl.style.width = '0%';
      if (isFinite(aud.duration) && aud.duration > 0) durEl.textContent = fmtSec(aud.duration);
    });
    aud.addEventListener('error', () => { playBtn.textContent = '▶'; durEl.textContent = 'Ошибка'; });
    vp._audio = aud;
  }
  const aud = vp._audio;
  if (aud.paused) {
    currentPlayingAudio = aud; currentPlayingUi = vp; playBtn.textContent = '❚❚';
    const p = aud.play();
    if (p && typeof p.catch === 'function') p.catch(() => { playBtn.textContent = '▶'; });
  } else {
    aud.pause(); playBtn.textContent = '▶';
  }
}

function seekVoice(vpId, ev) {
  const vp = document.getElementById(vpId);
  if (!vp || !vp._audio || !isFinite(vp._audio.duration) || vp._audio.duration <= 0) return;
  const rect = ev.currentTarget.getBoundingClientRect();
  vp._audio.currentTime = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)) * vp._audio.duration;
}

function sendChat() {
  if (!activeChat) return;
  const inp = document.getElementById('msgInput');
  const text = inp.value.trim();
  if (!text) return;
  const found = extractEmojis(text);
  if (found.length > 0) saveRecentSticker(found[found.length - 1]);
  sendOutboundMessageText(text);
  inp.value = '';
  const dk = getDraftKey();
  if (dk) localStorage.removeItem(dk);
}

function pickRecorderMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  for (const m of ['audio/webm', 'audio/mp4', 'audio/ogg']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

let voiceRecordLocked = false;
let voiceRecordCancel = false;
let voiceRecordPointerDown = false;
let voiceRecordStartY = 0;
let voiceRecordStream = null;

async function startVoiceRecord(ev) {
  if (!activeChat || (mediaRecorder && mediaRecorder.state === 'recording')) return;
  ev.preventDefault();
  voiceRecordPointerDown = true;
  voiceRecordLocked = false;
  voiceRecordCancel = false;
  voiceRecordStartY = ev.clientY;
  const btn = document.getElementById('recVoiceBtn');
  const timerEl = document.getElementById('recTimer');
  const composer = document.getElementById('composer');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: selectedMicId ? { exact: selectedMicId } : undefined, echoCancellation: true, noiseSuppression: noiseSuppressionEnabled }
    });
    voiceRecordStream = stream;
    // The pointer may have been released while the permission prompt was open.
    if (!voiceRecordPointerDown) {
      stream.getTracks().forEach((t) => t.stop());
      voiceRecordStream = null;
      return;
    }
    voiceChunks = [];
    const chosenMime = pickRecorderMimeType();
    mediaRecorder = chosenMime ? new MediaRecorder(stream, { mimeType: chosenMime }) : new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) voiceChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      clearInterval(recInterval);
      btn.classList.remove('recording');
      composer.classList.remove('voice-recording', 'voice-locked');
      timerEl.classList.add('hidden');
      stream.getTracks().forEach((t) => t.stop());
      voiceRecordStream = null;
      const shouldSend = !voiceRecordCancel;
      const recorder = mediaRecorder;
      mediaRecorder = null;
      if (!shouldSend) { voiceChunks = []; return; }
      const baseMime = (recorder.mimeType || chosenMime || 'audio/webm').split(';')[0];
      const blob = new Blob(voiceChunks, { type: baseMime });
      voiceChunks = [];
      if (blob.size < 200) return;
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') sendOutboundMessageText('__VOICE__:' + normalizeVoiceSrc(reader.result));
      };
      reader.readAsDataURL(blob);
    };
    recSeconds = 0;
    timerEl.textContent = '● 0:00';
    timerEl.classList.remove('hidden');
    composer.classList.add('voice-recording');
    btn.classList.add('recording');
    recInterval = setInterval(() => {
      recSeconds += 1;
      timerEl.textContent = '● ' + fmtSec(recSeconds);
      if (recSeconds >= 60 && mediaRecorder && mediaRecorder.state === 'recording') stopVoiceRecord(true);
    }, 1000);
    mediaRecorder.start();
  } catch (err) {
    voiceRecordPointerDown = false;
    if (voiceRecordStream) voiceRecordStream.getTracks().forEach((t) => t.stop());
    voiceRecordStream = null;
    document.getElementById('recTimer').classList.add('hidden');
    document.getElementById('composer').classList.remove('voice-recording', 'voice-locked');
    btn.classList.remove('recording');
  }
}

function moveVoiceRecord(ev) {
  if (!voiceRecordPointerDown || voiceRecordLocked || !mediaRecorder || mediaRecorder.state !== 'recording') return;
  if (voiceRecordStartY - ev.clientY >= 72) {
    voiceRecordLocked = true;
    document.getElementById('composer').classList.add('voice-locked');
    document.getElementById('recTimer').textContent = '● ' + fmtSec(recSeconds) + ' · Запись закреплена';
  }
}

function releaseVoiceRecord() {
  if (!voiceRecordPointerDown) return;
  voiceRecordPointerDown = false;
  if (!voiceRecordLocked) stopVoiceRecord(true);
}

function stopVoiceRecord(send) {
  voiceRecordCancel = !send;
  voiceRecordPointerDown = false;
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
}

function sendLockedVoice() {
  if (voiceRecordLocked) stopVoiceRecord(true);
}

function cancelLockedVoice() {
  if (voiceRecordLocked) stopVoiceRecord(false);
}

// Kept as a compatibility entry point for older UI bindings.
function toggleVoiceRecord() {
  if (mediaRecorder && mediaRecorder.state === 'recording') stopVoiceRecord(true);
  else startVoiceRecord({ preventDefault() {}, clientY: 0 });
}

function startRingTone() {
  stopRingTone();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    ringAudioCtx = new Ctx();
    const playToneCycle = () => {
      if (!ringAudioCtx || !isRingingOutgoing || deafened) return;
      if (ringAudioCtx.state === 'suspended') ringAudioCtx.resume().catch(() => {});
      const now = ringAudioCtx.currentTime;
      const osc = ringAudioCtx.createOscillator();
      const gain = ringAudioCtx.createGain();
      osc.type = 'sine'; osc.frequency.setValueAtTime(440, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.07, now + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.95);
      osc.connect(gain); gain.connect(ringAudioCtx.destination);
      osc.start(now); osc.stop(now + 1.0);
    };
    playToneCycle();
    ringTimer = setInterval(playToneCycle, 2400);
  } catch {}
}

function stopRingTone() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  if (ringAudioCtx) { try { ringAudioCtx.close(); } catch {} ringAudioCtx = null; }
}

function connectWS() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(proto + '//' + location.host);
  ws = sock;

  sock.onopen = () => {
    if (ws !== sock) return;
    if (token) sock.send(JSON.stringify({ type: 'auth-token', token }));
    else if (me && me.username) sock.send(JSON.stringify({ type: 'auth-user', username: me.username }));
  };

  sock.onmessage = async (ev) => {
    if (ws !== sock) return;
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (!data || typeof data.type !== 'string') return;

    if (data.type === 'dm' && data.message) {
      const m = data.message;
      const other = m.sender === me.username ? m.recipient : m.sender;
      if (m.sender !== me.username && isUserBlocked(m.sender)) return;
      if (m.sender !== me.username && !String(m.text || '').startsWith('__CALL__:')) playDiscordSfx('message');
      if (activeChat && activeChat.kind === 'dm' && activeChat.id === other) appendMsg(m);
      refreshSocial();
    } else if (data.type === 'group-dm' && data.message) {
      const m = data.message;
      const gId = m.groupId || data.groupId;
      if (m.sender !== me.username && isUserBlocked(m.sender)) return;
      if (m.sender !== me.username && !String(m.text || '').startsWith('__CALL__:')) playDiscordSfx('message');
      const gObj = getGroupById(gId);
      if (gObj && m.text) { gObj.lastMessage = m.text; saveCachedGroups(); renderLists(); }
      if (activeChat && activeChat.kind === 'group' && activeChat.id === gId) appendMsg(m);
      refreshSocial();
    } else if (data.type === 'group-created' || data.type === 'group-invited') {
      if (data.group) upsertGroup(data.group);
      refreshSocial();
    } else if (data.type === 'friend-update' || data.type === 'group-update') {
      if (data.group) upsertGroup(data.group);
      refreshSocial();
    } else if (data.type === 'call-invite') {
      if (inCall || pendingCaller || isUserBlocked(data.from)) {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'call-reject', to: data.from }));
        return;
      }
      showIncomingCallModal(data.from, data.callContext || { kind: 'dm', id: data.from });
    } else if (data.type === 'call-accept') {
      isRingingOutgoing = false;
      stopRingTone();
      if (!callConnectedAt) startCallTimer();
      playDiscordSfx('join');
      ensureRemoteTile(data.from);
      document.getElementById('callStatusText').textContent = 'В голосовом звонке';
      await sendOfferTo(data.from);
    } else if (data.type === 'call-reject' || data.type === 'call-end') {
      if (pendingCaller && pendingCaller.username === data.from) hideIncomingCallModal();
      if (callContext && callContext.kind === 'group') {
        cleanupPeerConnection(data.from);
        if (peerConnections.size === 0 && !callConnectedAt) {
          endCall(false, false);
        }
      } else {
        playDiscordSfx('leave');
        endCall(false, false);
      }
    } else if (data.type === 'signal') {
      await handleSignal(data.signal, data.from, data.callContext);
    }
  };

  sock.onclose = () => {
    if (ws === sock) ws = null;
    if (me && token) {
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connectWS, 2000);
    }
  };
}

function startCallWithActiveChat() {
  if (!activeChat || inCall) return;
  if (activeChat.kind === 'group') {
    startGroupCall(activeChat.id);
  } else {
    startDirectCallWith(activeChat.id);
  }
}

async function startDirectCallWith(targetUser) {
  if (inCall || !targetUser) return;
  callContext = { kind: 'dm', id: targetUser };
  callInitiator = me ? me.username : targetUser;
  await openCallUI(true, [targetUser]);
  const ok = await ensureSocketReady();
  if (ok && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'call-invite', to: targetUser, callContext }));
  }
}

async function startGroupCall(groupId) {
  if (inCall || !groupId) return;
  const grp = getGroupById(groupId);
  const targets = ((grp && grp.members) || []).filter((u) => me && u !== me.username && !isUserBlocked(u));
  callContext = { kind: 'group', id: groupId };
  callInitiator = me ? me.username : '';
  await openCallUI(true, targets);
  const ok = await ensureSocketReady();
  if (ok && ws && ws.readyState === WebSocket.OPEN) {
    for (const u of targets) {
      ws.send(JSON.stringify({ type: 'call-invite', to: u, callContext }));
    }
  }
}

function ensureRemoteTile(username) {
  if (!username || (me && username === me.username)) return null;
  let tile = document.getElementById('remoteTile_' + username);
  if (tile) return tile;

  const grid = document.getElementById('callGrid');
  tile = document.createElement('div');
  tile.id = 'remoteTile_' + username;
  tile.className = 'tile';
  tile.innerHTML = (
    '<div id="remoteAv_' + esc(username) + '" class="big-av">' + renderAvatarHtml(username) + '</div>' +
    '<video id="remoteVideo_' + esc(username) + '" autoplay playsinline class="hidden"></video>' +
    '<button id="remoteFsBtn_' + esc(username) + '" type="button" class="fs-btn hidden">На весь экран</button>' +
    '<div id="remoteTag_' + esc(username) + '" class="tile-tag">' + esc(displayNameOf(username)) + '</div>'
  );
  grid.appendChild(tile);

  const rv = tile.querySelector('video');
  const fsBtn = tile.querySelector('button');
  rv.addEventListener('dblclick', () => toggleFullscreenVideo(rv.id));
  fsBtn.addEventListener('click', () => toggleFullscreenVideo(rv.id));
  tile.addEventListener('contextmenu', (ev) => openVoiceContextMenu(ev, username));
  return tile;
}

function cleanupPeerConnection(username) {
  const c = peerConnections.get(username);
  if (c) {
    try {
      c.ontrack = null;
      c.onicecandidate = null;
      c.onnegotiationneeded = null;
      c.close();
    } catch {}
    peerConnections.delete(username);
  }
  const aud = remoteAudios.get(username);
  if (aud) { aud.srcObject = null; try { aud.remove(); } catch {} remoteAudios.delete(username); }
  remoteStreams.delete(username);

  const tile = document.getElementById('remoteTile_' + username);
  if (tile) tile.remove();
}

async function createCleanMicStream() {
  rawMicStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: selectedMicId ? { exact: selectedMicId } : undefined,
      echoCancellation: noiseSuppressionEnabled,
      noiseSuppression: noiseSuppressionEnabled,
      autoGainControl: noiseSuppressionEnabled
    },
    video: false
  });
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    rawMicStream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; });
    return rawMicStream;
  }
  if (micAudioCtx) { try { await micAudioCtx.close(); } catch {} micAudioCtx = null; }
  micAudioCtx = new Ctx();
  const src = micAudioCtx.createMediaStreamSource(rawMicStream);
  micGainNode = micAudioCtx.createGain();
  micGainNode.gain.value = micGainPercent / 100;
  micAnalyser = micAudioCtx.createAnalyser();
  micAnalyser.fftSize = 64;
  const dst = micAudioCtx.createMediaStreamDestination();
  src.connect(micGainNode); micGainNode.connect(micAnalyser); micGainNode.connect(dst);

  const out = new MediaStream();
  dst.stream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; out.addTrack(t); });
  return out;
}

function startSpeakingLoop() {
  if (speakRaf) cancelAnimationFrame(speakRaf);
  const localBuf = new Uint8Array(32);
  let lastLocalSpoke = false;

  const tick = () => {
    if (!inCall || document.hidden) {
      speakRaf = null;
      return;
    }
    let localSpeaking = false;
    if (micAnalyser && !micMuted) {
      micAnalyser.getByteFrequencyData(localBuf);
      const avg = localBuf.reduce((a, b) => a + b, 0) / localBuf.length;
      localSpeaking = avg > 18;
    }
    if (localSpeaking !== lastLocalSpoke) {
      lastLocalSpoke = localSpeaking;
      document.getElementById('localTile').classList.toggle('speaking', localSpeaking);
      document.getElementById('meAv').classList.toggle('speaking-ring', localSpeaking);
    }

    speakRaf = requestAnimationFrame(tick);
  };
  speakRaf = requestAnimationFrame(tick);
}

async function rebuildCallMic() {
  const oldRaw = rawMicStream;
  const oldProc = micStream;
  try {
    micStream = await createCleanMicStream();
    const nextTrack = micStream.getAudioTracks()[0];
    if (nextTrack) {
      for (const c of peerConnections.values()) {
        const sender = c.getSenders().find((s) => s.track && s.track.kind === 'audio');
        if (sender) await sender.replaceTrack(nextTrack);
      }
    }
  } catch {}
  if (oldProc) oldProc.getTracks().forEach((t) => t.stop());
  if (oldRaw) oldRaw.getTracks().forEach((t) => t.stop());
}

async function openCallUI(outgoing, targetUsers) {
  inCall = true;
  isRingingOutgoing = !!outgoing;
  localPreviewVisible = false;
  if (pttEnabled) micMuted = true;
  document.getElementById('startCallBtn').classList.add('hidden');
  document.getElementById('callStage').classList.remove('hidden');

  if (callContext && callContext.kind === 'group') {
    const grp = getGroupById(callContext.id);
    document.getElementById('callStatusText').textContent = 'Групповой звонок • ' + getGroupTitle(grp);
  } else {
    const first = (targetUsers && targetUsers[0]) || '';
    document.getElementById('callStatusText').textContent = outgoing
      ? 'Дозвон ' + displayNameOf(first) + '...'
      : 'На связи с ' + displayNameOf(first);
  }

  for (const u of (targetUsers || [])) {
    ensureRemoteTile(u);
  }

  if (outgoing) startRingTone();
  else stopRingTone();

  if (!micStream) {
    try { micStream = await createCleanMicStream(); } catch {}
  }
  updateCallButtons();
  startSpeakingLoop();
}

function endCall(notify = true, postLog = true) {
  closeVoiceContextMenu();
  const ctxAtEnd = callContext;
  const initiatorAtEnd = callInitiator;
  const wasConnected = !!callConnectedAt;
  const elapsedSec = wasConnected ? Math.floor((Date.now() - callConnectedAt) / 1000) : 0;

  if (notify) playDiscordSfx('leave');
  if (notify && ws && ws.readyState === WebSocket.OPEN) {
    const sigType = isRingingOutgoing ? 'call-reject' : 'call-end';
    if (ctxAtEnd && ctxAtEnd.kind === 'group') {
      const grp = getGroupById(ctxAtEnd.id);
      const targets = ((grp && grp.members) || []).filter((u) => me && u !== me.username);
      for (const u of targets) {
        ws.send(JSON.stringify({ type: sigType, to: u, callContext: ctxAtEnd }));
      }
    } else if (ctxAtEnd && ctxAtEnd.id) {
      ws.send(JSON.stringify({ type: sigType, to: ctxAtEnd.id, callContext: ctxAtEnd }));
    }
  }
  stopRingTone();
  stopCallTimer();
  callConnectedAt = 0;

  if (postLog && ctxAtEnd && me) {
    emitCallLog(ctxAtEnd, initiatorAtEnd || me.username, elapsedSec, wasConnected);
  }

  if (speakRaf) { cancelAnimationFrame(speakRaf); speakRaf = null; }
  inCall = false;
  isRingingOutgoing = false;
  callContext = null;
  callInitiator = null;
  localPreviewVisible = false;

  for (const u of [...peerConnections.keys()]) {
    cleanupPeerConnection(u);
  }

  [rawMicStream, micStream, camStream, scrStream].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
  rawMicStream = null; micStream = null; camStream = null; scrStream = null;
  micAnalyser = null;
  if (micAudioCtx) { try { micAudioCtx.close(); } catch {} micAudioCtx = null; micGainNode = null; }

  document.getElementById('callStage').classList.add('hidden');
  if (activeChat) document.getElementById('startCallBtn').classList.remove('hidden');

  const lv = document.getElementById('localVideo');
  lv.srcObject = null; lv.classList.add('hidden');
  document.getElementById('localFsBtn').classList.add('hidden');
  document.getElementById('localStreamNotice').classList.add('hidden');
  document.getElementById('localAv').classList.remove('hidden');
  document.getElementById('localTile').classList.remove('streaming', 'speaking', 'screen-mode');
  document.getElementById('meAv').classList.remove('speaking-ring');
  updateCallButtons();
}

function getActiveOutgoingVideoTrack() {
  if (scrStream) {
    const st = scrStream.getVideoTracks()[0];
    if (st && st.readyState === 'live') return { track: st, stream: scrStream };
  }
  if (camStream) {
    const ct = camStream.getVideoTracks()[0];
    if (ct && ct.readyState === 'live') return { track: ct, stream: camStream };
  }
  return { track: null, stream: null };
}

function ensurePC(peerUser) {
  if (peerConnections.has(peerUser)) return peerConnections.get(peerUser);
  ensureRemoteTile(peerUser);

  const c = new RTCPeerConnection(RTC);
  // Не теряем повторную renegotiation, если предыдущий SDP ещё согласуется.
  c.__offerPending = false;
  c.__makingOffer = false;
  c.onsignalingstatechange = () => {
    if (c.signalingState === 'stable' && c.__offerPending && !c.__makingOffer) {
      c.__offerPending = false;
      sendOfferTo(peerUser);
    }
  };
  if (micStream) {
    micStream.getTracks().forEach((t) => c.addTrack(t, micStream));
  }
  const activeVid = getActiveOutgoingVideoTrack();
  if (activeVid.track) {
    c.addTrack(activeVid.track, activeVid.stream || new MediaStream([activeVid.track]));
  }

  c.onicecandidate = (e) => {
    if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'signal', to: peerUser, callContext, signal: { candidate: e.candidate } }));
    }
  };

  c.ontrack = (e) => {
    const stream = e.streams[0] || remoteStreams.get(peerUser) || new MediaStream();
    if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
    remoteStreams.set(peerUser, stream);

    if (e.track.kind === 'audio') {
      let aud = remoteAudios.get(peerUser);
      if (!aud) {
        aud = document.createElement('audio');
        aud.autoplay = true;
        aud.playsInline = true;
        document.body.appendChild(aud);
        remoteAudios.set(peerUser, aud);
      }
      aud.srcObject = stream;
      applyOutputDeviceToAll();
      applyRemotePeerAudioSettings(peerUser);
    } else if (e.track.kind === 'video') {
      ensureRemoteTile(peerUser);
      const rv = document.getElementById('remoteVideo_' + peerUser);
      const fsBtn = document.getElementById('remoteFsBtn_' + peerUser);
      const rAv = document.getElementById('remoteAv_' + peerUser);
      const rTile = document.getElementById('remoteTile_' + peerUser);
      if (rv) {
        rv.srcObject = stream;
        rv.classList.remove('hidden');
        const p = rv.play && rv.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
      if (fsBtn) fsBtn.classList.remove('hidden');
      if (rAv) rAv.classList.add('hidden');
      if (rTile) rTile.classList.add('streaming');
      applyRemotePeerAudioSettings(peerUser);

      e.track.onended = () => {
        if (rv) { rv.srcObject = null; rv.classList.add('hidden'); }
        if (fsBtn) fsBtn.classList.add('hidden');
        if (rAv) rAv.classList.remove('hidden');
        if (rTile) rTile.classList.remove('streaming');
      };
    }
  };

  peerConnections.set(peerUser, c);
  return c;
}

async function sendOfferTo(peerUser) {
  if (!peerUser || !ws || ws.readyState !== WebSocket.OPEN) return;
  const c = ensurePC(peerUser);
  if (c.signalingState !== 'stable' || c.__makingOffer) {
    c.__offerPending = true;
    return;
  }

  c.__makingOffer = true;
  try {
    const offer = await c.createOffer();
    // Состояние могло измениться, пока браузер создавал SDP.
    if (c.signalingState !== 'stable') {
      c.__offerPending = true;
      return;
    }
    await c.setLocalDescription(offer);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'signal', to: peerUser, callContext, signal: { sdp: c.localDescription } }));
    }
  } catch {
    c.__offerPending = true;
  } finally {
    c.__makingOffer = false;
    if (c.signalingState === 'stable' && c.__offerPending) {
      c.__offerPending = false;
      queueMicrotask(() => sendOfferTo(peerUser));
    }
  }
}

async function handleSignal(signal, fromUser, sigCtx) {
  if (!signal || !fromUser || isUserBlocked(fromUser)) return;
  isRingingOutgoing = false;
  stopRingTone();
  if (!inCall) {
    callContext = sigCtx || { kind: 'dm', id: fromUser };
    if (!callInitiator) callInitiator = fromUser;
    await openCallUI(false, [fromUser]);
  }
  if (!callConnectedAt) startCallTimer();
  const c = ensurePC(fromUser);
  if (signal.sdp) {
    try {
      await c.setRemoteDescription(signal.sdp);
      if (signal.sdp.type === 'offer') {
        const ans = await c.createAnswer();
        await c.setLocalDescription(ans);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'signal', to: fromUser, callContext, signal: { sdp: c.localDescription } }));
        }
      }
    } catch {}
  } else if (signal.candidate) {
    try { await c.addIceCandidate(signal.candidate); } catch {}
  }
}

function updateCallButtons() {
  document.getElementById('cMic').classList.toggle('off', micMuted);
  document.getElementById('cDeaf').classList.toggle('off', deafened);
  document.getElementById('cCam').classList.toggle('on', !!camStream);
  document.getElementById('cScr').classList.toggle('on', !!scrStream);
  document.getElementById('localTile').classList.toggle('streaming', !!(scrStream || camStream));
}

function applyMicMuteState() {
  if (micStream) micStream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; });
  if (rawMicStream) rawMicStream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; });
}

function toggleMic() {
  micMuted = !micMuted;
  playDiscordSfx(micMuted ? 'mute' : 'unmute');
  if (!micMuted && deafened) {
    deafened = false;
    peerConnections.forEach((_, u) => applyRemotePeerAudioSettings(u));
  }
  applyMicMuteState();
  updateCallButtons();
}

function toggleDeaf() {
  deafened = !deafened;
  playDiscordSfx(deafened ? 'deaf' : 'undeaf');
  if (deafened) { micMutedBeforeDeaf = micMuted; micMuted = true; }
  else { micMuted = micMutedBeforeDeaf; }
  peerConnections.forEach((_, u) => applyRemotePeerAudioSettings(u));
  applyMicMuteState();
  updateCallButtons();
}

function toggleFullscreenTarget(el) {
  if (!el) return;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  if (typeof req === 'function') {
    req.call(el).catch(() => {
      const parentTile = el.closest ? el.closest('.tile') : null;
      if (parentTile && parentTile !== el && typeof parentTile.requestFullscreen === 'function') {
        parentTile.requestFullscreen().catch(() => {});
      }
    });
  }
}

function toggleFullscreenVideo(videoId) {
  const vid = document.getElementById(videoId);
  if (!vid || vid.classList.contains('hidden')) return;
  toggleFullscreenTarget(vid);
}

function updateLocalStageUI() {
  const lv = document.getElementById('localVideo');
  const fsBtn = document.getElementById('localFsBtn');
  const notice = document.getElementById('localStreamNotice');
  const av = document.getElementById('localAv');
  const prevBtn = document.getElementById('togglePreviewBtn');
  const tile = document.getElementById('localTile');

  if (tile) tile.classList.toggle('screen-mode', !!scrStream);

  if (scrStream) {
    av.classList.add('hidden');
    if (localPreviewVisible && !document.hidden) {
      notice.classList.add('hidden');
      lv.srcObject = scrStream;
      lv.classList.remove('hidden');
      const p = lv.play && lv.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      if (fsBtn) {
        fsBtn.textContent = 'На весь экран';
        fsBtn.classList.remove('hidden');
      }
      if (prevBtn) prevBtn.textContent = 'Скрыть превью';
    } else {
      lv.pause();
      lv.srcObject = null;
      lv.classList.add('hidden');
      if (fsBtn) fsBtn.classList.add('hidden');
      notice.classList.remove('hidden');
      if (prevBtn) prevBtn.textContent = 'Показать превью';
    }
    return;
  }

  if (notice) notice.classList.add('hidden');

  if (camStream) {
    av.classList.add('hidden');
    lv.srcObject = camStream;
    lv.classList.remove('hidden');
    const p = lv.play && lv.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    if (fsBtn) {
      fsBtn.textContent = 'Вебка на весь экран';
      fsBtn.classList.remove('hidden');
    }
  } else {
    lv.srcObject = null;
    lv.classList.add('hidden');
    if (fsBtn) fsBtn.classList.add('hidden');
    av.classList.remove('hidden');
  }
}

function toggleLocalStreamPreview() {
  localPreviewVisible = !localPreviewVisible;
  updateLocalStageUI();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopBgLoop();
    if (speakRaf) { cancelAnimationFrame(speakRaf); speakRaf = null; }
    if (testRaf) { cancelAnimationFrame(testRaf); testRaf = null; }
    if (scrStream && localPreviewVisible) {
      localPreviewVisible = false;
      updateLocalStageUI();
    }
  } else {
    if (bgEffect !== 'none') rebuildBgParticles();
    if (inCall) startSpeakingLoop();
    if (testStream && !testRaf) toggleMicTest();
  }
});

async function syncVideoTrackToAllPeers(trackOrNull, sourceStream) {
  for (const [u, c] of peerConnections.entries()) {
    const senders = c.getSenders().filter((s) => s.track && s.track.kind === 'video');
    let changed = false;
    if (trackOrNull) {
      if (senders.length > 0) {
        if (senders[0].track !== trackOrNull) {
          await senders[0].replaceTrack(trackOrNull);
          changed = true;
        }
      } else {
        c.addTrack(trackOrNull, sourceStream || new MediaStream([trackOrNull]));
        changed = true;
      }
    } else if (senders.length > 0) {
      for (const s of senders) {
        try { c.removeTrack(s); changed = true; } catch {}
      }
    }
    if (changed) {
      await sendOfferTo(u);
    }
  }
}

async function toggleCam() {
  if (!inCall) return;

  if (!camStream) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Доступ к веб-камере недоступен в этом браузере.');
      return;
    }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false
      });
    } catch {
      alert('Не удалось включить вебку: проверь разрешение камеры в браузере.');
      return;
    }

    const vTrack = camStream.getVideoTracks()[0];
    if (vTrack) {
      vTrack.onended = () => {
        if (camStream) toggleCam();
      };
    }

    updateLocalStageUI();
    updateCallButtons();

    if (!scrStream && vTrack) {
      await syncVideoTrackToAllPeers(vTrack, camStream);
    }
  } else {
    const activeCam = camStream;
    camStream = null;
    activeCam.getTracks().forEach((t) => t.stop());
    updateLocalStageUI();
    updateCallButtons();

    if (!scrStream) {
      await syncVideoTrackToAllPeers(null, null);
    }
  }
}

async function toggleScreen() {
  if (!inCall) return;

  if (!scrStream) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      alert('Демонстрация экрана недоступна. Открой сайт по HTTPS или на localhost.');
      return;
    }

    let captured;
    try {
      captured = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: false
      });
    } catch (err) {
      if (err && err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
        alert('Ошибка демонстрации экрана: ' + (err.message || err.name || 'неизвестная ошибка'));
      }
      return;
    }

    scrStream = captured;
    localPreviewVisible = true;
    const sTrack = scrStream.getVideoTracks()[0];
    if (sTrack) {
      sTrack.onended = () => {
        if (scrStream) toggleScreen();
      };
    }

    updateLocalStageUI();
    updateCallButtons();
    await syncVideoTrackToAllPeers(sTrack || null, scrStream);
  } else {
    const activeScr = scrStream;
    scrStream = null;
    localPreviewVisible = false;
    activeScr.getTracks().forEach((t) => t.stop());

    const fallbackCamTrack = camStream && camStream.getVideoTracks()[0] ? camStream.getVideoTracks()[0] : null;
    updateLocalStageUI();
    updateCallButtons();
    await syncVideoTrackToAllPeers(fallbackCamTrack, camStream);
  }
}

checkSession();