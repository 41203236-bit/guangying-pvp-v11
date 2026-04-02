import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getDatabase, ref, onValue, update } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const params = new URLSearchParams(location.search);
const roomCode = (params.get('room') || '').trim();
const myRole = ((params.get('role') || '').trim().toUpperCase() === 'X') ? 'X' : 'O';
const roomRef = ref(db, `rooms/${roomCode}`);

if(!roomCode){ location.href = './index.html'; }

const boardEl = document.getElementById('board');
for(let i=0;i<9;i++){
  const d = document.createElement('div');
  d.className = 'cell';
  d.id = `c-${i}`;
  d.addEventListener('click', ()=>tap(i));
  boardEl.appendChild(d);
}

document.getElementById('roomCode').textContent = roomCode || '-';

let roomCache = null;
let state = null;
let countdownInterval = null;
let turnTimerInterval = null;
let lastNormalizedJSON = '';

function clone(obj){ return JSON.parse(JSON.stringify(obj)); }
function wins(){ return [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]; }
function checkWin(grid){ return wins().some(l => grid[l[0]] && grid[l[0]]===grid[l[1]] && grid[l[1]]===grid[l[2]]); }
function basePlayer(){ return { hp:100, sp:0, skillUsed:0, stunned:false, defending:false }; }
function nextTurnEndsAt(){ return Date.now() + 30000; }
function defaultState(host='O'){
  return {
    turn: host === 'X' ? 'X' : 'O',
    grid: Array(9).fill(null),
    queues: { O: [], X: [] },
    data: { O: basePlayer(), X: basePlayer() },
    timeLeft: 30,
    turnEndsAt: nextTurnEndsAt()
  };
}
function normalizeState(raw, host='O'){
  const d = defaultState(host);
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    turn: s.turn === 'O' || s.turn === 'X' ? s.turn : d.turn,
    grid: Array.isArray(s.grid) && s.grid.length === 9 ? s.grid.map(v => (v === 'O' || v === 'X') ? v : null) : d.grid,
    queues: {
      O: Array.isArray(s.queues?.O) ? s.queues.O.filter(n => Number.isInteger(n) && n >= 0 && n < 9) : [],
      X: Array.isArray(s.queues?.X) ? s.queues.X.filter(n => Number.isInteger(n) && n >= 0 && n < 9) : []
    },
    data: {
      O: { ...d.data.O, ...(s.data?.O || {}) },
      X: { ...d.data.X, ...(s.data?.X || {}) }
    },
    timeLeft: Number.isFinite(s.timeLeft) ? s.timeLeft : 30,
    turnEndsAt: Number.isFinite(s.turnEndsAt) ? s.turnEndsAt : nextTurnEndsAt()
  };
}
function isGameOver(s){ return (s?.data?.O?.hp ?? 100) <= 0 || (s?.data?.X?.hp ?? 100) <= 0; }

function displayMark(v){ return v === "O" ? "◯" : v === "X" ? "✕" : ""; }
function updateTimerDisplay(){
  if(!state) return;
  const phase = roomCache?.phase || 'playing';
  if(phase !== 'playing'){
    updateTimerDisplay();
    return;
  }
  const remain = Math.max(0, Math.ceil(((state.turnEndsAt || nextTurnEndsAt()) - Date.now()) / 1000));
  document.getElementById('timer-container').textContent = String(remain);
}
function startTurnTimer(){
  clearInterval(turnTimerInterval);
  updateTimerDisplay();
  turnTimerInterval = setInterval(async ()=>{
    if(!state || (roomCache?.phase || 'playing') !== 'playing') return;
    const remain = Math.max(0, Math.ceil(((state.turnEndsAt || nextTurnEndsAt()) - Date.now()) / 1000));
    document.getElementById('timer-container').textContent = String(remain);
    if(remain <= 0 && myRole === roomCache?.host && !isGameOver(state)){
      const s = clone(state);
      s.turnEndsAt = nextTurnEndsAt();
      swapTurnLocal(s);
      state = s;
      render();
      try { await pushState(s); } catch {}
    }
  }, 250);
}

function setOverlay(msg){
  const overlay = document.getElementById('overlayWait');
  const msgEl = document.getElementById('overlayMsg');
  overlay.style.display = 'flex';
  msgEl.textContent = msg;
}
function hideOverlay(){ document.getElementById('overlayWait').style.display = 'none'; }
function setBoardLock(canAct, msg){
  const boardWrap = document.getElementById('board-wrap');
  const skillWrap = document.getElementById('skill-footer-wrap');
  const boardMask = document.getElementById('board-lock-mask');
  const skillMask = document.getElementById('skill-lock-mask');
  if(canAct){
    boardWrap.classList.remove('interaction-locked');
    skillWrap.classList.remove('interaction-locked');
    boardEl.style.pointerEvents = 'auto';
    document.getElementById('skill-list-container').style.pointerEvents = 'auto';
    boardMask.textContent = '';
    skillMask.textContent = '';
  } else {
    boardWrap.classList.add('interaction-locked');
    skillWrap.classList.add('interaction-locked');
    boardEl.style.pointerEvents = 'none';
    document.getElementById('skill-list-container').style.pointerEvents = 'none';
    boardMask.textContent = msg || '等待對手回合';
    skillMask.textContent = msg || '不是你的操作階段';
  }
}
function applyPerspective(){
  const panelO = document.getElementById('panel-O');
  const panelX = document.getElementById('panel-X');
  const badgeO = document.getElementById('badge-O');
  const badgeX = document.getElementById('badge-X');
  panelO.classList.remove('my-side','enemy-side','active-side-O','active-side-X');
  panelX.classList.remove('my-side','enemy-side','active-side-O','active-side-X');
  badgeO.classList.remove('me','enemy');
  badgeX.classList.remove('me','enemy');
  if(myRole==='O'){
    panelO.classList.add('my-side'); panelX.classList.add('enemy-side');
    badgeO.classList.add('me'); badgeX.classList.add('enemy');
    badgeO.textContent='你 · 光 / O'; badgeX.textContent='對手 · 影 / X';
  } else {
    panelX.classList.add('my-side'); panelO.classList.add('enemy-side');
    badgeX.classList.add('me'); badgeO.classList.add('enemy');
    badgeX.textContent='你 · 影 / X'; badgeO.textContent='對手 · 光 / O';
  }
  if(state?.turn === 'O') panelO.classList.add('active-side-O');
  if(state?.turn === 'X') panelX.classList.add('active-side-X');
}
function renderSkills(){
  const skills = [
    {t:'atk', c:1, label:'攻擊'},
    {t:'def', c:2, label:'防禦'},
    {t:'hel', c:2, label:'回血'},
    {t:'stn', c:3, label:'暈眩'}
  ];
  const myData = state?.data?.[myRole] || basePlayer();
  const phase = roomCache?.phase;
  const canAct = phase === 'playing' && state?.turn === myRole && !isGameOver(state);
  document.getElementById('skill-list-container').innerHTML = skills.map(s=>{
    const can = canAct && myData.sp >= s.c && myData.skillUsed < 3;
    return `<button class="s-btn btn-${s.t} ${can ? 'active' : ''}" data-skill="${s.t}" title="${s.label}"></button>`;
  }).join('');
  document.querySelectorAll('[data-skill]').forEach(btn => btn.addEventListener('click', ()=>useSkill(btn.dataset.skill)));
}
function render(){
  if(!state) return;
  const phase = roomCache?.phase || 'playing';

  if(phase === 'playing') hideOverlay();
  else if(phase === 'countdown') setOverlay(document.getElementById('overlayMsg').textContent || '倒數中…');
  else if(phase === 'ended') setOverlay(roomCache?.winner === myRole ? '你獲勝了' : '戰鬥結束');
  else setOverlay('等待戰鬥狀態…');

  document.getElementById('turnText').textContent = phase === 'playing'
    ? (state.turn === myRole ? '現在輪到你操作' : `現在輪到${state.turn==='O'?'光 / O':'影 / X'}`)
    : '等待戰鬥開始';
  updateTimerDisplay();

  ['O','X'].forEach(p => {
    const hp = Math.max(0, Math.min(100, Number(state.data?.[p]?.hp ?? 100)));
    const fillEl = document.getElementById(`hp-fill-${p}`);
    const valEl = document.getElementById(`hp-val-${p}`);
    fillEl.style.clipPath = `inset(${100 - hp}% 0 0 0)`;
    valEl.innerText = Math.floor(hp) + '%';
    valEl.style.top = `calc(${100 - hp}% + 10px)`;
    if(state.data?.[p]?.defending) fillEl.classList.add('defending-bar'); else fillEl.classList.remove('defending-bar');
    let spHTML = '';
    const sp = Math.max(0, Math.min(5, Number(state.data?.[p]?.sp ?? 0)));
    for(let i=0;i<5;i++) spHTML += `<div class="sp-dot ${i < sp ? 'sp-on' : 'sp-off'}"></div>`;
    document.getElementById(`sp-display-${p}`).innerHTML = spHTML;
  });

  for(let i=0;i<9;i++){
    const el = document.getElementById(`c-${i}`);
    const v = state.grid?.[i] || '';
    el.innerText = displayMark(v);
    el.className = 'cell ' + v;
  }

  renderSkills();
  applyPerspective();

  const canAct = phase === 'playing' && state.turn === myRole && !isGameOver(state);
  const lockMsg = phase !== 'playing'
    ? '等待戰鬥開始'
    : isGameOver(state)
      ? '戰鬥已結束'
      : state.turn !== myRole
        ? '等待對手回合'
        : '';
  setBoardLock(canAct, lockMsg);
}
function swapTurnLocal(s){
  s.data[s.turn].skillUsed = 0;
  s.turn = s.turn === 'O' ? 'X' : 'O';
  s.data[s.turn].defending = false;
  if(s.data[s.turn].stunned){
    s.data[s.turn].stunned = false;
    s.data[s.turn].skillUsed = 0;
    s.turn = s.turn === 'O' ? 'X' : 'O';
  }
  s.turnEndsAt = nextTurnEndsAt();
  return s;
}
function resetGridLocal(s){ s.grid = Array(9).fill(null); s.queues = { O: [], X: [] }; return swapTurnLocal(s); }
async function pushState(newState){ await update(roomRef, { state: newState }); }
async function tap(i){
  if(!state) return;
  if((roomCache?.phase || 'playing') !== 'playing') return;
  if(state.turn !== myRole) return;
  if(state.grid[i]) return;
  if(isGameOver(state)) return;
  const s = clone(state);
  if(s.queues[s.turn].length >= 3){ const old = s.queues[s.turn].shift(); s.grid[old] = null; }
  s.grid[i] = s.turn; s.queues[s.turn].push(i);
  if(checkWin(s.grid)){ s.data[s.turn].sp = Math.min(5, s.data[s.turn].sp + 1); resetGridLocal(s); }
  else swapTurnLocal(s);
  state = s;
  render();
  try { await pushState(s); } catch {}
}
async function useSkill(type){
  if(!state) return;
  if((roomCache?.phase || 'playing') !== 'playing') return;
  if(state.turn !== myRole) return;
  if(isGameOver(state)) return;
  const s = clone(state); const p = s.turn; const target = p === 'O' ? 'X' : 'O';
  if(s.data[p].skillUsed >= 3) return;
  const cost = type==='atk' ? 1 : type==='stn' ? 3 : 2; if(s.data[p].sp < cost) return;
  s.data[p].sp -= cost; s.data[p].skillUsed++;
  if(type==='atk'){ let dmg = 10; if(s.data[target].defending){ dmg = 5; s.data[target].defending = false; } s.data[target].hp = Math.max(0, s.data[target].hp - dmg); }
  else if(type==='def'){ s.data[p].defending = true; }
  else if(type==='hel'){ s.data[p].hp = Math.min(100, s.data[p].hp + 6); }
  else if(type==='stn'){ s.data[target].stunned = true; }
  if(isGameOver(s)){ state = s; render(); try { await update(roomRef, { state: s, phase:'ended', winner: p }); } catch {} return; }
  state = s;
  render();
  try { await pushState(s); } catch {}
}
function startCountdown(startAt){
  clearInterval(countdownInterval);
  countdownInterval = setInterval(()=>{
    const remain = Math.max(0, Math.ceil((startAt - Date.now())/1000));
    document.getElementById('overlayMsg').textContent = remain <= 0 ? '開始！' : `倒數 ${remain}`;
    if(remain <= 0) clearInterval(countdownInterval);
  }, 150);
}

onValue(roomRef, async snap => {
  const room = snap.val();
  if(!room){ location.href = './index.html'; return; }
  roomCache = room;

  const normalized = normalizeState(room.state, room.host || 'O');
  state = normalized;

  const normalizedJSON = JSON.stringify(normalized);
  if(normalizedJSON !== JSON.stringify(room.state || {}) && normalizedJSON !== lastNormalizedJSON){
    lastNormalizedJSON = normalizedJSON;
    try { await update(roomRef, { state: normalized }); } catch {}
  }

  if(room.phase === 'countdown' && room.startAt) {
    startCountdown(room.startAt);
  }

  if(!room.phase) roomCache.phase = 'playing';
  if((roomCache.phase || 'playing') === 'playing'){
    startTurnTimer();
  } else {
    clearInterval(turnTimerInterval);
  }
  render();
});
