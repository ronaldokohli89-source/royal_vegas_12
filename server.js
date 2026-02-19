const { initializeApp } = require("firebase/app");
const { getDatabase, ref, update, get, child, set, runTransaction, push } = require("firebase/database");
const express = require('express');


// server.js - Update Section 1
const firebaseConfig = {
  apiKey: "AIzaSyAuaE-ZsqFLnYUrGNF2VaIeDdzrDA-mVyE",
  authDomain: "id-spin.firebaseapp.com",
  databaseURL: "https://id-spin-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "id-spin",
  storageBucket: "id-spin.firebasestorage.app",
  messagingSenderId: "968364255642",
  appId: "1:968364255642:web:216707fa28f7f351927223"
};

// --- INITIALIZE FIREBASE & DB ---
const app = initializeApp(firebaseConfig);
const db = getDatabase(app); // This defines 'db' so your functions can use it

// --- 2. GAME SETTINGS ---
const CYCLE_TIME = 180; // 3 Minutes
let timer = CYCLE_TIME;
let status = "BETTING"; 

console.log("✅ ROYAL VEGAS SERVER - CENTRALIZED SYNC STARTED");
console.log("-----------------------------------------------");

// --- 3. MAIN SERVER LOOP (Runs every 1 second) ---
setInterval(async () => {
    // A. Daily Reset Check (Modified for Midnight Reset)
    checkDailyReset();

    // B. Betting Phase
    if (status === "BETTING") {
        timer--;
        
        // Broadcast time to all clients (PC & Mobile)
        update(ref(db, 'game_state'), {
            time_left: timer,
            status: "BETTING"
        }).catch(e => console.error("Sync Error:", e));

        // C. Trigger Spin
        if (timer <= 0) {
            await runSpinSequence();
        }
    }
}, 1000);

// --- 4. SPIN LOGIC ---
async function runSpinSequence() {
    status = "SPINNING";
    console.log("\n\n🎰 STARTING SPIN SEQUENCE...");

    // A. DETERMINE RESULT (Check Admin Rigging)
    let finalResult = Math.floor(Math.random() * 12) + 1; // Default Random
    let finalMulti = 1;

    try {
        const snapshot = await get(child(ref(db), 'house_control'));
        if (snapshot.exists()) {
            const data = snapshot.val();
            
            if (data.number && data.number > 0) {
                finalResult = parseInt(data.number);
                console.log(`⚠️  ADMIN OVERRIDE APPLIED: #${finalResult}`);
            }
            if (data.multiplier && data.multiplier >= 1) {
                finalMulti = parseInt(data.multiplier);
                console.log(`⚠️  MULTIPLIER ACTIVE: ${finalMulti}x`);
            }
        }
    } catch (e) { console.error("Error reading house_control:", e); }

    // B. BROADCAST RESULT TO CLIENTS (STARTS ANIMATION INSTANTLY)
    update(ref(db, 'game_state'), {
        status: "SPINNING",
        result: finalResult,
        multiplier: finalMulti,
        time_left: 0
    });

    console.log("⏳ Wheel Spinning... Waiting 8 seconds before updating history/volume...");

    // ==============================================================
    // C. DELAYED LOGIC (Wait for 8s Animation to Finish)
    // ==============================================================
    setTimeout(async () => {
        
        // 1. SAVE HISTORY (QUEUE) - Happens when wheel stops
        console.log("📝 Updating History Queue...");
        const historyRef = ref(db, 'results_history');
        const newEntryRef = push(historyRef); 
        
        await set(newEntryRef, {
            result: finalResult,
            timestamp: Date.now()
        });

        // 2. CLEANUP HISTORY (Keep last 20)
        const snap = await get(historyRef);
        if (snap.exists() && snap.size > 20) { 
            // FIX: Convert to array and sort by TIMESTAMP (Time) instead of ID
            const historyList = [];
            snap.forEach(childSnap => {
                historyList.push({ key: childSnap.key, ...childSnap.val() });
            });

            // Sort: Oldest time first
            historyList.sort((a, b) => a.timestamp - b.timestamp);

            // Calculate how many to remove
            let toRemove = historyList.length - 20;

            // Remove the oldest ones
            for(let i=0; i<toRemove; i++) {
                console.log(`🗑️ Deleting old history: ${historyList[i].key}`);
                set(ref(db, `results_history/${historyList[i].key}`), null);
            }
        }

        // 2. CALCULATE GLOBAL VOLUME (SUBTRACT WINS)
        const betsSnap = await get(child(ref(db), 'current_round_bets'));
        let totalPayout = 0;

        if (betsSnap.exists()) {
            const allPlayers = betsSnap.val();
            Object.values(allPlayers).forEach(playerBets => {
                if (playerBets[finalResult]) {
                    const winAmount = (playerBets[finalResult] * 10 * finalMulti);
                    totalPayout += winAmount;
                }
            });
        }

        // UPDATE FIREBASE: SUBTRACT PAYOUTS FROM VOLUME
        if (totalPayout > 0) {
            console.log(`📊 PAYOUTS: -${totalPayout} (Subtracted from Global Volume)`);
            const volRef = ref(db, 'house_stats/daily_volume');
            
            await runTransaction(volRef, (currentVol) => {
                return (currentVol || 0) - totalPayout;
            });
        } else {
            console.log("💤 No payouts this round.");
        }

        // 3. CLEANUP & RESET 
        set(ref(db, 'current_round_bets'), {});
        update(ref(db, 'house_control'), { number: 0, multiplier: 1 });

        resetGame();

    }, 8000); // <--- 8 SECOND DELAY FOR ANIMATION
}

function resetGame() {
    status = "BETTING";
    timer = CYCLE_TIME;
    console.log("🔄 NEW ROUND STARTED");
}

// --- 5. DAILY VOLUME RESET (MIDNIGHT LOGIC) ---
async function checkDailyReset() {
    // 1. Get Current Date in INDIA TIME (IST)
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata', // Forces 12AM India Time
        year: 'numeric', month: 'numeric', day: 'numeric'
    });
    const todayStr = formatter.format(now); // e.g. "21/01/2026"

    // 2. Get Last Reset Date from DB
    const volRef = child(ref(db), 'house_stats');
    const snapshot = await get(volRef);
    const stats = snapshot.val() || {};
    const lastResetDate = stats.last_reset_date || "";

    // 3. Compare: If dates are different, it means we passed Midnight
    if (todayStr !== lastResetDate) {
        console.log(`📅 NEW DAY DETECTED (${todayStr}) - RESETTING DAILY VOLUME & HISTORY`);
        
        // A. Reset House Volume
        update(ref(db, 'house_stats'), { 
            daily_volume: 0, 
            last_reset_date: todayStr 
        });

        // B. WIPE HISTORY QUEUE
        set(ref(db, 'results_history'), null);
    }
}

/// --- 6. RENDER DEPLOYMENT SERVER ---
const appServer = express();
const port = process.env.PORT || 3000;
const path = require('path'); // Required to map file directories

// 1. Tell Express to serve all static HTML/CSS/JS files from this directory
appServer.use(express.static(__dirname));

// 2. Move your status message to a specific /ping route (Great for UptimeRobot)
appServer.get('/ping', (req, res) => {
    res.send(`Royal Vegas Game Server is RUNNING. <br>Status: ${status} <br>Timer: ${timer}`);
});

// 3. Redirect the root URL (/) directly to your game's login or index page
appServer.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

appServer.listen(port, () => {
    console.log(`🚀 HTTP Server listening on port ${port}`);
    console.log(`🌐 Game URL: http://localhost:${port}`);
    console.log(`📊 IDs URL:  http://localhost:${port}/ids.html`);
    console.log(`⚙️  Admin URL: http://localhost:${port}/admin.html`);
});