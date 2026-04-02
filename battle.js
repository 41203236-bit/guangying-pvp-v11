import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getDatabase, ref, onValue, update } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

// --- 初始化 Firebase ---
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const params = new URLSearchParams(location.search);
const roomCode = params.get('room');
const myRole = params.get('role'); // 'O' 或 'X'
const roomRef = ref(db, `rooms/${roomCode}`);

// 安全檢查：如果沒房號或沒身份，退回首頁
if (!roomCode || !myRole) { 
    alert("房間資訊錯誤，請重新加入");
    location.href = './index.html'; 
}

// --- 全域變數 ---
let roomCache = null;
let state = null;
let timerInterval = null; // 用於房主跑計時邏輯

// --- 初始化 DOM ---
const boardEl = document.getElementById('board');
for (let i = 0; i < 9; i++) {
    const d = document.createElement('div');
    d.className = 'cell';
    d.id = `c-${i}`;
    d.addEventListener('click', () => tap(i));
    boardEl.appendChild(d);
}
document.getElementById('roomCode').textContent = roomCode;

// --- 工具函數 ---
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
function wins() { return [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]; }
function checkWin(grid) { return wins().some(l => grid[l[0]] && grid[l[0]] === grid[l[1]] && grid[l[1]] === grid[l[2]]); }

function basePlayer() { 
    return { hp: 100, sp: 0, skillUsed: 0, stunned: false, defending: false }; 
}

// 確保資料結構完整，防止因為缺少欄位導致報錯
function normalizeState(raw) {
    const d = {
        turn: 'O',
        grid: Array(9).fill(null),
        queues: { O: [], X: [] },
        data: { O: basePlayer(), X: basePlayer() },
        timeLeft: 30
    };
    if (!raw) return d;
    return {
        turn: raw.turn || d.turn,
        grid: Array.isArray(raw.grid) ? raw.grid : d.grid,
        queues: {
            O: Array.isArray(raw.queues?.O) ? raw.queues.O : [],
            X: Array.isArray(raw.queues?.X) ? raw.queues.X : []
        },
        data: {
            O: { ...d.data.O, ...raw.data?.O },
            X: { ...d.data.X, ...raw.data?.X }
        },
        timeLeft: typeof raw.timeLeft === 'number' ? raw.timeLeft : 30
    };
}

// --- 渲染 UI ---
function render() {
    if (!state || !roomCache) return;

    const phase = roomCache.phase;
    const isMyTurn = state.turn === myRole;
    const isGameOver = state.data.O.hp <= 0 || state.data.X.hp <= 0;

    // 1. 控制 Overlay 遮罩
    const overlay = document.getElementById('overlayWait');
    if (phase === 'playing') {
        overlay.style.display = 'none';
    } else {
        overlay.style.display = 'flex';
        document.getElementById('overlayMsg').textContent = phase === 'ended' ? '遊戲結束' : '準備中...';
    }

    // 2. 控制互動鎖定 (遮罩)
    const boardWrap = document.getElementById('board-wrap');
    const skillWrap = document.getElementById('skill-footer-wrap');
    const mask = document.getElementById('board-lock-mask');

    if (phase !== 'playing' || !isMyTurn || isGameOver) {
        boardWrap.classList.add('interaction-locked');
        skillWrap.classList.add('interaction-locked');
        mask.style.display = 'flex';
        mask.textContent = isGameOver ? "戰鬥結束" : "等待對手操作...";
    } else {
        boardWrap.classList.remove('interaction-locked');
        skillWrap.classList.remove('interaction-locked');
        mask.style.display = 'none';
    }

    // 3. 更新計時器與回合文字
    document.getElementById('timer-container').textContent = state.timeLeft;
    document.getElementById('turnText').textContent = isMyTurn ? '★ 你的回合' : `等待 ${state.turn} 回合`;

    // 4. 更新血條與 SP (點點)
    ['O', 'X'].forEach(p => {
        const d = state.data[p];
        document.getElementById(`hp-val-${p}`).innerText = d.hp + '%';
        document.getElementById(`hp-fill-${p}`).style.clipPath = `inset(${100 - d.hp}% 0 0 0)`;
        
        let spHTML = '';
        for (let i = 0; i < 5; i++) spHTML += `<div class="sp-dot ${i < d.sp ? 'sp-on' : 'sp-off'}"></div>`;
        document.getElementById(`sp-display-${p}`).innerHTML = spHTML;
        
        // 頭像發光切換
        document.getElementById(`panel-${p}`).classList.toggle(`active-side-${p}`, state.turn === p);
    });

    // 5. 更新棋盤
    state.grid.forEach((val, i) => {
        const el = document.getElementById(`c-${i}`);
        el.innerText = val || '';
        el.className = 'cell ' + (val || '');
    });

    // 6. 重新渲染技能按鈕並綁定事件 (因為用 innerHTML 會洗掉舊事件)
    const skills = [
        { id: 'atk', cost: 1, name: '攻擊' },
        { id: 'def', cost: 2, name: '防禦' },
        { id: 'hel', cost: 2, name: '治療' },
        { id: 'stn', cost: 3, name: '擊暈' }
    ];
    
    const skillList = document.getElementById('skill-list-container');
    const myData = state.data[myRole];
    
    skillList.innerHTML = skills.map(s => {
        const canAfford = myData.sp >= s.cost && myData.skillUsed < 3;
        const activeClass = (phase === 'playing' && isMyTurn && canAfford) ? 'active' : '';
        return `<button class="s-btn btn-${s.id} ${activeClass}" data-skill="${s.id}"></button>`;
    }).join('');

    // 點擊技能事件
    document.querySelectorAll('[data-skill]').forEach(btn => {
        btn.onclick = () => useSkill(btn.dataset.skill);
    });
}

// --- 遊戲邏輯 ---
async function swapTurn(s) {
    s.data[s.turn].skillUsed = 0;
    s.turn = s.turn === 'O' ? 'X' : 'O';
    s.data[s.turn].defending = false;
    s.timeLeft = 30; // 重置時間
    if (s.data[s.turn].stunned) {
        s.data[s.turn].stunned = false;
        return swapTurn(s); // 被暈眩直接跳過
    }
    return s;
}

async function tap(i) {
    if (state.grid[i] || roomCache.phase !== 'playing' || state.turn !== myRole) return;
    
    const s = clone(state);
    // 三子移動邏輯 (舊的消失)
    if (s.queues[s.turn].length >= 3) {
        const oldIdx = s.queues[s.turn].shift();
        s.grid[oldIdx] = null;
    }
    s.grid[i] = s.turn;
    s.queues[s.turn].push(i);

    // 檢查連線
    if (checkWin(s.grid)) {
        s.data[s.turn].sp = Math.min(5, s.data[s.turn].sp + 1); // 獲勝加 SP
        s.grid = Array(9).fill(null);
        s.queues = { O: [], X: [] };
    }

    const nextS = await swapTurn(s);
    await update(roomRef, { state: nextS });
}

async function useSkill(type) {
    const s = clone(state);
    const p = myRole;
    const target = p === 'O' ? 'X' : 'O';
    const myData = s.data[p];
    const costs = { atk: 1, def: 2, hel: 2, stn: 3 };

    if (myData.sp < costs[type] || myData.skillUsed >= 3) return;

    myData.sp -= costs[type];
    myData.skillUsed++;

    if (type === 'atk') {
        const dmg = s.data[target].defending ? 5 : 12;
        s.data[target].hp = Math.max(0, s.data[target].hp - dmg);
        s.data[target].defending = false;
    } else if (type === 'def') {
        myData.defending = true;
    } else if (type === 'hel') {
        myData.hp = Math.min(100, myData.hp + 15);
    } else if (type === 'stn') {
        s.data[target].stunned = true;
    }

    if (s.data.O.hp <= 0 || s.data.X.hp <= 0) {
        await update(roomRef, { state: s, phase: 'ended', winner: p });
    } else {
        await update(roomRef, { state: s });
    }
}

// --- 房主心跳邏輯 (驅動計時器) ---
function startTimerLogic() {
    if (timerInterval) return;
    timerInterval = setInterval(async () => {
        // 只有房主 O 且遊戲進行中才倒數，避免兩邊一起扣秒導致跳號
        if (myRole === 'O' && roomCache?.phase === 'playing' && state && state.data.O.hp > 0 && state.data.X.hp > 0) {
            if (state.timeLeft > 0) {
                await update(roomRef, { "state/timeLeft": state.timeLeft - 1 });
            } else {
                // 時間到強制換人
                const s = clone(state);
                const nextS = await swapTurn(s);
                await update(roomRef, { state: nextS });
            }
        }
    }, 1000);
}

// --- 監聽 Firebase 資料更新 ---
onValue(roomRef, async (snap) => {
    const data = snap.val();
    if (!data) return;

    roomCache = data;
    state = normalizeState(data.state);

    // 關鍵修正：如果是房主且發現狀態還在 countdown，強制轉為 playing
    if (myRole === 'O' && data.phase === 'countdown') {
        await update(roomRef, { phase: 'playing' });
    }

    if (data.phase === 'playing') {
        startTimerLogic();
    }

    render();
});
