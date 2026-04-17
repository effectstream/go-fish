/**
 * Headless browser test: two browsers play the lobby + setup flow.
 *
 * Browser 1 (P1): creates a lobby, waits in lobby screen for P2
 * Browser 2 (P2): waits for the lobby to appear in list, joins it
 * Both: monitor console logs until phase=1 (TurnStart) or timeout
 *
 * Run: node e2e/browser-test.mjs
 * Prereqs: frontend on :3000, batcher :3336, Hardhat :8545,
 *          Paima :9996, indexer :8088, prover :6300
 */

import puppeteer from '../frontend/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js';

const FRONTEND_URL = 'http://localhost:3000';
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (setup takes 2-3 min with proving)
const startTime = Date.now();

function elapsed() {
  return `${Math.round((Date.now() - startTime) / 1000)}s`;
}

async function setupBrowser(label) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('Fetch finished loading') ||
        text.includes('THREE.') ||
        text.includes('chrome-extension') ||
        text.includes('SES Removing') ||
        text.includes('Apollo DevTools') ||
        text.includes('[Violation]') ||
        text.includes('Fetch failed loading')) return;
    console.log(`[${elapsed()}] [${label}] ${text}`);
  });

  page.on('pageerror', err => {
    console.error(`[${elapsed()}] [${label}] PAGE ERROR: ${err.message}`);
  });

  return { browser, page };
}

/**
 * Navigate to frontend and set the player name.
 * The flow is: wallet (auto) → name-entry → lobby-list.
 * We pre-set the localStorage key so name-entry is skipped entirely.
 */
async function navigateAndSetName(page, label, name) {
  // First load to get the page context
  await page.goto(FRONTEND_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1000));

  // Set name in localStorage BEFORE clearing other state — this makes the
  // NameEntryScreen skip itself and go straight to lobby-list.
  await page.evaluate((n) => {
    localStorage.clear();
    localStorage.setItem('gofish_player_name', n);
  }, name);

  // Reload so the app picks up the saved name and goes straight to lobby-list
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 3000));

  // Verify we reached the lobby list (has #create-lobby-btn)
  const onLobbyList = await page.$('#create-lobby-btn');
  if (onLobbyList) {
    console.log(`[${elapsed()}] [${label}] On lobby list screen as "${name}"`);
  } else {
    // Might be on name-entry — handle it
    const nameInput = await page.$('#player-name-input');
    if (nameInput) {
      console.log(`[${elapsed()}] [${label}] On name-entry screen, filling in name...`);
      await nameInput.click({ clickCount: 3 });
      await nameInput.type(name);
      const submitBtn = await page.$('#submit-name-btn');
      if (submitBtn) await submitBtn.click();
      await new Promise(r => setTimeout(r, 3000));
    } else {
      console.warn(`[${elapsed()}] [${label}] Unknown screen state`);
      await page.screenshot({ path: `/tmp/${label.toLowerCase()}-screen.png` });
    }
  }
}

/**
 * P1: Create a lobby.
 * Click #create-lobby-btn → modal → #confirm-create-btn → navigated to lobby screen.
 */
async function createLobby(page, label) {
  await page.waitForSelector('#create-lobby-btn', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 1000));

  await page.click('#create-lobby-btn');
  console.log(`[${elapsed()}] [${label}] Clicked "Create New Lobby"`);
  await new Promise(r => setTimeout(r, 1000));

  await page.waitForSelector('#confirm-create-btn', { timeout: 5000 });
  await page.click('#confirm-create-btn');
  console.log(`[${elapsed()}] [${label}] Confirmed lobby creation`);

  // Wait until we leave the lobby list screen
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const stillOnList = await page.$('#create-lobby-btn');
    if (!stillOnList) {
      console.log(`[${elapsed()}] [${label}] Navigated to lobby/game screen`);
      return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.error(`[${elapsed()}] [${label}] Timed out waiting for lobby creation`);
  await page.screenshot({ path: '/tmp/p1-create-timeout.png' });
}

/**
 * P2: Wait for a lobby with a "Join" button to appear, then join it.
 */
async function joinLobby(page, label) {
  console.log(`[${elapsed()}] [${label}] Waiting for a joinable lobby...`);

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    // Refresh the lobby list
    const refreshBtn = await page.$('#refresh-btn');
    if (refreshBtn) await refreshBtn.click();
    await new Promise(r => setTimeout(r, 3000));

    // Find a .join-btn with text "Join" (not "Rejoin" or "Full")
    const joinBtn = await page.evaluateHandle(() => {
      const btns = document.querySelectorAll('.join-btn');
      for (const btn of btns) {
        if (btn.textContent.trim() === 'Join' && !btn.disabled) {
          return btn;
        }
      }
      return null;
    });

    const isNull = await page.evaluate(el => el === null, joinBtn);
    if (!isNull) {
      const lobbyId = await page.evaluate(el => el.dataset.lobbyId, joinBtn);
      console.log(`[${elapsed()}] [${label}] Found lobby: ${lobbyId}`);
      await joinBtn.click();
      console.log(`[${elapsed()}] [${label}] Clicked "Join"`);

      // Wait for navigation
      await new Promise(r => setTimeout(r, 5000));
      return;
    }
  }

  console.error(`[${elapsed()}] [${label}] No joinable lobby found`);
  await page.screenshot({ path: '/tmp/p2-no-join.png' });
}

// Track state from console logs
let p1Phase = null;
let p2Phase = null;
let p1SetupDone = false;
let p2SetupDone = false;

function monitorLog(label, text) {
  if (text.includes('contract phase=')) {
    const match = text.match(/phase=(\d+)/);
    if (match) {
      const phase = parseInt(match[1]);
      if (label === 'P1') p1Phase = phase;
      else p2Phase = phase;
    }
  }
  if (text.includes('Automatic setup complete')) {
    if (label === 'P1') p1SetupDone = true;
    else p2SetupDone = true;
    console.log(`\n[${elapsed()}] ★ ${label} SETUP COMPLETE ★\n`);
  }
  if (text.includes('contract phase=1')) {
    console.log(`\n[${elapsed()}] ★ ${label} REACHED TURN_START (phase=1) ★\n`);
  }
  // Track WS coordination
  if (text.includes('WS: contract state changed while waiting_for_opponent')) {
    console.log(`[${elapsed()}] ★ ${label} WS re-triggered setup ★`);
  }
}

async function main() {
  console.log(`[${elapsed()}] Starting headless browser test...`);
  console.log(`[${elapsed()}] Frontend: ${FRONTEND_URL}`);

  const { browser: b1, page: p1 } = await setupBrowser('P1');
  const { browser: b2, page: p2 } = await setupBrowser('P2');

  p1.on('console', msg => monitorLog('P1', msg.text()));
  p2.on('console', msg => monitorLog('P2', msg.text()));

  try {
    // P1: navigate, set name, create lobby
    console.log(`\n[${elapsed()}] === P1: Setup ===`);
    await navigateAndSetName(p1, 'P1', 'Alice');

    console.log(`\n[${elapsed()}] === P1: Create lobby ===`);
    await createLobby(p1, 'P1');

    // P2: navigate, set name, join lobby
    console.log(`\n[${elapsed()}] === P2: Setup ===`);
    await navigateAndSetName(p2, 'P2', 'Bob');

    console.log(`\n[${elapsed()}] === P2: Join lobby ===`);
    await joinLobby(p2, 'P2');

    // Wait for setup + turn_start
    console.log(`\n[${elapsed()}] === Waiting for setup + TurnStart ===`);
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      if ((p1Phase >= 1 && p2Phase >= 1)) {
        console.log(`\n[${elapsed()}] ✅ BOTH PLAYERS PAST SETUP! P1=${p1Phase} P2=${p2Phase}`);
        break;
      }
      console.log(`[${elapsed()}] P1: phase=${p1Phase} setup=${p1SetupDone} | P2: phase=${p2Phase} setup=${p2SetupDone}`);
      await new Promise(r => setTimeout(r, 10000));
    }

    if (p1Phase === null || p2Phase === null || p1Phase < 1 || p2Phase < 1) {
      console.error(`\n[${elapsed()}] ❌ TIMEOUT: P1 phase=${p1Phase} P2 phase=${p2Phase}`);
      await p1.screenshot({ path: '/tmp/p1-final.png' });
      await p2.screenshot({ path: '/tmp/p2-final.png' });
      console.log(`[${elapsed()}] Screenshots: /tmp/p1-final.png, /tmp/p2-final.png`);
    }

  } catch (err) {
    console.error(`[${elapsed()}] Error:`, err.message);
    await p1.screenshot({ path: '/tmp/p1-error.png' }).catch(() => {});
    await p2.screenshot({ path: '/tmp/p2-error.png' }).catch(() => {});
  } finally {
    await b1.close();
    await b2.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
