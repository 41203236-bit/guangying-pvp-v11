import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getDatabase, ref, onValue, get, update } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const params = new URLSearchParams(location.search);
const roomCode = params.get('room');
const myRole = params.get('role');
const roomRef = ref(db, `rooms/${roomCode}`);

if(!roomCode || !myRole){ location.href = './index.html'; }

const boardEl = document.getElementById('board');
for(let i=0;i<9;i++){
  const d=document.createElement('div'); d.className='cell'; d.id=`c-${i}`; d.addEventListener('click', ()=>tap(i)); boardEl.appendChild(d);
}

document.getElementById('roomCode').textContent = roomCode || '-';

let roomCache = null;
let state = null;
let countdownInterval = null;

function clone(obj){ return JSON.parse(JSON.stringify(obj)); }
function wins(){ return [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]; }
function checkWin(grid){ return wins().some(l => grid[l[0]] && grid[l[0]]===grid[l[1]] && grid[l[1]]===grid[l[2]]); }
function isGameOver(s){ return s.data.O.hp <= 0 || s.data.X.hp <= 0; }
function applyPerspective(){
  const panelO = document.getElementById('panel-O'); const panelX = document.getElementById('panel-X');
  const badgeO = document.getElementById('badge-O'); const badgeX = document.getElementById('badge-X');
  const boardWrap = document.getElementById('board-wrap'); const skillWrap = document.getElementById('skill-footer-wrap');
  panelO.classList.remove('my-side','enemy-side'); panelX.classList.remove('my-side','enemy-side'); badgeO.classList.remove('me','enemy'); badgeX.classList.remove('me','enemy'); boardWrap.classList.remove('interaction-locked'); skillWrap.classList.remove('interaction-locked');
  if(myRole==='O'){ panelO.classList.add('my-side'); panelX.classList.add('enemy-side'); badgeO.classList.add('me'); badgeX.classList.add('enemy'); badgeO.textContent='你 · 光 / O'; badgeX.textContent='對手 · 影 / X'; }
  else { panelX.classList.add('my-side'); panelO.classList.add('enemy-side'); badgeX.classList.add('me'); badgeO.classList.add('enemy'); badgeX.textContent='你 · 影 / X'; badgeO.textContent='對手 · 光 / O'; }
  if(state?.turn !== myRole && !isGameOver(state)){ boardWrap.classList.add('interaction-locked'); skillWrap.classList.add('interaction-locked'); }
}
function render(){
  if(!state) return;
  document.getElementById('overlayWait').style.display = roomCache?.phase === 'playing' ? 'none' : 'flex';
  document.getElementById('overlayMsg').textContent = roomCache?.phase === 'countdown' ? '倒數中…' : '等待戰鬥狀態…';
  document.getElementById('turnText').textContent = state.turn === myRole ? '現在輪到你操作' : `現在輪到${state.turn==='O'?'光 / O':'影 / X'}`;
  document.getElementById('timer-container').textContent = state.timeLeft ?? '--';
  ['O','X'].forEach(p => {
    const hp = state.data[p].hp; const fillEl = document.getElementById(`hp-fill-${p}`); const valEl = document.getElementById(`hp-val-${p}`);
    fillEl.style.clipPath = `inset(${100 - hp}% 0 0 0)`; valEl.innerText = Math.floor(hp) + '%'; valEl.style.top = `calc(${100 - hp}% + 10px)`;
    if(state.data[p].defending) fillEl.classList.add('defending-bar'); else fillEl.classList.remove('defending-bar');
    document.getElementById(`panel-${p}`).className = 'side-panel' + (state.turn===p ? ' active-side-'+p : '');
    let spHTML=''; for(let i=0;i<5;i++) spHTML += `<div class="sp-dot ${i < state.data[p].sp ? 'sp-on' : 'sp-off'}"></div>`; document.getElementById(`sp-display-${p}`).innerHTML=spHTML;
  });
  for(let i=0;i<9;i++){ const el=document.getElementById(`c-${i}`); el.innerText = state.grid[i] || ''; el.className='cell ' + (state.grid[i] || ''); }
  let skills = [{t:'atk', c:1}, {t:'def', c:2}, {t:'hel', c:2}, {t:'stn', c:3}];
  document.getElementById('skill-list-container').innerHTML = skills.map(s=>{
    const can = state.turn===myRole && state.data[myRole].sp >= s.c && state.data[myRole].skillUsed < 3 && !isGameOver(state);
    return `<button class="s-btn btn-${s.t} ${can ? 'active' : ''}" data-skill="${s.t}"></button>`;
  }).join('');
  document.querySelectorAll('[data-skill]').forEach(btn => btn.addEventListener('click', ()=>useSkill(btn.dataset.skill)));
  applyPerspective();
}
function swapTurnLocal(s){ s.data[s.turn].skillUsed = 0; s.turn = s.turn === 'O' ? 'X' : 'O'; s.data[s.turn].defending = false; if(s.data[s.turn].stunned){ s.data[s.turn].stunned = false; s.data[s.turn].skillUsed = 0; s.turn = s.turn === 'O' ? 'X' : 'O'; } return s; }
function resetGridLocal(s){ s.grid = Array(9).fill(null); s.queues = { O: [], X: [] }; return swapTurnLocal(s); }
async function pushState(newState){ await update(roomRef, { state: newState }); }
async function tap(i){
  if(!state || roomCache?.phase !== 'playing' || state.turn !== myRole || state.grid[i] || isGameOver(state)) return;
  const s = clone(state);
  if(s.queues[s.turn].length >= 3){ const old = s.queues[s.turn].shift(); s.grid[old] = null; }
  s.grid[i] = s.turn; s.queues[s.turn].push(i);
  if(checkWin(s.grid)){ s.data[s.turn].sp = Math.min(5, s.data[s.turn].sp + 1); resetGridLocal(s); }
  else swapTurnLocal(s);
  await pushState(s);
}
async function useSkill(type){
  if(!state || roomCache?.phase !== 'playing' || state.turn !== myRole || isGameOver(state)) return;
  const s = clone(state); const p = s.turn; const target = p === 'O' ? 'X' : 'O'; if(s.data[p].skillUsed >= 3) return;
  const cost = type==='atk' ? 1 : type==='stn' ? 3 : 2; if(s.data[p].sp < cost) return;
  s.data[p].sp -= cost; s.data[p].skillUsed++;
  if(type==='atk'){ let dmg = 10; if(s.data[target].defending){ dmg = 5; s.data[target].defending = false; } s.data[target].hp = Math.max(0, s.data[target].hp - dmg); }
  else if(type==='def'){ s.data[p].defending = true; }
  else if(type==='hel'){ s.data[p].hp = Math.min(100, s.data[p].hp + 6); }
  else if(type==='stn'){ s.data[target].stunned = true; }
  if(isGameOver(s)){ await update(roomRef, { state: s, phase:'ended', winner: p }); return; }
  await pushState(s);
}
function startCountdown(startAt){
  clearInterval(countdownInterval);
  countdownInterval = setInterval(()=>{
    const remain = Math.max(0, Math.ceil((startAt - Date.now())/1000));
    document.getElementById('overlayMsg').textContent = remain <= 0 ? '開始！' : `倒數 ${remain}`;
    if(remain <= 0) clearInterval(countdownInterval);
  }, 150);
}
onValue(roomRef, snap => {
  const room = snap.val();
  if(!room){ location.href = './index.html'; return; }
  roomCache = room;
  state = room.state || state;
  if(room.phase === 'countdown' && room.startAt) startCountdown(room.startAt);
  if(room.phase === 'ended'){
    document.getElementById('overlayWait').style.display = 'flex';
    document.getElementById('overlayMsg').textContent = room.winner === myRole ? '你獲勝了' : '戰鬥結束';
  }
  render();
});
