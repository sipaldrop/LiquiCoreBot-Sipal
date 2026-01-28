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
    dailyHour: 16,        // 16:00 WIB (4 PM)
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
const VAULT_ADDR = '0x11e4e6cD5D9E60646219098d99CfaFd130cdcE93';
const DUEL_ADDR = '0xe85a13581bFa506F4A1E903312E13842f1863c1f'; // V2 Contract

// V2 LIMITS
const DAILY_DUEL_LIMIT = 10;
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
    duelHistory: [], // Array of { timestamp, opponent }
    dailyDuelCount: 0
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

async function depositVault(wallet, type, idx, reserveAmount = 550) {
    const tokenAddr = type === 1 ? USDC_ADDR : USDT_ADDR;
    const decimals = type === 1 ? 6 : 18;
    const buffer = ethers.utils.parseUnits(reserveAmount.toString(), decimals);

    const bal = await getTokenBalance(wallet, tokenAddr);
    if (bal.lte(buffer)) return { success: true, result: 'skip' };

    const depositAmount = bal.sub(buffer);

    return await withRetry(async () => {
        const approved = await ensureApproval(wallet, tokenAddr, VAULT_ADDR);
        if (!approved) throw new Error('Approval failed');

        const selector = '0x68afada4';
        const typeHex = ethers.utils.hexZeroPad(ethers.BigNumber.from(type).toHexString(), 32).slice(2);
        const amountHex = ethers.utils.hexZeroPad(depositAmount.toHexString(), 32).slice(2);
        const lockHex = '0000000000000000000000000000000000000000000000000000000000000000';
        const data = selector + typeHex + amountHex + lockHex;

        const gasPrice = (await provider.getGasPrice()).mul(110).div(100);
        const tx = await wallet.sendTransaction({ to: VAULT_ADDR, data, gasLimit: 500000, gasPrice });
        await tx.wait();
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
    failed: []       // List of answers tried and failed
};

function getQuizAnswerCandidate() {
    const today = new Date().toISOString().split('T')[0];

    // Reset if new day
    if (DAILY_QUIZ_STATE.date !== today) {
        DAILY_QUIZ_STATE.date = today;
        DAILY_QUIZ_STATE.answer = null;
        DAILY_QUIZ_STATE.failed = [];
        console.log(chalk.magenta(`[QUIZ] New day detected (${today}). Resetting shared quiz memory.`));
    }

    // 1. If we know the answer, use it
    if (DAILY_QUIZ_STATE.answer) {
        return { answer: DAILY_QUIZ_STATE.answer, source: 'known_correct' };
    }

    // 2. Find first integer not in failed list
    let candidate = 1;
    while (DAILY_QUIZ_STATE.failed.includes(candidate)) {
        candidate++;
    }
    return { answer: candidate, source: 'guessing' };
}

async function processDailyQuiz(account, idx) {
    state[idx].dailyQuiz = '🔄';
    renderDashboard();

    const client = createClient(account.proxy);
    const wallet = new ethers.Wallet(account.privateKey, provider);
    const addressLower = wallet.address.toLowerCase();

    return await withRetry(async () => {
        const { answer, source } = getQuizAnswerCandidate();

        console.log(chalk.cyan(`[Acc ${idx + 1}] 🧠 Quiz Strategy: ${source === 'known_correct' ? 'Using known answer' : 'Collaborative guessing'} -> ${answer}`));

        try {
            const res = await client.post('/functions/v1/submit-quiz-answer', {
                wallet_address: addressLower,
                selected_answer: answer
            });

            if (res.data?.correct) {
                state[idx].dailyQuiz = '✅';
                console.log(chalk.green(`[Acc ${idx + 1}] Quiz Correct! Answer: ${answer}`));

                // Save for others
                if (!DAILY_QUIZ_STATE.answer) {
                    DAILY_QUIZ_STATE.answer = answer;
                    console.log(chalk.green.bold(`[QUIZ] 🎯 FOUND CORRECT ANSWER: ${answer} (Shared with all accounts)`));
                }
                return true;
            }

            // If we are here, it was WRONG (or API error handled below)
            console.log(chalk.yellow(`[Acc ${idx + 1}] Quiz answer ${answer} incorrect.`));

            // Mark as failed so others don't try it
            if (!DAILY_QUIZ_STATE.failed.includes(answer)) {
                DAILY_QUIZ_STATE.failed.push(answer);
            }

            // Did API leak the correct answer?
            if (res.data?.correct_answer) {
                DAILY_QUIZ_STATE.answer = res.data.correct_answer;
                console.log(chalk.magenta(`[QUIZ] 🕵️ API leaked correct answer: ${res.data.correct_answer}. Saved for others.`));
            }

            // Strict 1-shot (unless API says attempts_used < max)
            if (res.data?.attempts_used < res.data?.max_attempts) {
                throw new Error('Retrying with next guess...');
            }

            throw new Error(res.data?.message || 'Quiz failed');

        } catch (e) {
            if (e.response?.data?.message?.includes('already') || e.message?.includes('already')) {
                state[idx].dailyQuiz = '✅';
                return true;
            }
            throw e;
        }
    }, idx, 'dailyQuiz');
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
        if (res.data?.verified || res.data?.message?.includes('already')) return true;
        throw new Error(res.data?.message || 'Not verified');
    }, idx, 'dailyTask');

    await randomSleep();

    // 4. Deposit to Vault
    await depositVault(wallet, 1, idx);
    await randomSleep();
    await depositVault(wallet, 0, idx);
    await randomSleep();

    // 5. Verify deposit tasks
    for (const task of [
        { id: 'daily-deposit-tusdc-1000', type: 'tusdc' },
        { id: 'daily-deposit-tusdt-1000', type: 'tusdt' }
    ]) {
        await withRetry(async () => {
            const res = await client.post('/functions/v1/verify-deposit-task', {
                wallet_address: addressLower,
                task_id: task.id,
                token_type: task.type
            });
            return res.data?.verified;
        }, idx, 'dailyTask');
        await randomSleep();
    }

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

    // 0. CHECK V2 LIMITS
    const now = Date.now();
    // Filter history for current day
    const today = new Date().setHours(0, 0, 0, 0);
    state[idx].duelHistory = state[idx].duelHistory.filter(h => h.timestamp > today);
    state[idx].dailyDuelCount = state[idx].duelHistory.length;

    if (state[idx].dailyDuelCount >= DAILY_DUEL_LIMIT) {
        state[idx].duelStatus = '✅Limit';
        state[idx].nextDuel = getNextDailySchedule();
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
            const tx = await wallet.sendTransaction({ to: DUEL_ADDR, data, gasLimit: 500000, gasPrice }); // 500k is enough for claim
            await tx.wait();
            return true;
        }, idx, 'duelStatus');
        await randomSleep();
    }

    // 2. Try to accept or create duels (Run 3x)
    for (let i = 0; i < 3; i++) {
        console.log(chalk.cyan(`[Acc ${idx + 1}] ⚔️ Executing Duel Logic Iteration ${i + 1}/3...`));

        // Re-check rate limit inside loop
        if (state[idx].duelHistory.filter(h => Date.now() - h.timestamp < RATE_LIMIT_WINDOW).length >= RATE_LIMIT_DUELS) {
            console.log(chalk.yellow(`[Acc ${idx + 1}] ⏳ Rate limit reached, skipping iteration.`));
            break;
        }

        let processed = false;

        // Try to accept open duels (Limit to < $500 to avoid whales/instant limit hit)
        const openDuels = await getOpenDuels(wallet);
        console.log(chalk.gray(`[Acc ${idx + 1}] 🔍 Found ${openDuels.length} open duels`));

        openDuels.sort((a, b) => {
            const aDecimals = a.wagerToken.toLowerCase() === USDC_ADDR.toLowerCase() ? 6 : 18;
            const bDecimals = b.wagerToken.toLowerCase() === USDC_ADDR.toLowerCase() ? 6 : 18;
            const aAmt = parseFloat(ethers.utils.formatUnits(a.wagerAmount, aDecimals));
            const bAmt = parseFloat(ethers.utils.formatUnits(b.wagerAmount, bDecimals));
            return aAmt - bAmt;
        });

        for (const duel of openDuels) {
            const isUSDC = duel.wagerToken.toLowerCase() === USDC_ADDR.toLowerCase();
            const tokenAddr = isUSDC ? USDC_ADDR : USDT_ADDR;
            const decimals = isUSDC ? 6 : 18;
            const amount = parseFloat(ethers.utils.formatUnits(duel.wagerAmount, decimals));

            // Strategy: Skip whales
            if (amount > 500) {
                console.log(chalk.gray(`[Acc ${idx + 1}] ⏭️ Skipping duel ${duel.id}: Amount ${amount} > 500`));
                continue;
            }

            const balance = await getTokenBalance(wallet, tokenAddr);
            if (balance.lt(duel.wagerAmount)) {
                console.log(chalk.gray(`[Acc ${idx + 1}] ⏭️ Skipping duel ${duel.id}: Low balance (${ethers.utils.formatUnits(balance, decimals)} < ${amount})`));
                continue;
            }

            // CHECK OPPONENT LIMIT (Max 3/day)
            const opponentCount = state[idx].duelHistory.filter(h => h.opponent.toLowerCase() === duel.challenger.toLowerCase()).length;
            if (opponentCount >= SAME_OPPONENT_LIMIT) {
                console.log(chalk.yellow(`[Acc ${idx + 1}] 🚫 Skipping opponent ${duel.challenger.slice(0, 6)} (Max fights reached)`));
                continue;
            }

            const result = await withRetry(async () => {
                const approved = await ensureApproval(wallet, tokenAddr, DUEL_ADDR);
                if (!approved) throw new Error('Approval failed');
                const iface = new ethers.utils.Interface(DUEL_ABI);
                const data = iface.encodeFunctionData('acceptDuel', [duel.id]);
                const gasPrice = (await provider.getGasPrice()).mul(110).div(100);
                const tx = await wallet.sendTransaction({ to: DUEL_ADDR, data, gasLimit: 1000000, gasPrice });
                await tx.wait();
                return true;
            }, idx, 'duelStatus');

            if (result.success) {
                processed = true;
                state[idx].duelHistory.push({ timestamp: Date.now(), opponent: duel.challenger });
                break;
            } else {
                console.log(chalk.red(`[Acc ${idx + 1}] ❌ Accept Failed: ${result.error?.message || 'Unknown error'}`));
                if (result.error?.message?.includes('daily limit') || result.error?.message?.includes('limit reached')) {
                    state[idx].duelStatus = '✅Limit';
                    state[idx].nextDuel = getNextDailySchedule();
                    return; // Stop dueling for this account today
                }
            }
            await randomSleep();
        }

        // If no duels to accept, create one
        if (!processed && openDuels.filter(d => d.challenger.toLowerCase() !== addressLower).length === 0) {
            const useUSDC = Math.random() < 0.5;
            const tokenAddr = useUSDC ? USDC_ADDR : USDT_ADDR;
            const decimals = useUSDC ? 6 : 18;

            const balance = await getTokenBalance(wallet, tokenAddr);
            // Strategy: Target $420/hour to hit $10k/day evenly
            const minWager = ethers.utils.parseUnits("400", decimals);

            console.log(chalk.gray(`[Acc ${idx + 1}] ⚖️ Creation Balance Check: ${ethers.utils.formatUnits(balance, decimals)} ${useUSDC ? 'USDC' : 'USDT'} (Min: 400)`));

            if (balance.gte(minWager)) {
                // Target 400-450 range
                const rawAmount = randomDelay(400, 450);
                const wagerAmount = ethers.utils.parseUnits(rawAmount.toString(), decimals);

                if (balance.lt(wagerAmount)) {
                    console.log(chalk.yellow(`[Acc ${idx + 1}] ⚠️ Balance low for optimal wager, skipping creation.`));
                    continue;
                }

                const result = await withRetry(async () => {
                    const approved = await ensureApproval(wallet, tokenAddr, DUEL_ADDR);
                    if (!approved) throw new Error('Approval failed');
                    const iface = new ethers.utils.Interface(DUEL_ABI);
                    const data = iface.encodeFunctionData('createDuel', [wagerAmount, tokenAddr, 0]);
                    const gasPrice = (await provider.getGasPrice()).mul(110).div(100);
                    const tx = await wallet.sendTransaction({ to: DUEL_ADDR, data, gasLimit: 1000000, gasPrice });
                    await tx.wait();
                    return true;
                }, idx, 'duelStatus');

                if (result.success) {
                    processed = true;
                    // For created duels, we don't know the opponent yet, so we just track the action timestamp
                    // We can use a placeholder opponent or just track it for rate limit
                    state[idx].duelHistory.push({ timestamp: Date.now(), opponent: 'unknown_created' });
                } else {
                    console.log(chalk.red(`[Acc ${idx + 1}] ❌ Create Failed: ${result.error?.message || 'Unknown error'}`));
                    if (result.error?.message?.includes('daily limit') || result.error?.message?.includes('limit reached')) {
                        state[idx].duelStatus = '✅Limit';
                        state[idx].nextDuel = getNextDailySchedule();
                        return; // Stop dueling
                    }
                }
            }
        }

        if (i < 2) await sleep(5000 + Math.random() * 5000); // Wait 5-10s between iterations
    }

    // 3. Deposit max to vault for advantage (Reserve 100-500)
    const reserve = randomDelay(100, 500);
    console.log(chalk.cyan(`[Acc ${idx + 1}] 🏦 Max Deposit Active (Reserved: ${reserve} tokens)`));
    await depositVault(wallet, 1, idx, reserve);
    await depositVault(wallet, 0, idx, reserve);

    // 4. Verify duel task
    await withRetry(async () => {
        const res = await client.post('/functions/v1/verify-onchain-task', {
            wallet_address: addressLower,
            task_id: 'daily-duel-create'
        });
        return res.data?.verified;
    }, idx, 'duelStatus');

    state[idx].duelStatus = '✅';
    state[idx].lastDuel = Date.now();
    // Dynamic Scheduling: If not limited, run aggressively (10-30s)
    state[idx].nextDuel = new Date(Date.now() + randomDelay(10000, 30000));
}

// ============================================
// MAIN LOOP
// ============================================

async function main() {
    accounts.forEach((_, i) => {
        state[i] = createState(i);
        // Force immediate check on startup (set to 1 min ago), then it will sync to 14:00
        state[i].nextDaily = new Date(Date.now() - 60000);
        state[i].nextDuel = new Date(Date.now() + randomDelay(5000, 30000));
    });

    renderDashboard();

    while (true) {
        const now = Date.now();

        for (let i = 0; i < accounts.length; i++) {
            const acc = accounts[i];
            const s = state[i];

            if (s.isProcessing) continue;

            // 1. DAILY TASKS + WEB FAUCET (14:00 WIB)
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
