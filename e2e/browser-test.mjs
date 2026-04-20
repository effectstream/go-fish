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
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — applies only to the setup wait
const GAMEPLAY_TURNS = 8;           // rounds to play after setup (each ~60-120s)
const startTime = Date.now();

function elapsed() {
  return `${Math.round((Date.now() - startTime) / 1000)}s`;
}

async function setupBrowser(label) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,900'],
  });
  const page = await browser.newPage();
  // Set a desktop viewport so the sidebar is in-layout (media query
  // min-width: 1024px triggers the in-layout sidebar). Otherwise the
  // #create-lobby-btn is off-screen in a translated-out drawer.
  await page.setViewport({ width: 1280, height: 900 });

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
 *
 * `hardhatIndex` pins the browser to a specific Hardhat account (1-9),
 * preventing wallet-address collisions when both puppeteer browsers would
 * otherwise randomly pick the same index.
 */
async function navigateAndSetName(page, label, name, hardhatIndex) {
  // First load to get the page context
  await page.goto(FRONTEND_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1000));

  // Set name in localStorage BEFORE clearing other state — this makes the
  // NameEntryScreen skip itself and go straight to lobby-list.
  // Also pin the Hardhat account index in sessionStorage so the two
  // browsers don't collide on the same wallet address (random 1-9 picks
  // duplicate too often without this).
  await page.evaluate((n, hh) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('gofish_player_name', n);
    sessionStorage.setItem('go-fish-local-wallet-index', String(hh));
  }, name, hardhatIndex);

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
let sharedLobbyId = null;

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
  // Capture lobbyId as soon as either player enters the game scene
  if (!sharedLobbyId) {
    const m = text.match(/Entering game scene: lobby=(\S+)/);
    if (m) {
      sharedLobbyId = m[1];
      console.log(`[${elapsed()}] ★ Captured lobbyId=${sharedLobbyId}`);
    }
  }
  // V3 alignment signals — highlighted in the test console
  if (text.includes('claimInitialBookIfAny')) {
    console.log(`[${elapsed()}] [${label}] ${text}`);
  }
  if (text.includes('Claiming book') || text.includes('Book of') || text.includes('scored')) {
    console.log(`[${elapsed()}] [${label}] 📚 ${text}`);
  }
  if (text.includes('requestToDrawCard') || text.includes('drawCard') || text.includes('skipTurn')) {
    console.log(`[${elapsed()}] [${label}] 🃏 ${text}`);
  }
  if (text.includes('checkAndEndGame')) {
    console.log(`[${elapsed()}] [${label}] 🏁 ${text}`);
  }
}

/** Read snapshot from the page's live session manager. Returns null if
 *  the session doesn't exist yet (pre-setup or post-teardown). */
async function readSnapshot(page, lobbyId) {
  return await page.evaluate((lid) => {
    const mgr = window.__sessionManager;
    if (!mgr) return null;
    const s = mgr.get(lid);
    if (!s) return null;
    const state = s.getState();
    const snap = s.getSnapshot();
    return state ? {
      playerId: state.playerId,
      currentTurn: state.currentTurn,
      phase: state.phase,
      isMyTurn: state.currentTurn === state.playerId,
      myHand: state.myHand,
      handSizes: state.handSizes,
      deckCount: state.deckCount,
      scores: state.scores,
      isGameOver: state.isGameOver,
      myBooks: state.myBooks,
      inFlight: snap.inFlight,
      askInProgress: snap.askInProgress,
      respondInProgress: snap.respondInProgress,
      drawInProgress: snap.drawInProgress,
    } : null;
  }, lobbyId);
}

/** Ask for the first card in my hand. Returns the rank we asked for (or
 *  null if hand empty — session's auto-dispatchers handle that case). */
async function drivePlayerAsk(page, label, lobbyId) {
  return await page.evaluate((lid) => {
    const mgr = window.__sessionManager;
    const s = mgr?.get(lid);
    if (!s) return { error: 'no session' };
    const state = s.getState();
    if (!state) return { error: 'no state' };
    const RANK_NAMES = ['A', '2', '3', '4', '5', '6', '7'];
    if (state.myHand.length === 0) {
      // Session auto-dispatches requestToDrawCard / skipTurn at turn_start.
      return { empty: true, deck: state.deckCount };
    }
    // Pick the rank we have the most of — maximizes book potential.
    const counts = new Map();
    for (const c of state.myHand) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
    let bestRank = state.myHand[0].rank;
    let bestCount = 0;
    for (const [r, n] of counts) {
      if (n > bestCount) { bestRank = r; bestCount = n; }
    }
    const rankIndex = RANK_NAMES.indexOf(bestRank);
    s.askForCard(rankIndex);
    return { rank: bestRank, rankIndex, have: bestCount };
  }, lobbyId);
}

/** Wait until EITHER page sees a turn_start where isMyTurn is true (i.e.,
 *  the active player is ready to act) OR the game is over. Handles both
 *  successful-ask (turn stays with asker) and go-fish (turn flips). */
async function waitForAnyActiveOrEnd(pages, lobbyId, afterTs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const { page, label } of pages) {
      const snap = await readSnapshot(page, lobbyId);
      if (!snap) continue;
      if (snap.isGameOver) return { snap, label, over: true };
      // Only consider this a "new turn" signal if enough time has elapsed
      // since we initiated the previous ask (avoids seeing the state that
      // triggered the original turn). 3s is a safe lower bound given
      // batcher + indexer latency per tx.
      const elapsedSincePrev = Date.now() - afterTs;
      if (elapsedSincePrev < 3000) continue;
      if (snap.phase === 'turn_start' &&
          snap.isMyTurn &&
          !snap.askInProgress &&
          !snap.respondInProgress &&
          !snap.drawInProgress) {
        return { snap, label, over: false };
      }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

/** Play N rounds of gameplay, one ask per turn, alternating active player. */
async function playGameplayLoop(pages, lobbyId, maxTurns) {
  console.log(`\n[${elapsed()}] === Gameplay loop (max ${maxTurns} turns) ===`);
  for (let turn = 1; turn <= maxTurns; turn++) {
    let activePage = null;
    let activeLabel = null;
    for (const { page, label } of pages) {
      const snap = await readSnapshot(page, lobbyId);
      if (!snap) continue;
      if (snap.isGameOver) {
        console.log(`[${elapsed()}] ✅ Game over detected (${label} snapshot). Scores: ${snap.scores}, books: ${snap.myBooks?.join(',') ?? '-'}`);
        return;
      }
      if (snap.phase === 'turn_start' && snap.isMyTurn) {
        activePage = page;
        activeLabel = label;
        console.log(`[${elapsed()}] Turn ${turn}: ${label} active. hand=${snap.myHand.length} deck=${snap.deckCount} scores=${snap.scores}`);
      }
    }
    if (!activePage) {
      console.log(`[${elapsed()}] Turn ${turn}: no active player found, waiting...`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    const actionStartTs = Date.now();
    const result = await drivePlayerAsk(activePage, activeLabel, lobbyId);
    if (result.empty) {
      console.log(`[${elapsed()}] Turn ${turn}: ${activeLabel} hand empty (deck=${result.deck}) — session will auto-dispatch`);
    } else if (result.error) {
      console.log(`[${elapsed()}] Turn ${turn}: ${activeLabel} drive error: ${result.error}`);
    } else {
      console.log(`[${elapsed()}] Turn ${turn}: ${activeLabel} asked for ${result.rank}s (holds ${result.have})`);
    }

    // Wait for NEXT actionable state (could be same player on successful
    // ask, or other player on go-fish). Either counts — plus game-over.
    // Generous timeout: go-fish paths involve 3 serial proofs
    // (ask + respond + afterGoFish) at ~60-120s each.
    const next = await waitForAnyActiveOrEnd(pages, lobbyId, actionStartTs, 420_000);
    if (!next) {
      console.log(`[${elapsed()}] Turn ${turn}: timed out waiting for next turn`);
      return;
    }
    if (next.over) {
      console.log(`[${elapsed()}] ✅ Game over after turn ${turn}. Scores: ${next.snap.scores}`);
      return;
    }
    console.log(`[${elapsed()}] Turn ${turn}: → ${next.label} is now active (phase=${next.snap.phase} hand=${next.snap.myHand.length} deck=${next.snap.deckCount} scores=${next.snap.scores})`);
  }
  console.log(`[${elapsed()}] Gameplay loop completed ${maxTurns} turns without game-over`);
}

async function main() {
  console.log(`[${elapsed()}] Starting headless browser test...`);
  console.log(`[${elapsed()}] Frontend: ${FRONTEND_URL}`);

  const { browser: b1, page: p1 } = await setupBrowser('P1');
  const { browser: b2, page: p2 } = await setupBrowser('P2');

  p1.on('console', msg => monitorLog('P1', msg.text()));
  p2.on('console', msg => monitorLog('P2', msg.text()));

  try {
    // P1: navigate, set name, create lobby. Pin Hardhat account #1.
    console.log(`\n[${elapsed()}] === P1: Setup ===`);
    await navigateAndSetName(p1, 'P1', 'Alice', 1);

    console.log(`\n[${elapsed()}] === P1: Create lobby ===`);
    await createLobby(p1, 'P1');

    // P2: navigate, set name, join lobby. Pin Hardhat account #2 so the
    // two browsers have distinct wallet addresses.
    console.log(`\n[${elapsed()}] === P2: Setup ===`);
    await navigateAndSetName(p2, 'P2', 'Bob', 2);

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
    } else if (sharedLobbyId) {
      // Setup succeeded — drive 8 rounds of gameplay to exercise
      // V3.1 (checkAndScoreBook after transfer), V3.3 (empty-hand
      // dispatchers), and V4.2 (checkAndEndGame). 8 turns is enough
      // to see books form and possibly deck exhaustion given 4 cards
      // per hand + 13 in deck.
      const pages = [
        { page: p1, label: 'P1' },
        { page: p2, label: 'P2' },
      ];
      try {
        await playGameplayLoop(pages, sharedLobbyId, GAMEPLAY_TURNS);
      } catch (gpErr) {
        console.error(`[${elapsed()}] Gameplay loop error:`, gpErr.message);
      }
      // Final snapshot dump for post-mortem
      for (const { page, label } of pages) {
        const snap = await readSnapshot(page, sharedLobbyId).catch(() => null);
        console.log(`[${elapsed()}] Final snapshot ${label}:`, JSON.stringify(snap, null, 2));
      }
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
