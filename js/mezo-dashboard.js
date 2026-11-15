'use strict';

const PAPER_KEY = 'paperterminal_mezo_paper_v1';
const PAPER_START_CASH = 10000;
const PAPER_START_BTC = 0.05;
const PAPER_MAX_LTV = 0.5;
const MUSD_ADDRESS = '0xdd468a1ddc392dcdbef6db6e34e89aa338f9f186';
const MUSD_GECKOTERMINAL_URL = `https://api.geckoterminal.com/api/v2/networks/mezo/tokens/${MUSD_ADDRESS}`;
const PRICE_ENDPOINTS = [
  { url: 'https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT', parse: data => ({ price: Number(data?.lastPrice), change: Number(data?.priceChangePercent), source: 'Binance BTC/USDT' }) },
  { url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true', parse: data => ({ price: Number(data?.bitcoin?.usd), change: Number(data?.bitcoin?.usd_24h_change), source: 'CoinGecko' }) }
];

function defaultPaperState() {
  return { cashMUSD: PAPER_START_CASH, collateralBTC: PAPER_START_BTC, debtMUSD: 0, vaultMUSD: 0, activity: [] };
}

function loadPaperState() {
  try {
    const stored = JSON.parse(localStorage.getItem(PAPER_KEY));
    if (!stored || typeof stored !== 'object') return defaultPaperState();
    const defaults = defaultPaperState();
    const state = { ...defaults, ...stored };
    for (const key of ['cashMUSD', 'collateralBTC', 'debtMUSD', 'vaultMUSD']) {
      state[key] = Number.isFinite(Number(state[key])) && Number(state[key]) >= 0 ? Number(state[key]) : defaults[key];
    }
    state.activity = Array.isArray(state.activity) ? state.activity.slice(-50) : [];
    return state;
  } catch {
    return defaultPaperState();
  }
}

let paper = loadPaperState();
let btcMarket = { price: null, change: null, source: '', updated: null, status: 'loading' };
let musdMarket = { price: null, source: '', updated: null, status: 'loading' };
let walletAddress = '';

function savePaper() {
  localStorage.setItem(PAPER_KEY, JSON.stringify(paper));
}

function usd(value, digits = 2) {
  if (!Number.isFinite(value)) return 'Unavailable';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits }).format(value);
}

function amount(value, digits = 6) {
  if (!Number.isFinite(value)) return 'Unavailable';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function paperEquity() {
  if (!Number.isFinite(btcMarket.price)) return null;
  return paper.cashMUSD + paper.vaultMUSD + paper.collateralBTC * btcMarket.price - paper.debtMUSD;
}

function collateralValue(price = btcMarket.price) {
  return Number.isFinite(price) ? paper.collateralBTC * price : null;
}

function ltv(debt = paper.debtMUSD, price = btcMarket.price) {
  const value = collateralValue(price);
  return value > 0 ? debt / value : null;
}

function notify(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(notify.timeout);
  notify.timeout = setTimeout(() => toast.classList.remove('show'), 3200);
}

function addActivity(type, amountValue, detail) {
  paper.activity.push({ type, amount: amountValue, detail, timestamp: Date.now() });
  paper.activity = paper.activity.slice(-50);
  savePaper();
}

function renderPrice() {
  const price = Number.isFinite(btcMarket.price) ? usd(btcMarket.price) : 'Unavailable';
  setText('btc-price', price);
  setText('btc-change', Number.isFinite(btcMarket.change) ? `${btcMarket.change >= 0 ? '+' : ''}${btcMarket.change.toFixed(2)}% 24h` : '24h change unavailable');
  setText('btc-source', btcMarket.source ? `${btcMarket.source} · updated ${new Date(btcMarket.updated).toLocaleTimeString()}` : btcMarket.status === 'loading' ? 'Fetching public BTC spot price…' : 'Live BTC price unavailable');
  const priceTag = document.getElementById('btc-status');
  if (priceTag) {
    priceTag.textContent = btcMarket.status === 'live' ? 'LIVE PRICE' : btcMarket.status === 'loading' ? 'LOADING' : 'UNAVAILABLE';
    priceTag.className = `pill ${btcMarket.status === 'live' ? '' : 'unavailable'}`;
  }
  renderMusdPrice();
  renderDashboard();
}

function renderMusdPrice() {
  setText('musd-price', Number.isFinite(musdMarket.price) ? usd(musdMarket.price, 4) : 'Unavailable');
  setText('musd-portfolio-quote', Number.isFinite(musdMarket.price) ? usd(musdMarket.price, 4) : 'Unavailable');
  const freshness = musdMarket.status === 'cached' ? 'cached' : 'updated';
  setText('musd-source', musdMarket.source ? `${musdMarket.source} · ${freshness} ${new Date(musdMarket.updated).toLocaleTimeString()}` : 'Mezo MUSD market quote unavailable');
}

async function fetchMUSDPrice() {
  try {
    const response = await fetch(MUSD_GECKOTERMINAL_URL, { signal: AbortSignal.timeout(7000), cache: 'no-store' });
    if (response.ok) {
      const payload = await response.json();
      const token = payload?.data?.attributes;
      if (token?.address?.toLowerCase() === MUSD_ADDRESS && Number(token.price_usd) > 0) {
        musdMarket = { price: Number(token.price_usd), source: 'GeckoTerminal · Mezo MUSD', updated: Date.now(), status: 'live' };
        localStorage.setItem('paperterminal_mezo_musd_quote', JSON.stringify(musdMarket));
        renderMusdPrice();
        return;
      }
    }
  } catch { /* use the listing fallback */ }

  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=mezo-usd&vs_currencies=usd', { signal: AbortSignal.timeout(7000), cache: 'no-store' });
    if (response.ok) {
      const payload = await response.json();
      if (Number(payload?.['mezo-usd']?.usd) > 0) {
        musdMarket = { price: Number(payload['mezo-usd'].usd), source: 'CoinGecko · Mezo USD', updated: Date.now(), status: 'live' };
        localStorage.setItem('paperterminal_mezo_musd_quote', JSON.stringify(musdMarket));
        renderMusdPrice();
        return;
      }
    }
  } catch { /* no verified quote available */ }

  try {
    const cached = JSON.parse(localStorage.getItem('paperterminal_mezo_musd_quote'));
    if (Number.isFinite(cached?.price) && Date.now() - cached.updated < 15 * 60 * 1000) {
      musdMarket = { ...cached, status: 'cached' };
      renderMusdPrice();
      return;
    }
  } catch { /* no usable cached quote */ }

  musdMarket = { price: null, source: '', updated: null, status: 'unavailable' };
  renderMusdPrice();
}

function applyTheme(theme) {
  const activeTheme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = activeTheme;
  localStorage.setItem('paperterminal_theme', activeTheme);
  const light = activeTheme === 'light';
  const button = document.getElementById('theme-toggle');
  const label = document.getElementById('theme-label');
  const sun = document.querySelector('.theme-sun');
  const moon = document.querySelector('.theme-moon');
  const nextLabel = light ? 'Switch to dark mode' : 'Switch to light mode';
  if (label) label.textContent = light ? 'Dark mode' : 'Light mode';
  if (button) {
    button.setAttribute('aria-label', nextLabel);
    button.setAttribute('title', nextLabel);
    button.setAttribute('aria-pressed', String(light));
  }
  if (sun) sun.hidden = light;
  if (moon) moon.hidden = !light;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = light ? '#f2f5f5' : '#0c1116';
}

async function fetchBtcPrice() {
  for (const endpoint of PRICE_ENDPOINTS) {
    try {
      const response = await fetch(endpoint.url, { signal: AbortSignal.timeout(7000), cache: 'no-store' });
      if (!response.ok) continue;
      const values = endpoint.parse(await response.json());
      if (!Number.isFinite(values.price) || values.price <= 0) continue;
      btcMarket = { ...values, updated: Date.now(), status: 'live' };
      localStorage.setItem('paperterminal_mezo_btc_quote', JSON.stringify(btcMarket));
      renderPrice();
      return;
    } catch { /* try the next public price source */ }
  }
  try {
    const cached = JSON.parse(localStorage.getItem('paperterminal_mezo_btc_quote'));
    if (Number.isFinite(cached?.price) && Date.now() - cached.updated < 15 * 60 * 1000) {
      btcMarket = { ...cached, status: 'cached' };
      renderPrice();
      setText('btc-source', `${btcMarket.source} · cached ${new Date(btcMarket.updated).toLocaleTimeString()}`);
      return;
    }
  } catch { /* no usable cached quote */ }
  btcMarket = { price: null, change: null, source: '', updated: null, status: 'unavailable' };
  renderPrice();
}

function renderRisk() {
  const currentLtv = ltv();
  setText('current-ltv', currentLtv === null ? '—' : `${(currentLtv * 100).toFixed(1)}%`);
  const scenarios = [
    { label: 'Now', drop: 0 },
    { label: '−10%', drop: 0.1 },
    { label: '−25%', drop: 0.25 },
    { label: '−40%', drop: 0.4 }
  ];
  const list = document.getElementById('risk-scenarios');
  if (!list) return;
  list.innerHTML = scenarios.map(scenario => {
    const scenarioPrice = Number.isFinite(btcMarket.price) ? btcMarket.price * (1 - scenario.drop) : null;
    const scenarioLtv = ltv(paper.debtMUSD, scenarioPrice);
    const percent = scenarioLtv === null ? 0 : Math.min(scenarioLtv * 100, 100);
    const colorClass = percent >= 50 ? 'danger' : percent >= 35 ? 'warn' : '';
    return `<div class="risk-row"><span class="risk-name">${scenario.label}</span><div class="risk-track"><div class="risk-fill ${colorClass}" style="width:${percent}%"></div></div><span class="risk-value">${scenarioLtv === null ? '—' : `${(scenarioLtv * 100).toFixed(1)}%`}</span></div>`;
  }).join('');
}

function renderActivity() {
  const target = document.getElementById('activity-list');
  if (!target) return;
  if (!paper.activity.length) {
    target.innerHTML = '<div class="empty">No activity yet. Record a paper loan or practice allocation to get started.</div>';
    return;
  }
  target.innerHTML = [...paper.activity].reverse().map(entry => `
    <div class="history-row">
      <div><strong>${escapeHTML(entry.type)}</strong><time>${new Date(entry.timestamp).toLocaleString()} · ${escapeHTML(entry.detail)}</time></div>
      <span class="history-amount">${escapeHTML(entry.amount)}</span>
    </div>`).join('');
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function renderDashboard() {
  const collateral = collateralValue();
  const equity = paperEquity();
  const currentLtv = ltv();
  setText('collateral-value', collateral === null ? 'Unavailable' : usd(collateral));
  setText('debt-value', usd(paper.debtMUSD));
  setText('cash-value', usd(paper.cashMUSD));
  setText('vault-value', usd(paper.vaultMUSD));
  setText('equity-value', equity === null ? 'Unavailable' : usd(equity));
  setText('portfolio-btc', `${amount(paper.collateralBTC, 8)} BTC`);
  setText('portfolio-btc-card', `${amount(paper.collateralBTC, 8)} BTC`);
  setText('portfolio-cash', `${usd(paper.cashMUSD)} paper MUSD`);
  setText('portfolio-debt', usd(paper.debtMUSD));
  setText('portfolio-vault', `${usd(paper.vaultMUSD)} practice shares`);
  setText('portfolio-collateral-card', collateral === null ? 'Unavailable' : usd(collateral));
  setText('portfolio-ltv', currentLtv === null ? '—' : `${(currentLtv * 100).toFixed(1)}%`);
  setText('collateral-input-hint', `${amount(paper.collateralBTC, 8)} paper BTC currently allocated`);
  setText('repay-input-hint', `${usd(paper.debtMUSD)} paper debt`);
  setText('vault-cash-hint', `${usd(paper.cashMUSD)} available paper MUSD`);
  setText('vault-holdings-hint', `${usd(paper.vaultMUSD)} practice allocation`);
  renderRisk();
  renderActivity();
}

function getAmount(id) {
  const input = document.getElementById(id);
  const value = Number(input?.value);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function borrowPaper() {
  const requested = getAmount('borrow-amount');
  if (!requested) return notify('Enter a borrow amount greater than zero.');
  if (!Number.isFinite(btcMarket.price)) return notify('A live BTC price is needed to estimate this loan.');
  const proposedDebt = paper.debtMUSD + requested;
  const proposedLtv = ltv(proposedDebt);
  if (proposedLtv > PAPER_MAX_LTV) return notify('That exceeds the 50% practice borrowing limit.');
  paper.debtMUSD = proposedDebt;
  paper.cashMUSD += requested;
  addActivity('Paper loan', `${usd(requested)} MUSD`, `practice LTV ${(proposedLtv * 100).toFixed(1)}%`);
  renderDashboard();
  notify('Paper loan recorded.');
}

function repayPaper() {
  const requested = getAmount('repay-amount');
  if (!requested) return notify('Enter a repayment amount greater than zero.');
  if (requested > paper.cashMUSD || requested > paper.debtMUSD) return notify('Repayment cannot exceed your practice cash or loan balance.');
  paper.cashMUSD -= requested;
  paper.debtMUSD -= requested;
  addActivity('Paper repayment', `${usd(requested)} MUSD`, 'debt repayment');
  renderDashboard();
  notify('Paper repayment recorded.');
}

function addCollateral() {
  const requested = getAmount('collateral-amount');
  if (!requested) return notify('Enter a BTC amount greater than zero.');
  paper.collateralBTC += requested;
  addActivity('Add BTC collateral', `${amount(requested, 8)} BTC`, 'practice allocation');
  renderDashboard();
  notify('Paper BTC collateral added. No real BTC moved.');
}

function removeCollateral() {
  const requested = getAmount('collateral-amount');
  if (!requested) return notify('Enter a BTC amount greater than zero.');
  if (requested > paper.collateralBTC) return notify('Amount exceeds your paper BTC collateral.');
  if (paper.collateralBTC - requested <= 0 && paper.debtMUSD > 0) return notify('Repay the loan before removing all collateral.');
  if (paper.debtMUSD > 0 && !Number.isFinite(btcMarket.price)) return notify('A live BTC price is needed to evaluate this collateral change.');
  const remainingCollateralValue = (paper.collateralBTC - requested) * btcMarket.price;
  if (paper.debtMUSD > 0 && paper.debtMUSD / remainingCollateralValue > PAPER_MAX_LTV) return notify('That would exceed the practice borrowing limit.');
  paper.collateralBTC -= requested;
  addActivity('Remove BTC collateral', `${amount(requested, 8)} BTC`, 'practice withdrawal');
  renderDashboard();
  notify('Paper BTC collateral removed. No real BTC moved.');
}

function depositVault() {
  const requested = getAmount('vault-deposit');
  if (!requested) return notify('Enter an amount greater than zero.');
  if (requested > paper.cashMUSD) return notify('Not enough paper MUSD cash for this deposit.');
  paper.cashMUSD -= requested;
  paper.vaultMUSD += requested;
  addActivity('Practice allocation', `${usd(requested)} MUSD`, 'shares at 1:1; no yield added');
  renderDashboard();
  notify('Practice deposit recorded. No funds moved and no yield accrued.');
}

function withdrawVault() {
  const requested = getAmount('vault-withdraw');
  if (!requested) return notify('Enter an amount greater than zero.');
  if (requested > paper.vaultMUSD) return notify('Amount exceeds your practice allocation.');
  paper.vaultMUSD -= requested;
  paper.cashMUSD += requested;
  addActivity('Practice withdrawal', `${usd(requested)} MUSD`, 'shares redeemed at 1:1; no yield added');
  renderDashboard();
  notify('Practice withdrawal recorded.');
}

function resetPaper() {
  if (!window.confirm('Reset the paper account and clear its local activity?')) return;
  paper = defaultPaperState();
  savePaper();
  renderDashboard();
  notify('Practice account reset.');
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function renderWallet() {
  const button = document.getElementById('connect-wallet');
  const label = document.getElementById('wallet-status');
  const network = document.getElementById('network-status');
  if (button) button.textContent = walletAddress ? shortAddress(walletAddress) : 'Connect wallet';
  if (label) label.textContent = walletAddress ? `${shortAddress(walletAddress)} · practice mode` : 'No wallet connected';
  if (network) network.textContent = walletAddress ? 'Wallet connected · practice only' : 'Practice mode · no transactions';
}

function openWalletModal() {
  document.getElementById('wallet-modal')?.classList.add('open');
}

function closeWalletModal() {
  document.getElementById('wallet-modal')?.classList.remove('open');
}

async function connectInjectedWallet() {
  if (!window.ethereum?.request) return notify('No browser wallet found. Practice mode is still available.');
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    walletAddress = accounts?.[0] || '';
    renderWallet();
    closeWalletModal();
    notify(walletAddress ? 'Wallet connected. Practice mode remains active.' : 'No account was selected.');
  } catch {
    notify('Wallet connection was cancelled or failed. Practice mode is unchanged.');
  }
}

function bindWallet() {
  document.getElementById('connect-wallet')?.addEventListener('click', openWalletModal);
  document.getElementById('close-wallet')?.addEventListener('click', closeWalletModal);
  document.getElementById('wallet-modal')?.addEventListener('click', event => {
    if (event.target.id === 'wallet-modal') closeWalletModal();
  });
  document.getElementById('connect-injected')?.addEventListener('click', connectInjectedWallet);
  document.getElementById('disconnect-wallet')?.addEventListener('click', () => {
    walletAddress = '';
    renderWallet();
    notify('Wallet disconnected.');
  });
  if (window.ethereum?.on) {
    window.ethereum.on('accountsChanged', accounts => {
      walletAddress = accounts?.[0] || '';
      renderWallet();
    });
  }
  window.ethereum?.request?.({ method: 'eth_accounts' }).then(accounts => {
    if (!accounts?.[0]) return;
    walletAddress = accounts[0];
    renderWallet();
  }).catch(() => {});
}

function bindTheme() {
  applyTheme(document.documentElement.dataset.theme || 'dark');
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
}

function bindPaperActions() {
  document.getElementById('borrow-form')?.addEventListener('submit', event => { event.preventDefault(); borrowPaper(); });
  document.getElementById('repay-form')?.addEventListener('submit', event => { event.preventDefault(); repayPaper(); });
  document.getElementById('add-collateral')?.addEventListener('click', addCollateral);
  document.getElementById('remove-collateral')?.addEventListener('click', removeCollateral);
  document.getElementById('vault-deposit-form')?.addEventListener('submit', event => { event.preventDefault(); depositVault(); });
  document.getElementById('vault-withdraw-form')?.addEventListener('submit', event => { event.preventDefault(); withdrawVault(); });
  document.getElementById('reset-paper')?.addEventListener('click', resetPaper);
}

function bindNavigation() {
  const links = [...document.querySelectorAll('.navlinks a[href^="#"]')];
  const sections = links.map(link => document.getElementById(link.getAttribute('href').slice(1))).filter(Boolean);
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const link = links.find(item => item.getAttribute('href') === `#${entry.target.id}`);
      links.forEach(item => item.classList.toggle('active', item === link));
      if (link) history.replaceState(null, '', `#${entry.target.id}`);
    }
  }, { rootMargin: '-25% 0px -65% 0px' });
  sections.forEach(section => observer.observe(section));
}

document.addEventListener('DOMContentLoaded', () => {
  bindPaperActions();
  bindWallet();
  bindTheme();
  bindNavigation();
  renderDashboard();
  renderPrice();
  fetchBtcPrice();
  fetchMUSDPrice();
  setInterval(fetchBtcPrice, 60000);
  setInterval(fetchMUSDPrice, 120000);
  setInterval(renderDashboard, 15000);
});
