// ============================================================
//   AppleMC Multi-Bot Manager — v8 (All Packages Edition)
//   Includes: pathfinder, collectblock, tool, pvp, statemachine,
//             toolbox (auto-eat/armor/totem), baritone
// ============================================================

const mineflayer = require('mineflayer');
const readline = require('readline');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { plugin: collectBlock } = require('mineflayer-collectblock');
const toolPlugin = require('mineflayer-tool').plugin;
const pvpPlugin = require('mineflayer-pvp').plugin;
const { BotStateMachine, getTransition, getNestedMachine } = require('mineflayer-statemachine');
const toolbox = require('mineflayer-toolbox');
const baritone = require('@miner-org/mineflayer-baritone').loader;

const SETTINGS = {
  host: 'play.applemc.fun',
  version: '1.20',
  targetServer: 'Banana',
  firstConnectDelay: 10000,
  reconnectDelay: 60000,
  longWaitDelay: 300000,
  maxFailsBeforeLongWait: 5,
  stableResetMs: 30000,
  autoRestartEnabled: true,
  autoRestartInterval: 3 * 60 * 60 * 1000,
  autoRestartToHub: 'hub-1',
  autoRestartDelay: 30000,
  autoRestartJitter: 60000
};

const ACCOUNTS = [
  { username: 'SA11113H', password: 'PGNR_58@1234#' },
  { username: 'AFKBot2',  password: 'Pass12345' },
  { username: 'AFKBot3',  password: 'Pass12345' },
  { username: 'AFKBot4',  password: 'Pass12345' }
];

const bots = {};

function log(user, msg) {
  const time = new Date().toLocaleTimeString();
  process.stdout.write('\r\x1b[K');
  console.log(`[${time}] [${user}] ${msg}`);
  rl.prompt(true);
}

function isOnline(entry) {
  return entry && entry.bot && entry.bot.entity && entry.bot.player;
}

// ============ GAMEPLAY TASKS (using collectblock) ============

async function chopWood(entry, count = 100) {
  const bot = entry.bot;
  if (!isOnline(entry)) return log(entry.username, 'not online');

  const logIds = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log',
                  'dark_oak_log','mangrove_log','cherry_log','pale_oak_log'];

  let chopped = 0;
  entry.task = 'wood';
  log(entry.username, `chopWood started (target ${count})`);

  while (entry.task === 'wood' && chopped < count && bot.entity) {
    const block = bot.findBlock({
      matching: (b) => logIds.includes(b.name),
      maxDistance: 64
    });

    if (!block) {
      log(entry.username, 'no logs nearby, walking randomly...');
      const pos = bot.entity.position;
      const randomGoal = new goals.GoalNear(pos.x + (Math.random()*40-20), pos.y, pos.z + (Math.random()*40-20), 2);
      await bot.pathfinder.goto(randomGoal).catch(()=>{});
      continue;
    }

    try {
      await bot.collectBlock.collect(block);
      chopped++;
      log(entry.username, `chopped ${block.name} (${chopped}/${count})`);
    } catch (e) {
      log(entry.username, `collect failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  entry.task = null;
  log(entry.username, `chopWood finished (${chopped} logs)`);
}

async function mineBlock(entry, blockName, count = 64) {
  const bot = entry.bot;
  if (!isOnline(entry)) return log(entry.username, 'not online');

  entry.task = 'mine';
  let mined = 0;
  log(entry.username, `mine ${blockName} started (target ${count})`);

  while (entry.task === 'mine' && mined < count && bot.entity) {
    const block = bot.findBlock({
      matching: (b) => b.name === blockName,
      maxDistance: 64
    });

    if (!block) {
      log(entry.username, `no ${blockName} nearby`);
      break;
    }

    try {
      await bot.collectBlock.collect(block);
      mined++;
      log(entry.username, `mined ${blockName} (${mined}/${count})`);
    } catch (e) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  entry.task = null;
  log(entry.username, `mine finished (${mined} blocks)`);
}

function stopTask(entry) {
  entry.task = null;
  if (entry.bot) {
    try { entry.bot.pathfinder.stop(); } catch(e) {}
    try { entry.bot.collectBlock.cancelTask(); } catch(e) {}
    entry.bot.setControlState('forward', false);
    entry.bot.setControlState('back', false);
    entry.bot.setControlState('left', false);
    entry.bot.setControlState('right', false);
    entry.bot.setControlState('jump', false);
  }
  log(entry.username, 'task stopped');
}

// ============ AUTO-RESTART ============

function scheduleAutoRestart(entry) {
  if (!SETTINGS.autoRestartEnabled) return;
  if (entry.restartTimer) clearTimeout(entry.restartTimer);

  const jitter = Math.floor(Math.random() * SETTINGS.autoRestartJitter);
  const totalWait = SETTINGS.autoRestartInterval + jitter;

  log(entry.username, `auto-restart scheduled in ${(totalWait/60000).toFixed(1)} min`);

  entry.restartTimer = setTimeout(async () => {
    log(entry.username, '=== AUTO-RESTART FIRING ===');
    const bot = entry.bot;

    if (SETTINGS.autoRestartToHub && bot && bot.entity) {
      try {
        log(entry.username, `switching to ${SETTINGS.autoRestartToHub} before restart...`);
        bot.chat(`/server ${SETTINGS.autoRestartToHub}`);
        await new Promise(r => setTimeout(r, 5000));
      } catch (e) {}
    }

    entry.restartInProgress = true;
    if (bot) try { bot.quit(); } catch (e) {}

    setTimeout(() => {
      log(entry.username, 'reconnecting after auto-restart...');
      createBot({ username: entry.username, password: entry.password });
    }, SETTINGS.autoRestartDelay);
  }, totalWait);
}

function cancelAutoRestart(entry) {
  if (entry.restartTimer) {
    clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
  }
}

// ============ BOT CORE (ALL PLUGINS LOADED) ============

function createBot(account) {
  if (!bots[account.username]) {
    bots[account.username] = {
      bot: null, fails: 0, registered: false, loggedIn: false,
      switched: false, online: false, sentRegister: false, sentLogin: false,
      password: account.password, task: null, username: account.username,
      restartTimer: null, restartInProgress: false
    };
  }
  const entry = bots[account.username];
  entry.password = account.password;

  let delay = entry.fails === 0 ? SETTINGS.firstConnectDelay : SETTINGS.reconnectDelay;
  if (entry.fails >= SETTINGS.maxFailsBeforeLongWait) {
    delay = SETTINGS.longWaitDelay;
    log(account.username, `too many fails (${entry.fails}), backing off ${delay/1000}s`);
    entry.fails = 0;
  }

  log(account.username, `waiting ${delay/1000}s before connect (fails: ${entry.fails})`);

  setTimeout(() => {
    log(account.username, 'connecting...');

    const bot = mineflayer.createBot({
      host: SETTINGS.host,
      username: account.username,
      version: SETTINGS.version,
      auth: 'offline',
      keepAlive: true
    });

    // --- LOAD ALL PLUGINS ---
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlock);
    bot.loadPlugin(toolPlugin);
    bot.loadPlugin(pvpPlugin);
    bot.loadPlugin(toolbox);
    bot.loadPlugin(baritone);

    entry.bot = bot;
    entry.loggedIn = false;
    entry.switched = false;
    entry.sentRegister = false;
    entry.sentLogin = false;

    bot.on('message', (jsonMsg) => {
      const msg = jsonMsg.toString();
      log(account.username, msg);

      if (/being verified|bot verification|failed the bot|please wait a few seconds/i.test(msg)) {
        entry.fails++;
        log(account.username, 'antibot detected, disconnecting');
        try { bot.quit(); } catch (e) {}
        return;
      }

      if (/register using \/register|register.*password/i.test(msg)) {
        if (!entry.registered && !entry.sentRegister) {
          entry.sentRegister = true;
          setTimeout(() => { try { bot.chat(`/register ${entry.password} ${entry.password}`); } catch(e){} }, 1200);
        } else if (entry.registered && !entry.sentLogin) {
          entry.sentLogin = true;
          setTimeout(() => { try { bot.chat(`/login ${entry.password}`); } catch(e){} }, 1200);
        }
        return;
      }

      if (/please login|login using \/login|already registered|you have \d+ attempts/i.test(msg)) {
        if (!entry.sentLogin) {
          entry.sentLogin = true;
          setTimeout(() => { try { bot.chat(`/login ${entry.password}`); } catch(e){} }, 1200);
        }
        return;
      }

      if (/successfully registered|registration successful/i.test(msg)) {
        entry.registered = true;
        setTimeout(() => {
          if (!entry.loggedIn && !entry.sentLogin) {
            entry.sentLogin = true;
            try { bot.chat(`/login ${entry.password}`); } catch(e){}
          }
        }, 2500);
        return;
      }

      if (/successfully logged in|you are now logged|login successful/i.test(msg)) {
        entry.loggedIn = true;
        if (!entry.switched) {
          entry.switched = true;
          setTimeout(() => { try { bot.chat(`/server ${SETTINGS.targetServer}`); } catch(e){} }, 3000);
        }
        return;
      }

      if (/already logged in/i.test(msg) && !entry.switched) {
        entry.loggedIn = true;
        entry.switched = true;
        setTimeout(() => { try { bot.chat(`/server ${SETTINGS.targetServer}`); } catch(e){} }, 3000);
      }
    });

    bot.on('spawn', () => {
      log(account.username, 'spawned');
      entry.online = true;
      entry.fails = 0;

      // Setup pathfinder movements
      const defaultMove = new Movements(bot);
      bot.pathfinder.setMovements(defaultMove);

      // Enable toolbox auto-features
      bot.autototem('on', 'offhand');
      bot.autoarmor('on');
      bot.autoeat('on');

      if (!entry.restartTimer) {
        scheduleAutoRestart(entry);
      }

      setTimeout(() => {
        if (!entry.loggedIn && !entry.sentLogin && !entry.switched) {
          entry.sentLogin = true;
          try { bot.chat(`/login ${entry.password}`); } catch(e){}
        }
      }, 5000);
    });

    bot.on('kicked', (reason) => {
      let text = '';
      try { text = JSON.stringify(reason).slice(0, 180); } catch(e) { text = String(reason); }
      log(account.username, `KICKED: ${text}`);
      entry.fails++;
    });

    bot.on('error', (err) => log(account.username, `ERROR: ${err.message}`));

    bot.on('end', () => {
      entry.online = false;

      if (entry.restartInProgress) {
        log(account.username, 'auto-restart in progress, skipping default reconnect');
        entry.restartInProgress = false;
        return;
      }

      log(account.username, 'disconnected, retrying...');
      setTimeout(() => createBot(account), 5000);
    });

  }, delay);
}

// ============ TERMINAL ============

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '> '
});

function printHelp() {
  console.log(`
--- CONTROL ---
  startall                start every account in ACCOUNTS (staggered 45s)
  start <name>            start a saved account
  add <name> <pass>       add a new account and connect
  stop <name>             disconnect one bot
  stopall                 disconnect all
  remove <name>           delete a bot
  list                    show bot statuses
  restart <name>          force-restart one bot now
  restartall              force-restart all online bots now
  autorestart on|off      toggle the 3-hour auto-restart
  autorestart status      show current setting
  help                    show this menu
  quit                    exit

--- CHAT ---
  all <cmd>               send command to every ONLINE bot
  <name> <cmd>            send command to ONE bot

--- GAMEPLAY ---
  <name> .wood [count]
  <name> .mine <block> [n]
  <name> .stop
  <name> .dropall
  <name> .home
  <name> .tpaccept
  <name> .attack <player>   PVP attack target
  <name> .stopattack        stop PVP
  <name> .equip <item>      equip best tool for item
`);
}

console.log('\n===========================================');
console.log('  AppleMC Multi-Bot Manager  v8');
console.log('  All Packages Loaded');
console.log('===========================================');
printHelp();
rl.prompt();

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) { rl.prompt(); return; }
  const parts = trimmed.split(' ');
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (cmd === 'startall') {
    console.log(`Starting ${ACCOUNTS.length} bot(s), 45s apart...`);
    ACCOUNTS.forEach((acc, i) => {
      setTimeout(() => { createBot(acc); }, i * 45000);
    });
    rl.prompt(); return;
  }

  if (cmd === 'start') {
    const acc = ACCOUNTS.find(a => a.username === args[0]);
    if (!acc) { console.log(`No account "${args[0]}"`); rl.prompt(); return; }
    createBot(acc); rl.prompt(); return;
  }

  if (cmd === 'add') {
    if (args.length < 2) { console.log('Usage: add <name> <pass>'); rl.prompt(); return; }
    const { 0: username, 1: password } = args;
    ACCOUNTS.push({ username, password });
    createBot({ username, password });
    rl.prompt(); return;
  }

  if (cmd === 'stop') {
    const e = bots[args[0]];
    if (e) { cancelAutoRestart(e); if (e.bot) try { e.bot.quit(); } catch(_){} }
    rl.prompt(); return;
  }

  if (cmd === 'stopall') {
    for (const e of Object.values(bots)) {
      cancelAutoRestart(e);
      try { e.bot && e.bot.quit(); } catch(_){}
    }
    console.log('All stopped.'); rl.prompt(); return;
  }

  if (cmd === 'remove') {
    const name = args[0];
    if (bots[name]) {
      cancelAutoRestart(bots[name]);
      try { bots[name].bot && bots[name].bot.quit(); } catch(_){}
      delete bots[name];
    }
    const i = ACCOUNTS.findIndex(a => a.username === name);
    if (i >= 0) ACCOUNTS.splice(i, 1);
    console.log(`Removed ${name}`); rl.prompt(); return;
  }

  if (cmd === 'restart') {
    const name = args[0];
    const e = bots[name];
    if (!e) { console.log(`Unknown bot: ${name}`); rl.prompt(); return; }
    log(name, 'forced restart');
    cancelAutoRestart(e);
    e.restartInProgress = true;
    if (e.bot) try { e.bot.quit(); } catch(_){}
    setTimeout(() => {
      e.restartInProgress = false;
      createBot({ username: name, password: e.password });
    }, 5000);
    rl.prompt(); return;
  }

  if (cmd === 'restartall') {
    for (const [name, e] of Object.entries(bots)) {
      log(name, 'forced restart');
      cancelAutoRestart(e);
      e.restartInProgress = true;
      if (e.bot) try { e.bot.quit(); } catch(_){}
      setTimeout(() => {
        e.restartInProgress = false;
        createBot({ username: name, password: e.password });
      }, 5000 + Math.random() * 30000);
    }
    rl.prompt(); return;
  }

  if (cmd === 'autorestart') {
    const sub = (args[0] || '').toLowerCase();
    if (sub === 'on') {
      SETTINGS.autoRestartEnabled = true;
      for (const e of Object.values(bots)) {
        if (isOnline(e) && !e.restartTimer) scheduleAutoRestart(e);
      }
      console.log('Auto-restart ON');
    } else if (sub === 'off') {
      SETTINGS.autoRestartEnabled = false;
      for (const e of Object.values(bots)) cancelAutoRestart(e);
      console.log('Auto-restart OFF');
    } else if (sub === 'status') {
      console.log(`Auto-restart: ${SETTINGS.autoRestartEnabled ? 'ON' : 'OFF'}`);
      console.log(`Interval: ${SETTINGS.autoRestartInterval / 60000} min + 0-${SETTINGS.autoRestartJitter/1000}s jitter`);
      for (const [name, e] of Object.entries(bots)) {
        console.log(`  ${name}: ${e.restartTimer ? 'scheduled' : 'none'}`);
      }
    } else {
      console.log('Usage: autorestart on|off|status');
    }
    rl.prompt(); return;
  }

  if (cmd === 'all') {
    const chat = args.join(' ');
    let n = 0;
    for (const [name, e] of Object.entries(bots)) {
      if (isOnline(e)) { try { e.bot.chat(chat); n++; } catch(_){} }
    }
    console.log(`--> sent to ${n} bot(s)`); rl.prompt(); return;
  }

  if (cmd === 'list') {
    console.log('\n--- Bot status ---');
    for (const [name, e] of Object.entries(bots)) {
      const st = isOnline(e) ? 'ONLINE ' : 'offline';
      const restart = e.restartTimer ? 'restart:yes' : 'restart:no ';
      console.log(`  ${name.padEnd(15)} ${st}  ${restart}  task:${(e.task||'-').padEnd(8)} fails:${e.fails}`);
    }
    console.log(''); rl.prompt(); return;
  }

  if (cmd === 'help') { printHelp(); rl.prompt(); return; }
  if (cmd === 'quit' || cmd === 'exit') {
    for (const e of Object.values(bots)) {
      cancelAutoRestart(e);
      try { e.bot && e.bot.quit(); } catch(_){}
    }
    process.exit(0);
  }

  // ---- <name> <command> ----
  const name = parts[0];
  const rest = parts.slice(1);
  const sub = rest[0] ? rest[0].toLowerCase() : '';
  const entry = bots[name];

  if (!entry) { console.log(`Unknown bot: ${name}`); rl.prompt(); return; }
  if (!isOnline(entry)) { console.log(`${name} is offline`); rl.prompt(); return; }

  if (sub === '.wood') { chopWood(entry, parseInt(rest[1]) || 100); rl.prompt(); return; }
  if (sub === '.mine') {
    const blockName = rest[1];
    const count = parseInt(rest[2]) || 64;
    if (!blockName) { console.log('Usage: <name> .mine <block_name> [count]'); rl.prompt(); return; }
    mineBlock(entry, blockName, count); rl.prompt(); return;
  }
  if (sub === '.stop') { stopTask(entry); rl.prompt(); return; }
  if (sub === '.dropall') {
    for (const item of entry.bot.inventory.items()) {
      try { await entry.bot.tossStack(item); } catch(_){}
    }
    console.log(`dropped all for ${name}`); rl.prompt(); return;
  }
  if (sub === '.home') { entry.bot.chat('/home'); rl.prompt(); return; }
  if (sub === '.tpaccept') { entry.bot.chat('/tpaccept'); rl.prompt(); return; }
  if (sub === '.attack') {
    const target = rest[1];
    if (!target) { console.log('Usage: <name> .attack <player>'); rl.prompt(); return; }
    const player = entry.bot.players[target]?.entity;
    if (player) {
      entry.bot.pvp.attack(player);
      log(name, `attacking ${target}`);
    } else {
      console.log(`Player ${target} not found nearby`);
    }
    rl.prompt(); return;
  }
  if (sub === '.stopattack') {
    entry.bot.pvp.stop();
    log(name, 'stopped PVP');
    rl.prompt(); return;
  }
  if (sub === '.equip') {
    const itemName = rest[1];
    if (!itemName) { console.log('Usage: <name> .equip <item_name>'); rl.prompt(); return; }
    const item = entry.bot.inventory.items().find(i => i.name.includes(itemName));
    if (item) {
      await entry.bot.equip(item, 'hand').catch(()=>{});
      log(name, `equipped ${item.name}`);
    } else {
      console.log(`Item ${itemName} not in inventory`);
    }
    rl.prompt(); return;
  }

  const chat = rest.join(' ');
  try { entry.bot.chat(chat); log(name, `sent: ${chat}`); } catch(_){}
  rl.prompt();
});

rl.on('close', () => process.exit(0));