const fs = require('fs-extra');
const axios = require('axios');
const ethers = require('ethers');
const chalk = require('chalk');
const Table = require('cli-table3');
const { HttpsProxyAgent } = require('https-proxy-agent');
const UserAgent = require('user-agents');
const moment = require('moment');

// ============================================
// SIPAL LIQUICORE BOT V3.0 - REALTIME DASHBOARD
// ============================================

// --- CONFIG & SETUP ---
const config = {
    baseUrl: "https://fckqnmehuebqmevkicgz.supabase.co",
    origin: "https://liquicore.finance",
    referer: "https://liquicore.finance/",
    apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZja3FubWVodWVicW1ldmtpY2d6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4NzQ3NDksImV4cCI6MjA4NDQ1MDc0OX0.ryCrP8GkL68ORKerfisZ6kfmFjTcyl3UJx7S6cfHhmk",
    maxRetries: 5,
    retryDelay: 3000,

    // SCHEDULE CONFIG
    dailyHour: 21,        // 21:00 WIB (9 PM)
    dailyMinute: 0,
    discordInterval: 30 * 60 * 1000, // 30 minutes
    duelInterval: 5 * 60 * 60 * 1000, // 5 hours


    // DISCORD CONFIG
    discordGuildId: "1460573383518322770",
    discordAppId: "1463169413485428747",
    faucets: [
        { name: "USDC", channelId: "1463389945225023629", customId: "claim_tusdc" },
        { name: "USDT", channelId: "1463389902170492961", customId: "claim_tusdt" }
    ]
};

// --- ANTI-DETECTION CONFIG ---
const antiDetect = {
    minActionDelay: 2000,
    maxActionDelay: 8000,
    requestJitter: () => Math.floor(Math.random() * 2000) + 500,
    interactionDelay: () => Math.floor(Math.random() * 3000) + 1000,
    userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
    ],
    getRandomUA: function () {
        return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
    },
    generateSessionId: () => {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 32; i++) result += chars[Math.floor(Math.random() * chars.length)];
        return result;
    }
};

// Load accounts
let accounts = [];
try {
    accounts = require('./accounts.json');
} catch (e) {
    console.log(chalk.red('❌ Error loading accounts.json'));
    process.exit(1);
}

// Provider with failover
const RPC_URLS = [
    'https://data-seed-prebsc-1-s1.bnbchain.org:8545/',
    'https://data-seed-prebsc-2-s1.bnbchain.org:8545/',
    'https://bsc-testnet-rpc.publicnode.com'
];
let currentRpcIndex = 0;
let provider = new ethers.providers.JsonRpcProvider(RPC_URLS[currentRpcIndex]);

function rotateRpc() {
    currentRpcIndex = (currentRpcIndex + 1) % RPC_URLS.length;
    provider = new ethers.providers.JsonRpcProvider(RPC_URLS[currentRpcIndex]);
}

// Contracts
const USDC_ADDR = '0xe4da02B0188D98A10244c1bD265Ea0aF36be205a';
const USDT_ADDR = '0x29565d182bF1796a3836a68D22D833d92795725A';
const VAULT_ADDR = '0x11e4e6cD5D9E60646219098d99CfaFd130cdcE93'; // RLP Vault (/vault)
const LAAS_VAULT_ADDR = '0x4FC31E7199ccC0e756c640D65c418d62c1898D12'; // LaaS Vault (/governance) - for daily task verification
const DUEL_ADDR = '0xe85a13581bFa506F4A1E903312E13842f1863c1f'; // V2 Contract

// V2 LIMITS
const DAILY_DUEL_LIMIT = 1;
const SAME_OPPONENT_LIMIT = 3;
const RATE_LIMIT_DUELS = 3;
const RATE_LIMIT_WINDOW = 2 * 60 * 1000; // 2 minutes

// DUEL ABI
const DUEL_ABI = [
    'function createDuel(uint256 wagerAmount, address wagerToken, uint8 duelType) returns (uint256)',
    'function acceptDuel(uint256 duelId)',
    'function claimPrize(uint256 duelId)',
    'function duels(uint256) view returns (uint256 id, address challenger, address opponent, uint256 wagerAmount, address wagerToken, uint8 duelType, uint8 status, uint256 createdAt, uint256 expiresAt, address winner, bool prizeClaimed)',
    'function duelCounter() view returns (uint256)',
    'function getOpenDuels() view returns (tuple(uint256 id, address challenger, address opponent, uint256 wagerAmount, address wagerToken, uint8 duelType, uint8 status, uint256 createdAt, uint256 expiresAt, address winner, bool prizeClaimed)[])',
    'function getActiveDuels() view returns (tuple(uint256 id, address challenger, address opponent, uint256 wagerAmount, address wagerToken, uint8 duelType, uint8 status, uint256 createdAt, uint256 expiresAt, address winner, bool prizeClaimed)[])',
    'function getUserDuels(address user) view returns (uint256[])',
    'function getDuel(uint256 duelId) view returns (tuple(uint256 id, address challenger, address opponent, uint256 wagerAmount, address wagerToken, uint8 duelType, uint8 status, uint256 createdAt, uint256 expiresAt, address winner, bool prizeClaimed))'
];

const DUEL_STATUS = { PENDING: 0, ACTIVE: 1, RESOLVED: 2, CLAIMED: 3, CANCELLED: 4 };

// ============================================
// GLOBAL STATE & ERROR LOG
// ============================================

const errorLogs = [];
const MAX_ERROR_LOGS = 10;
const state = {};

const createState = (index) => ({
    name: `Acc ${index + 1}`,
    points: '-',
    streak: '-',
    discordFaucet: '⏳',
    webFaucet: '⏳',
    dailyTask: '⏳',
    dailyQuiz: '⏳',
    duelStatus: '⏳',
    nextDaily: null,
    nextDuel: null,
    lastDiscord: 0,
    lastDaily: 0,
    lastDuel: 0,
    isProcessing: false,
    duelHistory: [], // Array of { timestamp, opponent, amount }
    dailyDuelCount: 0,
    duelFailures: 0
});

// ============================================
// UTILITY FUNCTIONS
// ============================================

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomSleep = async () => await sleep(randomDelay(antiDetect.minActionDelay, antiDetect.maxActionDelay));

function formatTime(ms) {
    if (ms <= 0) return chalk.green("Ready");
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

function getNextDailySchedule() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(config.dailyHour, config.dailyMinute, 0, 0);
    if (now >= next) next.setDate(next.getDate() + 1);
    return next;
}

function logError(idx, msg, rawError = null) {
    const time = moment().format('HH:mm:ss');
    const logMsg = `[${time}] [Acc ${idx + 1}] ❌ ${msg}`;
    errorLogs.push(logMsg);
    if (errorLogs.length > MAX_ERROR_LOGS) errorLogs.shift();
    if (rawError) {
        console.log(chalk.red(`[Acc ${idx + 1}] Detailed Error:`), rawError.message || rawError);
        if (rawError.reason) console.log(chalk.red(`[Acc ${idx + 1}] Reason:`), rawError.reason);
    }
}

// ============================================
// RETRY WRAPPER (5x with smart logic)
// ============================================

async function withRetry(fn, idx, actionName, maxRetries = config.maxRetries) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await sleep(antiDetect.requestJitter());
            const result = await fn();
            return { success: true, result };
        } catch (error) {
            lastError = error;
            const errorMsg = error.message || 'Unknown error';

            if (errorMsg.includes('429') || errorMsg.includes('rate limit')) {
                const waitTime = 30000 + (attempt * 10000);
                if (state[idx]) state[idx][actionName] = `⏳RL${attempt}`;
                await sleep(waitTime);
                continue;
            }

            if (errorMsg.includes('ECONNRESET') || errorMsg.includes('ETIMEDOUT') || errorMsg.includes('proxy')) {
                rotateRpc();
                if (state[idx]) state[idx][actionName] = `⏳R${attempt}`;
                await sleep(config.retryDelay * attempt);
                continue;
            }

            if (errorMsg.includes('already') || errorMsg.includes('cooldown')) {
                return { success: true, result: 'already_done' };
            }

            if (attempt < maxRetries) {
                if (state[idx]) state[idx][actionName] = `⏳R${attempt}`;
                await sleep(config.retryDelay * attempt);
            }
        }
    }

    const failReason = lastError?.reason || lastError?.message || 'Failed after 5 retries';
    logError(idx, `${actionName}: ${failReason.slice(0, 200)}`, lastError);
    return { success: false, error: lastError };
}

// ============================================
// DISPLAY FUNCTIONS
// ============================================

const BANNER = chalk.blue(`
               / \\
              /   \\
             |  |  |
             |  |  |
              \\  \\
             |  |  |
             |  |  |
              \\   /
               \\ /
`) + chalk.bold.cyan('    ======SIPAL AIRDROP======\n') +
    chalk.bold.cyan('  =====SIPAL LIQUICORE BOT V3.0=====\n') +
    chalk.gray('     Realtime Dashboard Mode\n');

function clearScreen() {
    process.stdout.write('\x1B[2J\x1B[0f');
}

function renderDashboard() {
    clearScreen();
    process.stdout.write('\x1B[1;1H');

    console.log(BANNER);

    if (errorLogs.length > 0) {
        console.log(chalk.red.bold('═══ Error Logs ═══'));
        errorLogs.forEach(log => console.log(chalk.red(log)));
        console.log(chalk.red('═'.repeat(40)));
        console.log('');
    }

    const table = new Table({
        head: [
            chalk.cyan('Account'),
            chalk.cyan('Points'),
            chalk.cyan('Streak'),
            chalk.cyan('Discord'),
            chalk.cyan('WebFaucet'),
            chalk.cyan('DailyTask'),
            chalk.cyan('Quiz'),
            chalk.cyan('Duel'),
            chalk.cyan('NextDaily'),
            chalk.cyan('NextDuel')
        ],
        style: { head: [], border: ['grey'] },
        colWidths: [10, 9, 8, 10, 11, 11, 6, 10, 12, 12]
    });

    const now = Date.now();

    Object.keys(state).sort((a, b) => parseInt(a) - parseInt(b)).forEach(idx => {
        const s = state[idx];
        const nextDailyMs = s.nextDaily ? s.nextDaily.getTime() - now : 0;
        const nextDuelMs = s.nextDuel ? s.nextDuel.getTime() - now : 0;

        const formatStatus = (status) => {
            if (status === '✅') return chalk.green('✅');
            if (status === '❌') return chalk.red('❌');
            if (status.startsWith('⏳')) return chalk.yellow(status);
            if (status === '🔄') return chalk.cyan('🔄');
            return status;
        };

        table.push([
            chalk.white(s.name),
            chalk.yellow(s.points),
            chalk.magenta(s.streak),
            formatStatus(s.discordFaucet),
            formatStatus(s.webFaucet),
            formatStatus(s.dailyTask),
            formatStatus(s.dailyQuiz),
            formatStatus(s.duelStatus),
            formatTime(nextDailyMs),
            formatTime(nextDuelMs)
        ]);
    });

    console.log(table.toString());
    console.log('');
    console.log(chalk.gray(`Last Update: ${moment().format('HH:mm:ss')} | Press Ctrl+C to stop`));
}

// ============================================
// HTTP CLIENT WITH ANTI-DETECTION
// ============================================

function createClient(proxy) {
    const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
    const userAgent = antiDetect.getRandomUA();

    return axios.create({
        baseURL: config.baseUrl,
        httpsAgent: agent,
        timeout: 30000,
        headers: {
            'apikey': config.apiKey,
            'content-type': 'application/json',
            'origin': config.origin,
            'referer': config.referer,
            'user-agent': userAgent,
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'en-US,en;q=0.9',
            'sec-ch-ua': '"Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'cross-site',
            'cache-control': 'no-cache',
            'pragma': 'no-cache'
        }
    });
}

function createDiscordClient(token, proxy) {
    const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
    return axios.create({
        timeout: 30000,
        httpsAgent: agent,
        headers: {
            'Authorization': token,
            'Content-Type': 'application/json',
            'User-Agent': antiDetect.getRandomUA(),
            'X-Super-Properties': Buffer.from(JSON.stringify({
                os: 'Windows',
                browser: 'Chrome',
                device: '',
                system_locale: 'en-US',
                browser_user_agent: antiDetect.getRandomUA(),
                browser_version: '120.0.0.0',
                os_version: '10',
                referrer: '',
                referring_domain: '',
                referrer_current: '',
                referring_domain_current: '',
                release_channel: 'stable',
                client_build_number: 250000,
                client_event_source: null
            })).toString('base64')
        }
    });
}

// ============================================
// BLOCKCHAIN FUNCTIONS
// ============================================

async function getTokenBalance(wallet, tokenAddress) {
    try {
        const contract = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], wallet);
        return await contract.balanceOf(wallet.address);
    } catch { return ethers.BigNumber.from(0); }
}

async function getAllowance(wallet, tokenAddress, spender) {
    try {
        const contract = new ethers.Contract(tokenAddress, ['function allowance(address, address) view returns (uint256)'], wallet);
        return await contract.allowance(wallet.address, spender);
    } catch { return ethers.BigNumber.from(0); }
}

async function ensureApproval(wallet, tokenAddress, spender) {
    const minAllowance = ethers.utils.parseUnits("100000", 18);
    const allowance = await getAllowance(wallet, tokenAddress, spender);
    if (allowance.gte(minAllowance)) return true;

    try {
        const data = '0x095ea7b3' + '000000000000000000000000' + spender.slice(2).toLowerCase() + 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
        const gasPrice = (await provider.getGasPrice()).mul(110).div(100);
        const tx = await wallet.sendTransaction({ to: tokenAddress, data, gasLimit: 200000, gasPrice });
        await tx.wait();
        return true;
    } catch (e) {
        console.log(chalk.red(`⚠️ Approval Error: ${e.reason || e.message}`));
        return false;
    }
}

async function claimWebFaucet(wallet, tokenAddress, idx) {
    return await withRetry(async () => {
        const data = '0xb86d1d63000000000000000000000000' + wallet.address.slice(2).toLowerCase();
        await wallet.estimateGas({ to: tokenAddress, data });
        const tx = await wallet.sendTransaction({ to: tokenAddress, data, gasLimit: 200000, gasPrice: await provider.getGasPrice() });
        await tx.wait();
        return true;
    }, idx, 'webFaucet');
}

// Deposit to RLP Vault (/vault page)
async function depositVault(wallet, type, idx, amount = 550, isFixed = false) {
    const tokenAddr = type === 1 ? USDC_ADDR : USDT_ADDR;
    const tokenName = type === 1 ? 'tUSDC' : 'tUSDT';
    const decimals = type === 1 ? 6 : 18;

    const bal = await getTokenBalance(wallet, tokenAddr);
    const balFormatted = ethers.utils.formatUnits(bal, decimals);
    console.log(chalk.gray(`[Acc ${idx + 1}] ${tokenName} Balance: ${balFormatted}`));

    let depositAmount;

    if (isFixed) {
        depositAmount = ethers.utils.parseUnits(amount.toString(), decimals);
        if (bal.lt(depositAmount)) {
            console.log(chalk.yellow(`[Acc ${idx + 1}] Insufficient ${tokenName}: need ${amount}, have ${balFormatted}`));
            return { success: true, result: 'skip_insufficient' };
        }
    } else {
        const reserve = ethers.utils.parseUnits(amount.toString(), decimals);
        if (bal.lte(reserve)) {
            console.log(chalk.yellow(`[Acc ${idx + 1}] ${tokenName} balance too low for reserve`));
            return { success: true, result: 'skip' };
        }
        depositAmount = bal.sub(reserve);
    }

    const depositFormatted = ethers.utils.formatUnits(depositAmount, decimals);
    console.log(chalk.cyan(`[Acc ${idx + 1}] Depositing ${depositFormatted} ${tokenName} to RLP Vault...`));

    return await withRetry(async () => {
        const approved = await ensureApproval(wallet, tokenAddr, VAULT_ADDR);
        if (!approved) throw new Error('Approval failed');

        const selector = '0x68afada4';
        const typeHex = ethers.utils.hexZeroPad(ethers.BigNumber.from(type).toHexString(), 32).slice(2);
        const amountHex = ethers.utils.hexZeroPad(depositAmount.toHexString(), 32).slice(2);
        const lockHex = '0000000000000000000000000000000000000000000000000000000000000000';
        const data = selector + typeHex + amountHex + lockHex;

        console.log(chalk.gray(`[Acc ${idx + 1}] RLP Vault TX Data: type=${type}, amount=${depositFormatted}`));

        const gasPrice = (await provider.getGasPrice()).mul(110).div(100);
        const tx = await wallet.sendTransaction({ to: VAULT_ADDR, data, gasLimit: 500000, gasPrice });
        console.log(chalk.gray(`[Acc ${idx + 1}] TX Hash: ${tx.hash}`));

        const receipt = await tx.wait();
        console.log(chalk.green(`[Acc ${idx + 1}] ${tokenName} RLP Vault Deposit confirmed! Block: ${receipt.blockNumber}`));

        return true;
    }, idx, 'dailyTask');
}

// Deposit to LaaS Vault (/governance page) - THIS IS WHAT DAILY TASK VERIFICATION CHECKS
// LaaS Vault function: deposit(uint8 assetIdx, uint256 amount) where assetIdx: 0 = tUSDT, 1 = tUSDC
async function depositLaaSVault(wallet, assetIdx, idx, amount, isFixed = true) {
    // assetIdx: 0 = tUSDT, 1 = tUSDC (different from RLP Vault!)
    const tokenAddr = assetIdx === 1 ? USDC_ADDR : USDT_ADDR;
    const tokenName = assetIdx === 1 ? 'tUSDC' : 'tUSDT';
    const decimals = assetIdx === 1 ? 6 : 18;

    const bal = await getTokenBalance(wallet, tokenAddr);
    const balFormatted = ethers.utils.formatUnits(bal, decimals);
    console.log(chalk.gray(`[Acc ${idx + 1}] ${tokenName} Balance for LaaS: ${balFormatted}`));

    let depositAmount;

    if (isFixed) {
        depositAmount = ethers.utils.parseUnits(amount.toString(), decimals);
        if (bal.lt(depositAmount)) {
            console.log(chalk.yellow(`[Acc ${idx + 1}] Insufficient ${tokenName} for LaaS: need ${amount}, have ${balFormatted}`));
            return { success: true, result: 'skip_insufficient' };
        }
    } else {
        depositAmount = bal;
    }

    const depositFormatted = ethers.utils.formatUnits(depositAmount, decimals);
    console.log(chalk.cyan(`[Acc ${idx + 1}] Depositing ${depositFormatted} ${tokenName} to LaaS Vault (Governance)...`));

    return await withRetry(async () => {
        // Approve LaaS Vault
        const approved = await ensureApproval(wallet, tokenAddr, LAAS_VAULT_ADDR);
        if (!approved) throw new Error('LaaS Approval failed');

        // LaaS Vault deposit function: deposit(uint8 assetIdx, uint256 amount)
        // Function selector for deposit(uint8,uint256) = 0x47e7ef24 (need to verify)
        // Actually, let's use the interface approach
        const iface = new ethers.utils.Interface([
            'function deposit(uint8 assetIdx, uint256 amount)'
        ]);
        const data = iface.encodeFunctionData('deposit', [assetIdx, depositAmount]);

        console.log(chalk.gray(`[Acc ${idx + 1}] LaaS Vault TX: assetIdx=${assetIdx}, amount=${depositFormatted}`));

        const gasPrice = (await provider.getGasPrice()).mul(110).div(100);
        const tx = await wallet.sendTransaction({ to: LAAS_VAULT_ADDR, data, gasLimit: 500000, gasPrice });
        console.log(chalk.gray(`[Acc ${idx + 1}] LaaS TX Hash: ${tx.hash}`));

        const receipt = await tx.wait();
        console.log(chalk.green(`[Acc ${idx + 1}] ${tokenName} LaaS Vault Deposit confirmed! Block: ${receipt.blockNumber}`));

        return true;
    }, idx, 'dailyTask');
}

// ============================================
// DISCORD FAUCET
// ============================================

async function claimDiscordFaucet(account, idx) {
    if (!account.discordToken) {
        state[idx].discordFaucet = '❌NoTkn';
        return false;
    }

    state[idx].discordFaucet = '🔄';
    renderDashboard();

    const client = createDiscordClient(account.discordToken, account.proxy);
    let success = false;

    for (const faucet of config.faucets) {
        const result = await withRetry(async () => {
            await sleep(antiDetect.interactionDelay());

            const res = await client.get(`https://discord.com/api/v9/channels/${faucet.channelId}/messages?limit=10`);
            if (res.status !== 200) throw new Error(`Fetch failed: ${res.status}`);

            const msg = res.data.find(m =>
                m.author.id === config.discordAppId &&
                m.components?.some(row => row.components?.some(c => c.custom_id === faucet.customId))
            );

            if (!msg) throw new Error('Message not found');

            await sleep(antiDetect.interactionDelay());

            const nonce = ethers.BigNumber.from(Date.now()).mul(1000).toString();
            const payload = {
                type: 3,
                guild_id: config.discordGuildId,
                channel_id: faucet.channelId,
                message_id: msg.id,
                application_id: config.discordAppId,
                session_id: antiDetect.generateSessionId(),
                nonce,
                data: { component_type: 2, custom_id: faucet.customId }
            };

            const clickRes = await client.post('https://discord.com/api/v9/interactions', payload);
            if (clickRes.status === 204) return true;
            if (clickRes.status === 429) {
                const retryAfter = clickRes.data.retry_after || 60;
                await sleep(retryAfter * 1000);
                throw new Error('Rate limited');
            }
            throw new Error(`Click failed: ${clickRes.status}`);
        }, idx, 'discordFaucet');

        if (result.success) success = true;
        await randomSleep();
    }

    state[idx].discordFaucet = success ? '✅' : '❌';
    state[idx].lastDiscord = Date.now();
    return success;
}

// ============================================
// SHARED STATE FOR COLLABORATIVE QUIZ
// ============================================
const DAILY_QUIZ_STATE = {
    date: '',        // Format: YYYY-MM-DD
    answer: null,    // Correct answer if found
    failed: [],      // List of answers tried and failed
    quizData: null   // Cached quiz question data
};

function getQuizAnswerCandidate() {
    const today = new Date().toISOString().split('T')[0];

    // Reset if new day
    if (DAILY_QUIZ_STATE.date !== today) {
        DAILY_QUIZ_STATE.date = today;
        DAILY_QUIZ_STATE.answer = null;
        DAILY_QUIZ_STATE.failed = [];
        DAILY_QUIZ_STATE.quizData = null;
        console.log(chalk.magenta(`[QUIZ] New day detected (${today}). Resetting shared quiz memory.`));
    }

    // 1. If we know the answer, use it
    if (DAILY_QUIZ_STATE.answer !== null) {
        return { answer: DAILY_QUIZ_STATE.answer, source: 'known_correct' };
    }

    // 2. Quiz answers are typically 0-3 (for options A-D)
    const possibleAnswers = [0, 1, 2, 3];
    for (const candidate of possibleAnswers) {
        if (!DAILY_QUIZ_STATE.failed.includes(candidate)) {
            return { answer: candidate, source: 'guessing' };
        }
    }

    // All failed, try 0 again
    return { answer: 0, source: 'fallback' };
}

async function fetchDailyQuiz(client, addressLower) {
    try {
        // Try to get current quiz
        const res = await client.get(`/rest/v1/daily_quizzes?select=*&order=created_at.desc&limit=1`);
        if (res.data && res.data.length > 0) {
            DAILY_QUIZ_STATE.quizData = res.data[0];
            console.log(chalk.cyan(`[QUIZ] Today's Quiz: ${res.data[0].question || 'Unknown'}`));
            if (res.data[0].options) {
                console.log(chalk.gray(`[QUIZ] Options: ${JSON.stringify(res.data[0].options)}`));
            }
            return res.data[0];
        }
    } catch (e) {
        console.log(chalk.yellow(`[QUIZ] Could not fetch quiz data: ${e.message}`));
    }
    return null;
}

async function processDailyQuiz(account, idx) {
    state[idx].dailyQuiz = '🔄';
    renderDashboard();

    const client = createClient(account.proxy);
    const wallet = new ethers.Wallet(account.privateKey, provider);
    const addressLower = wallet.address.toLowerCase();

    // First, try to fetch quiz data
    if (!DAILY_QUIZ_STATE.quizData) {
        await fetchDailyQuiz(client, addressLower);
    }

    // Check if already completed
    try {
        const statusRes = await client.get(`/rest/v1/quiz_attempts?wallet_address=eq.${addressLower}&order=created_at.desc&limit=1`);
        if (statusRes.data && statusRes.data.length > 0) {
            const lastAttempt = statusRes.data[0];
            const today = new Date().toISOString().split('T')[0];
            if (lastAttempt.created_at?.startsWith(today) && lastAttempt.is_correct) {
                state[idx].dailyQuiz = '✅';
                console.log(chalk.green(`[Acc ${idx + 1}] Quiz already completed today!`));
                return { success: true, result: 'already_done' };
            }
        }
    } catch (e) {
        console.log(chalk.gray(`[Acc ${idx + 1}] Could not check quiz status: ${e.message}`));
    }

    // Try up to 2 attempts (as shown in UI: 2/2 left)
    for (let attempt = 0; attempt < 2; attempt++) {
        const { answer, source } = getQuizAnswerCandidate();

        console.log(chalk.cyan(`[Acc ${idx + 1}] Quiz Attempt ${attempt + 1}/2: ${source} -> Answer: ${answer}`));

        try {
            await sleep(antiDetect.requestJitter());

            const res = await client.post('/functions/v1/submit-quiz-answer', {
                wallet_address: addressLower,
                selected_answer: answer
            });

            console.log(chalk.gray(`[Acc ${idx + 1}] Quiz Response: ${JSON.stringify(res.data)}`));

            if (res.data?.correct === true || res.data?.is_correct === true) {
                state[idx].dailyQuiz = '✅';
                console.log(chalk.green(`[Acc ${idx + 1}] Quiz Correct! Answer: ${answer}`));

                // Save for others
                if (DAILY_QUIZ_STATE.answer === null) {
                    DAILY_QUIZ_STATE.answer = answer;
                    console.log(chalk.green.bold(`[QUIZ] FOUND CORRECT ANSWER: ${answer} (Shared with all accounts)`));
                }
                return { success: true, result: true };
            }

            // Wrong answer
            console.log(chalk.yellow(`[Acc ${idx + 1}] Quiz answer ${answer} incorrect.`));

            // Mark as failed so others don't try it
            if (!DAILY_QUIZ_STATE.failed.includes(answer)) {
                DAILY_QUIZ_STATE.failed.push(answer);
            }

            // Did API leak the correct answer?
            if (res.data?.correct_answer !== undefined) {
                DAILY_QUIZ_STATE.answer = res.data.correct_answer;
                console.log(chalk.magenta(`[QUIZ] API leaked correct answer: ${res.data.correct_answer}. Saved for others.`));
            }

            // Check remaining attempts
            if (res.data?.attempts_remaining === 0 || res.data?.attempts_left === 0) {
                console.log(chalk.red(`[Acc ${idx + 1}] No quiz attempts remaining.`));
                state[idx].dailyQuiz = '❌';
                return { success: false, error: 'No attempts left' };
            }

            await sleep(1000);

        } catch (e) {
            const errMsg = e.response?.data?.message || e.message || '';

            if (e.response?.status === 400 || errMsg.includes('400') || errMsg.includes('already') || errMsg.includes('completed')) {
                state[idx].dailyQuiz = '✅';
                console.log(chalk.green(`[Acc ${idx + 1}] Quiz already completed!`));
                return { success: true, result: 'already_done' };
            }

            if (errMsg.includes('No attempts') || errMsg.includes('limit')) {
                state[idx].dailyQuiz = '❌';
                console.log(chalk.red(`[Acc ${idx + 1}] Quiz: ${errMsg}`));
                return { success: false, error: errMsg };
            }

            console.log(chalk.red(`[Acc ${idx + 1}] Quiz error: ${errMsg}`));
        }
    }

    state[idx].dailyQuiz = '❌';
    return { success: false, error: 'All attempts failed' };
}

// ============================================
// DAILY TASKS
// ============================================

async function processDailyTasks(account, idx) {
    state[idx].dailyTask = '🔄';
    state[idx].webFaucet = '🔄';
    renderDashboard();

    const wallet = new ethers.Wallet(account.privateKey, provider);
    const client = createClient(account.proxy);
    const addressLower = wallet.address.toLowerCase();

    // 1. Fetch current points & streak
    try {
        const [profileRes, streakRes] = await Promise.all([
            client.get(`/rest/v1/user_profiles_public?select=total_liq_earned&wallet_address=eq.${addressLower}`),
            client.get(`/rest/v1/user_streaks_public?select=current_streak&wallet_address=eq.${addressLower}`)
        ]);
        if (profileRes.data?.[0]) state[idx].points = profileRes.data[0].total_liq_earned;
        if (streakRes.data?.[0]) state[idx].streak = streakRes.data[0].current_streak;
    } catch { }
    renderDashboard();

    // 2. Web Faucet Claims
    const usdcResult = await claimWebFaucet(wallet, USDC_ADDR, idx);
    await randomSleep();
    const usdtResult = await claimWebFaucet(wallet, USDT_ADDR, idx);

    state[idx].webFaucet = (usdcResult.success || usdtResult.success) ? '✅' : '⏳CD';
    renderDashboard();

    // 3. Daily Check-in
    const checkinResult = await withRetry(async () => {
        const res = await client.post('/functions/v1/verify-deposit-task', {
            wallet_address: addressLower,
            task_id: 'daily-checkin',
            token_type: null
        });
        console.log(chalk.gray(`[Acc ${idx + 1}] Check-in response: ${JSON.stringify(res.data)}`));
        if (res.data?.verified || res.data?.message?.includes('already')) return true;
        throw new Error(res.data?.message || 'Not verified');
    }, idx, 'dailyTask');

    await randomSleep();

    // ========== STEP 4: Deposit to RLP Vault (/vault) - THIS IS FOR DAILY TASK VERIFICATION ==========
    // Based on verify.har: task_id = "daily-deposit-tusdt-1000" and "daily-deposit-tusdc-1000"
    // These tasks verify deposits to the RLP Vault, NOT LaaS Vault

    console.log(chalk.cyan(`[Acc ${idx + 1}] === Depositing to RLP Vault (/vault) for Daily Task ==="`));

    // Deposit 1000 tUSDC to RLP Vault (type = 1)
    console.log(chalk.cyan(`[Acc ${idx + 1}] Depositing 1000 tUSDC to RLP Vault...`));
    const usdcDepositResult = await depositVault(wallet, 1, idx, 1000, true);
    console.log(chalk.gray(`[Acc ${idx + 1}] USDC Deposit result: ${JSON.stringify(usdcDepositResult)}`));

    if (usdcDepositResult.success && usdcDepositResult.result !== 'skip_insufficient') {
        await sleep(5000); // Wait for blockchain confirmation

        // Verify USDC deposit with correct task_id
        const verifyUsdcResult = await withRetry(async () => {
            const res = await client.post('/functions/v1/verify-deposit-task', {
                wallet_address: addressLower,
                task_id: 'daily-deposit-tusdc-1000',
                token_type: 'tusdc'
            });
            console.log(chalk.gray(`[Acc ${idx + 1}] USDC Verify response: ${JSON.stringify(res.data)}`));
            if (res.data?.verified || res.data?.success || res.data?.message?.includes('already')) return true;
            throw new Error(res.data?.message || 'USDC verification failed');
        }, idx, 'dailyTask');
        console.log(chalk.green(`[Acc ${idx + 1}] USDC deposit verified: ${verifyUsdcResult.success}`));
    } else {
        console.log(chalk.yellow(`[Acc ${idx + 1}] USDC deposit skipped (insufficient balance)`));
    }

    await randomSleep();

    // Deposit 1000 tUSDT to RLP Vault (type = 0)
    console.log(chalk.cyan(`[Acc ${idx + 1}] Depositing 1000 tUSDT to RLP Vault...`));
    const usdtDepositResult = await depositVault(wallet, 0, idx, 1000, true);
    console.log(chalk.gray(`[Acc ${idx + 1}] USDT Deposit result: ${JSON.stringify(usdtDepositResult)}`));

    if (usdtDepositResult.success && usdtDepositResult.result !== 'skip_insufficient') {
        await sleep(5000); // Wait for blockchain confirmation

        // Verify USDT deposit with correct task_id
        const verifyUsdtResult = await withRetry(async () => {
            const res = await client.post('/functions/v1/verify-deposit-task', {
                wallet_address: addressLower,
                task_id: 'daily-deposit-tusdt-1000',
                token_type: 'tusdt'
            });
            console.log(chalk.gray(`[Acc ${idx + 1}] USDT Verify response: ${JSON.stringify(res.data)}`));
            if (res.data?.verified || res.data?.success || res.data?.message?.includes('already')) return true;
            throw new Error(res.data?.message || 'USDT verification failed');
        }, idx, 'dailyTask');
        console.log(chalk.green(`[Acc ${idx + 1}] USDT deposit verified: ${verifyUsdtResult.success}`));
    } else {
        console.log(chalk.yellow(`[Acc ${idx + 1}] USDT deposit skipped (insufficient balance)`));
    }

    await randomSleep();

    // ========== STEP 5: Deposit to LaaS Vault (/governance) - ADDITIONAL DAILY TASK ==========
    // Based on verify.har: task_id = "daily-laas-deposit-tusdt" and "daily-laas-deposit-tusdc"
    // LaaS Vault requires: 500 tUSDC and 500 tUSDT for daily task

    console.log(chalk.cyan(`[Acc ${idx + 1}] === Depositing to LaaS Vault (/governance) for Daily Task ==="`));

    // Deposit 500 tUSDC to LaaS Vault (assetIdx = 1)
    console.log(chalk.cyan(`[Acc ${idx + 1}] Depositing 500 tUSDC to LaaS Vault...`));
    const laasUsdcResult = await depositLaaSVault(wallet, 1, idx, 500, true);
    console.log(chalk.gray(`[Acc ${idx + 1}] LaaS USDC Deposit result: ${JSON.stringify(laasUsdcResult)}`));

    if (laasUsdcResult.success && laasUsdcResult.result !== 'skip_insufficient') {
        await sleep(5000); // Wait for blockchain confirmation

        // Verify LaaS USDC deposit
        const verifyLaasUsdcResult = await withRetry(async () => {
            const res = await client.post('/functions/v1/verify-deposit-task', {
                wallet_address: addressLower,
                task_id: 'daily-laas-deposit-tusdc',
                token_type: 'tusdc'
            });
            console.log(chalk.gray(`[Acc ${idx + 1}] LaaS USDC Verify response: ${JSON.stringify(res.data)}`));
            if (res.data?.verified || res.data?.success || res.data?.message?.includes('already')) return true;
            throw new Error(res.data?.message || 'LaaS USDC verification failed');
        }, idx, 'dailyTask');
        console.log(chalk.green(`[Acc ${idx + 1}] LaaS USDC deposit verified: ${verifyLaasUsdcResult.success}`));
    } else {
        console.log(chalk.yellow(`[Acc ${idx + 1}] LaaS USDC deposit skipped (insufficient balance)`));
    }

    await randomSleep();

    // Deposit 500 tUSDT to LaaS Vault (assetIdx = 0)
    console.log(chalk.cyan(`[Acc ${idx + 1}] Depositing 500 tUSDT to LaaS Vault...`));
    const laasUsdtResult = await depositLaaSVault(wallet, 0, idx, 500, true);
    console.log(chalk.gray(`[Acc ${idx + 1}] LaaS USDT Deposit result: ${JSON.stringify(laasUsdtResult)}`));

    if (laasUsdtResult.success && laasUsdtResult.result !== 'skip_insufficient') {
        await sleep(5000); // Wait for blockchain confirmation

        // Verify LaaS USDT deposit
        const verifyLaasUsdtResult = await withRetry(async () => {
            const res = await client.post('/functions/v1/verify-deposit-task', {
                wallet_address: addressLower,
                task_id: 'daily-laas-deposit-tusdt',
                token_type: 'tusdt'
            });
            console.log(chalk.gray(`[Acc ${idx + 1}] LaaS USDT Verify response: ${JSON.stringify(res.data)}`));
            if (res.data?.verified || res.data?.success || res.data?.message?.includes('already')) return true;
            throw new Error(res.data?.message || 'LaaS USDT verification failed');
        }, idx, 'dailyTask');
        console.log(chalk.green(`[Acc ${idx + 1}] LaaS USDT deposit verified: ${verifyLaasUsdtResult.success}`));
    } else {
        console.log(chalk.yellow(`[Acc ${idx + 1}] LaaS USDT deposit skipped (insufficient balance)`));
    }

    await randomSleep();

    // 6. Verify duel task (if applicable)
    await withRetry(async () => {
        const res = await client.post('/functions/v1/verify-onchain-task', {
            wallet_address: addressLower,
            task_id: 'daily-duel-create'
        });
        console.log(chalk.gray(`[Acc ${idx + 1}] Duel task verify: ${JSON.stringify(res.data)}`));
        return res.data?.verified;
    }, idx, 'dailyTask');
    await randomSleep();

    // 6. Daily Quiz
    await processDailyQuiz(account, idx);
    await randomSleep();

    // 7. Final status fetch
    try {
        const [profileRes, streakRes] = await Promise.all([
            client.get(`/rest/v1/user_profiles_public?select=total_liq_earned&wallet_address=eq.${addressLower}`),
            client.get(`/rest/v1/user_streaks_public?select=current_streak&wallet_address=eq.${addressLower}`)
        ]);
        if (profileRes.data?.[0]) state[idx].points = profileRes.data[0].total_liq_earned;
        if (streakRes.data?.[0]) state[idx].streak = streakRes.data[0].current_streak;
    } catch { }

    state[idx].dailyTask = checkinResult.success ? '✅' : '❌';
    state[idx].lastDaily = Date.now();
}

// ============================================
// DUEL FUNCTIONS
// ============================================

async function getOpenDuels(wallet) {
    try {
        const contract = new ethers.Contract(DUEL_ADDR, DUEL_ABI, wallet);
        const duels = await contract.getOpenDuels();
        return duels
            .filter(d => d.challenger.toLowerCase() !== wallet.address.toLowerCase())
            .map(d => ({
                id: d.id.toNumber(),
                challenger: d.challenger,
                opponent: d.opponent,
                wagerAmount: d.wagerAmount,
                wagerToken: d.wagerToken,
                duelType: d.duelType,
                status: d.status
            }));
    } catch { return []; }
}

async function getDuelById(wallet, duelId) {
    try {
        const contract = new ethers.Contract(DUEL_ADDR, DUEL_ABI, wallet);
        const duel = await contract.getDuel(duelId);
        if (!duel.challenger || duel.challenger === ethers.constants.AddressZero) return null;
        return {
            id: duel.id.toNumber(),
            challenger: duel.challenger,
            opponent: duel.opponent,
            wagerAmount: duel.wagerAmount,
            wagerToken: duel.wagerToken,
            duelType: duel.duelType,
            status: duel.status,
            winner: duel.winner,
            prizeClaimed: duel.prizeClaimed
        };
    } catch { return null; }
}

async function findClaimableDuels(wallet) {
    try {
        const contract = new ethers.Contract(DUEL_ADDR, DUEL_ABI, wallet);
        const userDuelIds = await contract.getUserDuels(wallet.address);
        const claimable = [];

        for (const duelIdBN of userDuelIds.slice(-20)) {
            const duel = await getDuelById(wallet, duelIdBN.toNumber());
            if (duel && duel.status === DUEL_STATUS.RESOLVED &&
                duel.winner.toLowerCase() === wallet.address.toLowerCase() &&
                !duel.prizeClaimed) {
                claimable.push(duel);
            }
        }
        return claimable;
    } catch { return []; }
}

async function processDuel(account, idx) {
    state[idx].duelStatus = '🔄';
    renderDashboard();

    const wallet = new ethers.Wallet(account.privateKey, provider);
    const client = createClient(account.proxy);
    const addressLower = wallet.address.toLowerCase();

    // 0. CHECK IF DUEL IS ENABLED
    if (account.duelEnabled === false) {
        state[idx].duelStatus = '⛔ Off';
        return;
    }

    // 0.1 CHECK V2 LIMITS & VOLUME
    const now = Date.now();
    const today = new Date().setHours(0, 0, 0, 0);

    // Filter history for current day
    state[idx].duelHistory = state[idx].duelHistory.filter(h => h.timestamp > today);
    state[idx].dailyDuelCount = state[idx].duelHistory.length;

    const isLimitReached = state[idx].dailyDuelCount >= DAILY_DUEL_LIMIT;

    if (isLimitReached) {
        state[idx].duelStatus = '✅Limit';
        state[idx].nextDuel = getNextDailySchedule();
        console.log(chalk.green(`[Acc ${idx + 1}] 🏁 Daily Target Reached! (Duels: ${state[idx].dailyDuelCount}/1)`));
        return;
    }

    // Rate Limit Check (Max 3 in 2 mins)
    const recentDuels = state[idx].duelHistory.filter(h => now - h.timestamp < RATE_LIMIT_WINDOW);
    if (recentDuels.length >= RATE_LIMIT_DUELS) {
        state[idx].duelStatus = '⏳Rate';
        state[idx].nextDuel = new Date(Date.now() + RATE_LIMIT_WINDOW);
        return;
    }

    // 1. Claim any pending prizes
    const claimable = await findClaimableDuels(wallet);
    for (const duel of claimable) {
        await withRetry(async () => {
            const iface = new ethers.utils.Interface(DUEL_ABI);
            const data = iface.encodeFunctionData('claimPrize', [duel.id]);
            const gasPrice = (await provider.getGasPrice()).mul(110).div(100);
            const tx = await wallet.sendTransaction({ to: DUEL_ADDR, data, gasLimit: 500000, gasPrice });
            await tx.wait();
            return true;
        }, idx, 'duelStatus');
        await randomSleep();
    }

    // NEW STRATEGY: Try to Join 3x -> If fail, Create 1x (with 3 retries)
    console.log(chalk.cyan(`[Acc ${idx + 1}] ⚔️ Daily Duel Strategy: Try Join 3x -> Fallback Create...`));

    let duelCompleted = false;
    let joinAttempts = 0;
    const MAX_JOIN_ATTEMPTS = 3;

    // A. TRY TO JOIN EXISTING DUELS
    const openDuels = await getOpenDuels(wallet);
    console.log(chalk.gray(`[Acc ${idx + 1}] 🔍 Found ${openDuels.length} open duels`));

    // Sort by lowest wager first
    openDuels.sort((a, b) => {
        const aDecimals = a.wagerToken.toLowerCase() === USDC_ADDR.toLowerCase() ? 6 : 18;
        const bDecimals = b.wagerToken.toLowerCase() === USDC_ADDR.toLowerCase() ? 6 : 18;
        const aAmt = parseFloat(ethers.utils.formatUnits(a.wagerAmount, aDecimals));
        const bAmt = parseFloat(ethers.utils.formatUnits(b.wagerAmount, bDecimals));
        return aAmt - bAmt;
    });

    for (const duel of openDuels) {
        if (duelCompleted) break;
        if (joinAttempts >= MAX_JOIN_ATTEMPTS) {
            console.log(chalk.yellow(`[Acc ${idx + 1}] ⚠️ Reached max join attempts (${MAX_JOIN_ATTEMPTS}). Switching to Create Mode...`));
            break;
        }

        const isUSDC = duel.wagerToken.toLowerCase() === USDC_ADDR.toLowerCase();
        const tokenAddr = isUSDC ? USDC_ADDR : USDT_ADDR;
        const decimals = isUSDC ? 6 : 18;
        const amount = parseFloat(ethers.utils.formatUnits(duel.wagerAmount, decimals));

        if (amount > 500) continue;

        const balance = await getTokenBalance(wallet, tokenAddr);
        if (balance.lt(duel.wagerAmount)) {
            console.log(chalk.yellow(`[Acc ${idx + 1}] ⚠️ Insufficient balance to join duel #${duel.id} (${amount} ${isUSDC ? 'USDC' : 'USDT'}).`));
            continue;
        }

        const opponentCount = state[idx].duelHistory.filter(h => h.opponent.toLowerCase() === duel.challenger.toLowerCase()).length;
        if (opponentCount >= SAME_OPPONENT_LIMIT) continue;

        console.log(chalk.cyan(`[Acc ${idx + 1}] 🎯 Attempting join duel #${duel.id} (${amount} ${isUSDC ? 'USDC' : 'USDT'})...`));
        joinAttempts++;

        const result = await withRetry(async () => {
            const approved = await ensureApproval(wallet, tokenAddr, DUEL_ADDR);
            if (!approved) throw new Error('Approval failed');
            const iface = new ethers.utils.Interface(DUEL_ABI);
            const data = iface.encodeFunctionData('acceptDuel', [duel.id]);

            // Simulate first to avoid failed transactions (CALL_EXCEPTION)
            try {
                const contract = new ethers.Contract(DUEL_ADDR, DUEL_ABI, wallet);
                await contract.callStatic.acceptDuel(duel.id);
            } catch (simError) {
                console.log(chalk.yellow(`[Acc ${idx + 1}] ⚠️ Join Simulation failed for duel #${duel.id} (Likely taken or Daily Limit Reached).`));
                return false; // Skip this duel
            }

            const gasPrice = (await provider.getGasPrice()).mul(110).div(100);
            try {
                const tx = await wallet.sendTransaction({ to: DUEL_ADDR, data, gasLimit: 1000000, gasPrice });
                await tx.wait();
                return true;
            } catch (txError) {
                console.log(chalk.red(`[Acc ${idx + 1}] ❌ Duel Join TX Failed: ${txError.reason || txError.message}`));
                throw txError;
            }
        }, idx, 'duelStatus');

        if (result.success && result.result === true) {
            duelCompleted = true;
            state[idx].duelHistory.push({ timestamp: Date.now(), opponent: duel.challenger, amount: amount });
            console.log(chalk.green(`[Acc ${idx + 1}] ✅ Duel accepted! Waiting for resolution...`));
        }
    }

    // B. FALLBACK: CREATE DUEL if not completed
    if (!duelCompleted) {
        if (openDuels.length > 0 && joinAttempts < MAX_JOIN_ATTEMPTS) {
            // We didn't try enough joins yet, but loop finished? (Maybe filtered out?)
            // Just fallthrough to create.
        }

        console.log(chalk.cyan(`[Acc ${idx + 1}] 🆕 Switching to CREATE DUEL Mode (Fallback)...`));

        const useUSDC = Math.random() < 0.5;
        const tokenAddr = useUSDC ? USDC_ADDR : USDT_ADDR;
        const decimals = useUSDC ? 6 : 18;
        const balance = await getTokenBalance(wallet, tokenAddr);
        const minWager = ethers.utils.parseUnits("400", decimals);

        if (balance.gte(minWager)) {
            // Retry loop for Creation
            for (let createAttempt = 1; createAttempt <= 3; createAttempt++) {
                if (duelCompleted) break;

                const rawAmount = randomDelay(400, 450);
                const wagerAmount = ethers.utils.parseUnits(rawAmount.toString(), decimals);

                console.log(chalk.cyan(`[Acc ${idx + 1}] 🗡️ Creating duel (Attempt ${createAttempt}/3) - ${rawAmount} ${useUSDC ? 'USDC' : 'USDT'}...`));

                const result = await withRetry(async () => {
                    const approved = await ensureApproval(wallet, tokenAddr, DUEL_ADDR);
                    if (!approved) throw new Error('Approval failed');
                    const iface = new ethers.utils.Interface(DUEL_ABI);
                    const data = iface.encodeFunctionData('createDuel', [wagerAmount, tokenAddr, 0]);

                    // Simulate first to avoid failed transactions (CALL_EXCEPTION)
                    try {
                        const contract = new ethers.Contract(DUEL_ADDR, DUEL_ABI, wallet);
                        await contract.callStatic.createDuel(wagerAmount, tokenAddr, 0);
                    } catch (simError) {
                        console.log(chalk.red(`[Acc ${idx + 1}] ⚠️ Create Simulation failed (Likely Daily Limit Reached). Stopping...`));
                        return 'SIMULATION_FAILED'; // Special return to break loop
                    }

                    const gasPrice = (await provider.getGasPrice()).mul(110).div(100);

                    try {
                        const tx = await wallet.sendTransaction({ to: DUEL_ADDR, data, gasLimit: 1000000, gasPrice });
                        await tx.wait();
                        return true;
                    } catch (txError) {
                        console.log(chalk.red(`[Acc ${idx + 1}] ❌ Create TX Failed: ${txError.reason || txError.message}`));
                        throw txError;
                    }
                }, idx, 'duelStatus');

                if (result === 'SIMULATION_FAILED') {
                    state[idx].duelStatus = '✅Limit';
                    duelCompleted = false;
                    break; // Stop retrying
                }

                if (result && result.success && result.result === true) {
                    duelCompleted = true;
                    state[idx].duelHistory.push({ timestamp: Date.now(), opponent: 'unknown_created', amount: rawAmount });
                    console.log(chalk.green(`[Acc ${idx + 1}] ✅ Duel created! Waiting for opponent...`));
                } else {
                    await sleep(3000); // Wait before retry
                }
            }
        } else {
            console.log(chalk.yellow(`[Acc ${idx + 1}] ⚠️ Insufficient balance to create duel (Needed: ~400 ${useUSDC ? 'USDC' : 'USDT'}).`));
        }
    }

    // Log daily summary
    console.log(chalk.gray(`[Acc ${idx + 1}] 📅 Daily duel result: ${duelCompleted ? 'Success' : 'Failed'}`));

    const { dailyDuelCount } = state[idx];
    // Recheck limits after actions
    if (dailyDuelCount >= DAILY_DUEL_LIMIT) {
        state[idx].duelStatus = '✅Limit';
        state[idx].nextDuel = getNextDailySchedule();
        return;
    }

    // If we failed everything, set a delay and return (skip to next account logic handled by loop)
    if (!duelCompleted) {
        state[idx].duelStatus = '❌Fail';
        state[idx].nextDuel = new Date(Date.now() + 4 * 60 * 60 * 1000); // Retry in 4 hours if failed
        console.log(chalk.yellow(`[Acc ${idx + 1}] ⏳ Duel failed today. Retrying in 4 hours.`));
        return;
    }

    // 3. Deposit max
    const reserve = randomDelay(100, 500);
    await depositVault(wallet, 1, idx, reserve);
    await depositVault(wallet, 0, idx, reserve);

    // 4. Verify duel task
    await withRetry(async () => {
        const res = await client.post('/functions/v1/verify-onchain-task', {
            wallet_address: addressLower,
            task_id: 'daily-duelist'
        });
        return res.data?.verified;
    }, idx, 'duelStatus');

    state[idx].duelStatus = '✅';
    state[idx].lastDuel = Date.now();
    state[idx].nextDuel = new Date(Date.now() + randomDelay(10000, 30000));
}

// ============================================
// STATE SYNC
// ============================================

async function syncDailyStats(account, idx) {
    state[idx].duelStatus = '🔄Sync';
    renderDashboard();

    const wallet = new ethers.Wallet(account.privateKey, provider);
    const today = new Date().setHours(0, 0, 0, 0);

    try {
        const contract = new ethers.Contract(DUEL_ADDR, DUEL_ABI, wallet);
        const userDuelIds = await contract.getUserDuels(wallet.address);

        // Check last 20 duels (simpler than fetching all)
        const recentIds = userDuelIds.slice(-20);
        const history = [];

        for (const idBN of recentIds) {
            const duel = await getDuelById(wallet, idBN.toNumber());
            if (duel && duel.createdAt * 1000 > today) {
                // Determine amount in USD (approx)
                const isUSDC = duel.wagerToken.toLowerCase() === USDC_ADDR.toLowerCase();
                const decimals = isUSDC ? 6 : 18;
                const amount = parseFloat(ethers.utils.formatUnits(duel.wagerAmount, decimals));

                history.push({
                    timestamp: duel.createdAt * 1000,
                    opponent: duel.opponent.toLowerCase() === wallet.address.toLowerCase() ? duel.challenger : duel.opponent,
                    amount: amount
                });
            }
        }

        state[idx].duelHistory = history;
        state[idx].dailyDuelCount = history.length;

        const isLimitReached = state[idx].dailyDuelCount >= DAILY_DUEL_LIMIT;

        state[idx].duelStatus = isLimitReached ? '✅Limit' : '⏳';

        if (state[idx].duelStatus.startsWith('✅')) {
            state[idx].nextDuel = getNextDailySchedule();
        }

        console.log(chalk.blue(`[Acc ${idx + 1}] 🔄 Synced: ${state[idx].dailyDuelCount} duels.`));

    } catch (e) {
        console.log(chalk.red(`[Acc ${idx + 1}] ❌ Sync Failed: ${e.message}`));
    }
}

// ============================================
// MAIN LOOP
// ============================================

async function main() {
    // Initialize State
    accounts.forEach((_, i) => {
        state[i] = createState(i);
        state[i].nextDaily = new Date(Date.now() - 60000); // Force check
        state[i].nextDuel = new Date(Date.now() + randomDelay(5000, 30000));
    });

    renderDashboard();

    // Initial Sync
    console.log(chalk.yellow('🔄 Syncing daily stats from blockchain...'));
    for (let i = 0; i < accounts.length; i++) {
        await syncDailyStats(accounts[i], i);
    }
    console.log(chalk.green('✅ Sync complete. Starting main loop...'));
    await sleep(2000);

    renderDashboard();

    while (true) {
        const now = Date.now();

        for (let i = 0; i < accounts.length; i++) {
            const acc = accounts[i];
            const s = state[i];

            if (s.isProcessing) continue;

            // 1. DAILY TASKS + WEB FAUCET (21:00 WIB)
            if (s.nextDaily && now >= s.nextDaily.getTime()) {
                s.isProcessing = true;
                try {
                    await processDailyTasks(acc, i);
                } catch (e) {
                    logError(i, `Daily: ${e.message?.slice(0, 50)}`);
                    s.dailyTask = '❌';
                }
                s.isProcessing = false;
                s.nextDaily = getNextDailySchedule();
                renderDashboard();
            }

            // 2. DISCORD FAUCET (every 30 minutes)
            const discordDue = s.lastDiscord === 0 || (now - s.lastDiscord >= config.discordInterval);
            if (acc.discordToken && discordDue && !s.isProcessing) {
                s.isProcessing = true;
                try {
                    await claimDiscordFaucet(acc, i);
                } catch (e) {
                    logError(i, `Discord: ${e.message?.slice(0, 50)}`);
                    s.discordFaucet = '❌';
                }
                s.isProcessing = false;
                renderDashboard();
            }

            // 3. DUEL (random 1-5 minutes)
            if (s.nextDuel && now >= s.nextDuel.getTime() && !s.isProcessing) {
                s.isProcessing = true;
                try {
                    await processDuel(acc, i);
                } catch (e) {
                    logError(i, `Duel: ${e.message?.slice(0, 50)}`);
                    s.duelStatus = '❌';
                }
                s.isProcessing = false;
                renderDashboard();
            }
        }

        renderDashboard();
        await sleep(1000);
    }
}

process.on('SIGINT', () => {
    clearScreen();
    console.log(chalk.yellow('\n👋 Bot stopped gracefully. Goodbye!'));
    process.exit(0);
});

main().catch(e => {
    console.error(chalk.red('Fatal error:'), e);
    process.exit(1);
});
