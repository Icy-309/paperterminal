import { createPublicClient, defineChain, formatUnits, http, parseAbi } from 'https://esm.sh/viem@2';

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const MAX_OFFERS_PER_PAIR = 2000;
const REFRESH_MS = 30000;
const CACHE_KEY = 'paperterminal_doji_testnet_offers_v1';
const DOJI_LEND_URL = 'https://www.dojis.site/lend';
const OFFER_PAIRS = [
  {
    name: 'Wave 2',
    address: '0x89Dc7C4a7Cbfddf3Cb7a00b5f3fEFaB47aC61a1f',
    abi: parseAbi([
      'function nextOfferId() view returns (uint256)',
      'function offerOf(uint256 offerId) view returns ((address maker,uint64 maturity,uint16 aprBps,uint128 remaining,bool parked))'
    ])
  },
  {
    name: 'Earlier market',
    address: '0x62cBa75f2fAA834ddCa4bF012258368D17Bbb2de',
    abi: parseAbi([
      'function nextOfferId() view returns (uint256)',
      'function offerOf(uint256 offerId) view returns ((address maker,uint64 maturity,uint16 aprBps,uint128 remaining))'
    ])
  }
];

const mezoTestnet = defineChain({
  id: 31611,
  name: 'Mezo Testnet',
  nativeCurrency: { name: 'BTC', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.test.mezo.org'] } },
  blockExplorers: { default: { name: 'Mezo Explorer', url: 'https://explorer.test.mezo.org' } }
});

const client = createPublicClient({ chain: mezoTestnet, transport: http('https://rpc.test.mezo.org', { timeout: 12000, retryCount: 1 }) });
const amountFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function nextThursdayDates(now) {
  const firstThursday = (Math.floor(now / WEEK_SECONDS) + 1) * WEEK_SECONDS;
  return Array.from({ length: 4 }, (_, index) => firstThursday + index * WEEK_SECONDS);
}

async function readPairOffers(pair, now, dates) {
  const nextId = await client.readContract({ address: pair.address, abi: pair.abi, functionName: 'nextOfferId' });
  const total = Number(nextId > 0n ? nextId - 1n : 0n);
  if (total > MAX_OFFERS_PER_PAIR) throw new Error('Offer history exceeds the public read limit.');

  const offers = [];
  for (let firstId = 1; firstId <= total; firstId += 40) {
    const lastId = Math.min(total, firstId + 39);
    const batch = await Promise.all(Array.from({ length: lastId - firstId + 1 }, (_, index) =>
      client.readContract({ address: pair.address, abi: pair.abi, functionName: 'offerOf', args: [BigInt(firstId + index)] })
    ));

    for (const offer of batch) {
      const maturity = Number(offer.maturity);
      if (offer.remaining > 0n && maturity > now && dates.includes(maturity)) {
        offers.push({ maturity, aprBps: Number(offer.aprBps), remaining: offer.remaining });
      }
    }
  }
  return offers;
}

async function readBoard() {
  const now = Math.floor(Date.now() / 1000);
  const dates = nextThursdayDates(now);
  const openOffers = (await Promise.all(OFFER_PAIRS.map(pair => readPairOffers(pair, now, dates)))).flat();
  return dates.map(maturity => {
    const offers = openOffers.filter(offer => offer.maturity === maturity);
    const remaining = offers.reduce((total, offer) => total + offer.remaining, 0n);
    return {
      maturity,
      bestRate: offers.length ? Math.min(...offers.map(offer => offer.aprBps)) / 100 : null,
      offerCount: offers.length,
      musdAvailable: Number(formatUnits(remaining, 18))
    };
  });
}

function formatDueDate(timestamp) {
  return new Date(timestamp * 1000).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC'
  });
}

function formatAmount(value) {
  return `${amountFormat.format(value)} MUSD`;
}

function renderBoard(board, cached = false, updatedAt = Date.now()) {
  const target = document.getElementById('doji-offers');
  const status = document.getElementById('doji-offers-status');
  if (!target || !status) return;

  target.innerHTML = board.map(card => {
    const due = formatDueDate(card.maturity);
    const best = card.bestRate === null ? 'No open offers' : `${card.bestRate.toFixed(2)}%`;
    const offerText = card.offerCount === 1 ? '1 offer' : `${card.offerCount} offers`;
    const action = card.offerCount ? 'View offers' : 'Set a rate';
    return `<article class="term-offer">
      <div class="term-offer-head"><h3>${due}</h3><span class="term-rate">${best}</span></div>
      <div class="term-offer-data"><span>${formatAmount(card.musdAvailable)} open</span><span>${offerText}</span></div>
      <a href="${DOJI_LEND_URL}?date=${card.maturity}" target="_blank" rel="noopener noreferrer">${action} on Doji ↗</a>
    </article>`;
  }).join('');

  const time = new Date(updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  status.textContent = `${cached ? 'Cached' : 'Live'} · Mezo testnet · ${time} UTC`;
}

async function refreshDojiOffers() {
  const status = document.getElementById('doji-offers-status');
  if (status && !status.textContent.startsWith('Live')) status.textContent = 'Loading testnet offers…';
  try {
    const board = await readBoard();
    const updatedAt = Date.now();
    localStorage.setItem(CACHE_KEY, JSON.stringify({ board, updatedAt }));
    renderBoard(board, false, updatedAt);
  } catch {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (Array.isArray(cached?.board) && Date.now() - cached.updatedAt < 5 * 60 * 1000) {
        renderBoard(cached.board, true, cached.updatedAt);
        return;
      }
    } catch { /* no recent market snapshot */ }

    const target = document.getElementById('doji-offers');
    if (target) target.innerHTML = '<div class="data-state"><strong>Offers could not be loaded.</strong>Try again shortly or view the live market on Doji.</div>';
    if (status) status.textContent = 'Mezo testnet offers · temporarily unavailable';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  refreshDojiOffers();
  setInterval(refreshDojiOffers, REFRESH_MS);
});