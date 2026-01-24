const fs = require('fs-extra');
const axios = require('axios');
const ethers = require('ethers');
const chalk = require('chalk');
const Table = require('cli-table3');
const { HttpsProxyAgent } = require('https-proxy-agent');
const UserAgent = require('user-agents');
const moment = require('moment');
const path = require('path');

// --- CONFIG & SETUP ---
const config = {
    baseUrl: "https://fckqnmehuebqmevkicgz.supabase.co",
    origin: "https://liquicore.finance",
    referer: "https://liquicore.finance/",
    apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZja3FubWVodWVicW1ldmtpY2d6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4NzQ3NDksImV4cCI6MjA4NDQ1MDc0OX0.ryCrP8GkL68ORKerfisZ6kfmFjTcyl3UJx7S6cfHhmk",
    retries: 3,
    delayMin: 5000,
    delayMax: 15000
};

let accounts = [];
try {
    accounts = require('./accounts.json');
} catch (e) {
    console.log(chalk.red('Error loading accounts.json.'));
    process.exit(1);
}

const provider = new ethers.providers.JsonRpcProvider('https://data-seed-prebsc-1-s1.bnbchain.org:8545/');

// Contracts
const USDC_ADDR = '0xe4da02B0188D98A10244c1bD265Ea0aF36be205a';
const USDT_ADDR = '0x29565d182bF1796a3836a68D22D833d92795725A';
const VAULT_ADDR = '0x11e4e6cD5D9E60646219098d99CfaFd130cdcE93';

// Utils
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// --- SCHEDULER HELPERS ---
function getNextScheduledTime(hour = 12, minute = 0) {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (now >= next) {
        next.setDate(next.getDate() + 1);
    }
    return next;
}

function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`;
}

async function displayCountdown(msUntilNextRun, targetTime) {
    // Just the countdown, NO TABLE here.
    return new Promise((resolve) => {
        const endTime = targetTime.getTime();
        if (endTime <= Date.now()) { resolve(); return; }

        console.log(''); // spacer
        const intervalId = setInterval(() => {
            const remaining = endTime - Date.now();
            if (remaining <= 0) {
                clearInterval(intervalId);
                process.stdout.clearLine?.();
                process.stdout.cursorTo?.(0);
                resolve();
            } else {
                try {
                    process.stdout.clearLine?.();
                    process.stdout.cursorTo?.(0);
                    process.stdout.write(chalk.yellow(`⏳ Waiting for next run... ${formatTime(remaining)} remaining`));
                } catch (e) { }
            }
        }, 1000);
    });
}

async function waitUntilScheduledTime(hour = 12, minute = 0) {
    const nextRun = getNextScheduledTime(hour, minute);
    const msUntilNextRun = nextRun.getTime() - Date.now();
    await displayCountdown(msUntilNextRun, nextRun);
}

// --- SIPAL UI ---
const displayBanner = () => {
    console.clear();
    console.log(chalk.blue(`
               / \\
              /   \\
             |  |  |
             |  |  |
              \\  \\
             |  |  |
             |  |  |
              \   /
               \ /
    `));
    console.log(chalk.bold.cyan('    ======SIPAL AIRDROP======'));
    console.log(chalk.bold.cyan('  =====SIPAL LIQUICORE BOT V1.0====='));
    console.log('\n');
};

const logHelper = (index, type, msg) => {
    const time = moment().format('HH:mm:ss');
    let color = chalk.white;
    if (type === 'SUCCESS') color = chalk.green;
    if (type === 'ERROR') color = chalk.red;
    if (type === 'INFO') color = chalk.cyan;
    if (type === 'WARN') color = chalk.yellow;
    console.log(`${chalk.gray(`[${time}]`)} ${chalk.cyan(`[Acc ${index + 1}]`)} ${color(msg)}`);
};

// --- CORE BLOCKCHAIN LOGIC ---
async function getTokenBalance(wallet, tokenAddress) {
    try {
        const contract = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], wallet);
        return await contract.balanceOf(wallet.address);
    } catch (e) { return ethers.BigNumber.from(0); }
}

async function getAllowance(wallet, tokenAddress, spender) {
    try {
        const contract = new ethers.Contract(tokenAddress, ['function allowance(address, address) view returns (uint256)'], wallet);
        return await contract.allowance(wallet.address, spender);
    } catch (e) { return ethers.BigNumber.from(0); }
}

async function ensureApproval(wallet, tokenAddress, spender, idx) {
    const minAllowance = ethers.BigNumber.from("1000000000");
    let attempts = 0;
    while (attempts < 3) {
        const allowance = await getAllowance(wallet, tokenAddress, spender);
        if (allowance.gte(minAllowance)) {
            if (attempts > 0) logHelper(idx, 'SUCCESS', 'Allowance Confirmed');
            return true;
        }
        if (attempts === 0) {
            logHelper(idx, 'INFO', 'Sending Approve...');
            await approveToken(wallet, tokenAddress, spender, idx);
        } else {
            logHelper(idx, 'INFO', `Waiting for Allowance (Attempt ${attempts})...`);
        }
        await sleep(10000);
        attempts++;
    }
    return false;
}

async function claimFaucet(wallet, tokenAddress, tokenName, idx) {
    try {
        const data = '0xb86d1d63000000000000000000000000' + wallet.address.slice(2).toLowerCase();
        try { await wallet.estimateGas({ to: tokenAddress, data: data }); }
        catch (e) { logHelper(idx, 'WARN', `Faucet ${tokenName} Skip (Cooldown)`); return false; }

        const tx = await wallet.sendTransaction({ to: tokenAddress, data: data, gasLimit: 200000, gasPrice: await provider.getGasPrice() });
        await tx.wait();
        logHelper(idx, 'SUCCESS', `Faucet ${tokenName} Caimed`);
        return true;
    } catch (e) { logHelper(idx, 'WARN', `Faucet ${tokenName} Failed: ${e.message.split('(')[0]}`); return false; }
}

async function approveToken(wallet, tokenAddress, spender, idx) {
    try {
        const data = '0x095ea7b3' + '000000000000000000000000' + spender.slice(2).toLowerCase() + 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
        const tx = await wallet.sendTransaction({ to: tokenAddress, data: data, gasLimit: 100000, gasPrice: await provider.getGasPrice() });
        await tx.wait();
        return true;
    } catch (e) { return true; }
}

async function depositVault(wallet, type, idx) {
    const tokenAddr = type === 1 ? USDC_ADDR : USDT_ADDR;
    const tokenName = type === 1 ? 'USDC' : 'USDT';

    // Balance Check
    const bal = await getTokenBalance(wallet, tokenAddr);
    const decimals = type === 1 ? 6 : 18;
    const required = type === 1 ? ethers.BigNumber.from("1000000000") : ethers.BigNumber.from("1000000000000000000000");

    if (bal.lt(required)) {
        logHelper(idx, 'WARN', `Deposit ${tokenName} Skipped: Low Balance (${ethers.utils.formatUnits(bal, decimals)})`);
        return false;
    }

    try {
        const selector = '0x68afada4';
        const typeHex = type === 1
            ? '0000000000000000000000000000000000000000000000000000000000000001'
            : '0000000000000000000000000000000000000000000000000000000000000000';
        let amountHex;
        if (type === 1) amountHex = '000000000000000000000000000000000000000000000000000000003b9aca00';
        else amountHex = '00000000000000000000000000000000000000000000003635c9adc5dea00000';
        const lockHex = '0000000000000000000000000000000000000000000000000000000000000000';

        const data = selector + typeHex + amountHex + lockHex;
        const tx = await wallet.sendTransaction({ to: VAULT_ADDR, data: data, gasLimit: 500000, gasPrice: await provider.getGasPrice() });
        await tx.wait();
        logHelper(idx, 'SUCCESS', `Vault ${tokenName} Deposit Confirmed`);
        return true;
    } catch (e) {
        logHelper(idx, 'WARN', `Deposit ${tokenName} Failed: ${e.message.split('(')[0]}`);
        return false;
    }
}

const createClient = (proxy) => {
    const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
    const userAgent = new UserAgent({ deviceCategory: 'desktop' }).toString();
    return axios.create({
        baseURL: config.baseUrl, httpsAgent: agent,
        headers: {
            'apikey': config.apiKey, 'content-type': 'application/json', 'origin': config.origin, 'referer': config.referer,
            'user-agent': userAgent, 'sec-ch-ua': '"Google Chrome";v="143"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site'
        }
    });
};

// --- SINGLE ACCOUNT PROCESSOR ---
const processAccount = async (account, index, currentState) => {
    const wallet = new ethers.Wallet(account.privateKey, provider);
    const client = createClient(account.proxy);
    const addressLower = wallet.address.toLowerCase();

    logHelper(index, 'INFO', 'Starting Cycle...');
    let points = 0;

    // 1. Profile
    try {
        const profileRes = await client.get(`/rest/v1/user_profiles_public?select=total_liq_earned&wallet_address=eq.${addressLower}`);
        if (profileRes.data?.[0]) points = profileRes.data[0].total_liq_earned;
        logHelper(index, 'SUCCESS', `Points: ${points}`);
    } catch { }

    logHelper(index, 'INFO', 'Checking Tasks...');
    const taskStatus = { daily: 'Pend', vaultUSDC: 'Pend', vaultUSDT: 'Pend' };
    const tasks = [
        { id: 'daily-checkin', key: 'daily', type: null },
        { id: 'daily-deposit-tusdc-1000', key: 'vaultUSDC', type: 'tusdc' },
        { id: 'daily-deposit-tusdt-1000', key: 'vaultUSDT', type: 'tusdt' }
    ];

    for (const t of tasks) {
        try {
            const vRes = await client.post('/functions/v1/verify-deposit-task', { wallet_address: addressLower, task_id: t.id, token_type: t.type });
            if (vRes.data?.verified || vRes.data?.message?.includes('already')) taskStatus[t.key] = 'DONE';
        } catch (e) { if (e.response?.data?.message?.includes('already')) taskStatus[t.key] = 'DONE'; }
    }

    // 2. Actions
    if (taskStatus.daily !== 'DONE') {
        try {
            const res = await client.post('/functions/v1/verify-deposit-task', { wallet_address: addressLower, task_id: 'daily-checkin', token_type: null });
            if (res.data?.verified) { logHelper(index, 'SUCCESS', 'Daily Check-in Success'); taskStatus.daily = 'DONE'; }
        } catch (e) { }
        await sleep(1000);
    }

    if (taskStatus.vaultUSDC !== 'DONE') {
        await claimFaucet(wallet, USDC_ADDR, 'USDC', index);
        await sleep(2000);
        await ensureApproval(wallet, USDC_ADDR, VAULT_ADDR, index);
        logHelper(index, 'INFO', 'Depositing USDC...');
        const ok = await depositVault(wallet, 1, index);
        if (ok) {
            await sleep(5000);
            try {
                const vRes = await client.post('/functions/v1/verify-deposit-task', { wallet_address: addressLower, task_id: 'daily-deposit-tusdc-1000', token_type: 'tusdc' });
                if (vRes.data?.verified) { logHelper(index, 'SUCCESS', 'USDC Task Verified!'); taskStatus.vaultUSDC = 'DONE'; }
            } catch { }
        }
    }

    if (taskStatus.vaultUSDT !== 'DONE') {
        await claimFaucet(wallet, USDT_ADDR, 'USDT', index);
        await sleep(2000);
        await ensureApproval(wallet, USDT_ADDR, VAULT_ADDR, index);
        logHelper(index, 'INFO', 'Depositing USDT...');
        const ok = await depositVault(wallet, 0, index);
        if (ok) {
            await sleep(5000);
            try {
                const vRes = await client.post('/functions/v1/verify-deposit-task', { wallet_address: addressLower, task_id: 'daily-deposit-tusdt-1000', token_type: 'tusdt' });
                if (vRes.data?.verified) { logHelper(index, 'SUCCESS', 'USDT Task Verified!'); taskStatus.vaultUSDT = 'DONE'; }
            } catch { }
        }
    }

    // 3. Final Fetch
    let streak = 0;
    try {
        const [profileRes, streakRes] = await Promise.all([
            client.get(`/rest/v1/user_profiles_public?select=total_liq_earned&wallet_address=eq.${addressLower}`),
            client.get(`/rest/v1/user_streaks_public?select=current_streak&wallet_address=eq.${addressLower}`)
        ]);
        if (profileRes.data?.[0]) points = profileRes.data[0].total_liq_earned;
        if (streakRes.data?.[0]) streak = streakRes.data[0].current_streak;
    } catch { }

    let cycleResult = (taskStatus.daily === 'DONE' && taskStatus.vaultUSDC === 'DONE' && taskStatus.vaultUSDT === 'DONE') ? 'Complete' : 'Partial';
    logHelper(index, 'SUCCESS', `Cycle Finished: ${cycleResult}`);

    // Update State
    currentState[index] = {
        name: `Acc ${index + 1}`,
        points: (points !== undefined && points !== null) ? points : '-',
        streak: streak,
        status: cycleResult,
        lastRun: moment().format('DD/MM HH:mm')
    };
};

const showGrandSummary = (state, nextRunStr) => {
    console.log('\n' + chalk.bold.cyan('================================================================================================'));
    console.log(chalk.bold.cyan(`                                  🤖 SIPAL LIQUICORE BOT 🤖`));
    console.log(chalk.bold.cyan('================================================================================================'));

    const table = new Table({
        head: ['Account', 'Points', 'Streak', 'Status', 'Last Run', 'Next Run'],
        style: { head: ['cyan'], border: ['grey'] },
        colWidths: [10, 12, 10, 12, 15, 15] // Adjusted widths
    });

    Object.keys(state).sort().forEach(idx => {
        const s = state[idx];
        table.push([s.name, s.points, s.streak, s.status, s.lastRun, nextRunStr || '-']);
    });

    console.log(table.toString());
    console.log(chalk.bold.cyan('================================================================================================\n'));
};

const main = async () => {
    await displayBanner();

    // In-memory state (resets on restart, perfect)
    const botState = {};
    accounts.forEach((acc, idx) => {
        botState[idx] = { name: `Acc ${idx + 1}`, points: '-', streak: '-', status: 'Pending', lastRun: '-' };
    });

    // SCHEDULE CONFIG (12:00 WIB)
    const SCHEDULED_HOUR = 12;
    const SCHEDULED_MINUTE = 0;

    while (true) {
        try {
            // Run Cycle for ALL accounts (One by One)
            for (let i = 0; i < accounts.length; i++) {
                await processAccount(accounts[i], i, botState);
                await sleep(2000);
            }

            // Calc Next Run
            const nextRun = getNextScheduledTime(SCHEDULED_HOUR, SCHEDULED_MINUTE);
            const nextRunStr = moment(nextRun).format('DD/MM HH:mm');

            console.log(chalk.bold.cyan(`\n⏰ Next cycle scheduled at: ${nextRunStr}`));

            // Show Final Summary (ONCE)
            showGrandSummary(botState, nextRunStr);

            // Wait for Schedule
            await waitUntilScheduledTime(SCHEDULED_HOUR, SCHEDULED_MINUTE);

        } catch (e) {
            console.log(chalk.red(`Fatal Loop Error: ${e.message}`));
            await sleep(60000);
        }
    }
};

main();
