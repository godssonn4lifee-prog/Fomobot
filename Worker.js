const BOT_NAME = "fomobott";

const JUPITER_API = "https://api.jup.ag";
const TOKENS_API = `${JUPITER_API}/tokens/v2`;
const PRICE_API = `${JUPITER_API}/price/v3`;

const TRENDING_URL = `${TOKENS_API}/toptrending/24h`;

const MAX_CANDIDATES = 10;

// FOMO scanner thresholds.
// These do NOT execute trades.
const MIN_LIQUIDITY_USD = 25000;
const MIN_VOLUME_24H_USD = 10000;
const MIN_PRICE_CHANGE_24H = 5;
const MIN_SCORE = 50;

const SCAN_KEY = "FOMO_LATEST_SCAN";
const HISTORY_KEY = "FOMO_SCAN_HISTORY";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/") {
        return json({
          ok: true,
          bot: BOT_NAME,
          mode: "SCAN_ONLY",
          live_trading: false,
          message: "Fomo scanner is running. No trades are executed."
        });
      }

      if (url.pathname === "/status") {
        return await getStatus(env);
      }

      if (url.pathname === "/scan") {
        const result = await runScan(env, "manual");
        return json(result);
      }

      return json({
        ok: false,
        error: "Not found",
        routes: ["/", "/status", "/scan"]
      }, 404);

    } catch (error) {
      console.error("REQUEST_ERROR", error);

      return json({
        ok: false,
        bot: BOT_NAME,
        error: error instanceof Error ? error.message : String(error)
      }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runScan(env, "cron")
        .then(result => console.log("FOMO_SCAN", JSON.stringify(result)))
        .catch(error => console.error("FOMO_CRON_ERROR", error))
    );
  }
};

async function runScan(env, source) {
  validateEnv(env);

  const tokens = await getTrendingTokens(env);

  const candidates = [];

  for (const token of tokens.slice(0, MAX_CANDIDATES)) {
    const candidate = await analyzeToken(token, env);

    if (!candidate) {
      continue;
    }

    if (candidate.score >= MIN_SCORE) {
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const result = {
    ok: true,
    bot: BOT_NAME,
    source,
    mode: "SCAN_ONLY",
    live_trading: false,
    scanned_at: new Date().toISOString(),
    trending_tokens_seen: Math.min(tokens.length, MAX_CANDIDATES),
    qualifying_candidates: candidates.length,
    thresholds: {
      min_liquidity_usd: MIN_LIQUIDITY_USD,
      min_volume_24h_usd: MIN_VOLUME_24H_USD,
      min_price_change_24h_percent: MIN_PRICE_CHANGE_24H,
      min_score: MIN_SCORE
    },
    candidates
  };

  await env.BOT_KV.put(
    SCAN_KEY,
    JSON.stringify(result)
  );

  await appendHistory(env, result);

  return result;
}

async function getTrendingTokens(env) {
  const response = await fetch(TRENDING_URL, {
    headers: {
      "x-api-key": env.JUPITER_API_KEY,
      "accept": "application/json"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Jupiter trending request failed: ${response.status} ${text.slice(0, 300)}`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Jupiter returned invalid JSON");
  }

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data.data)) {
    return data.data;
  }

  if (Array.isArray(data.tokens)) {
    return data.tokens;
  }

  return [];
}

async function analyzeToken(token, env) {
  const mint =
    token.address ||
    token.mint ||
    token.id ||
    token.tokenAddress;

  if (!mint) {
    return null;
  }

  const symbol =
    token.symbol ||
    token.ticker ||
    "UNKNOWN";

  const name =
    token.name ||
    "Unknown";

  const decimals = Number(
    token.decimals ?? 0
  );

  const liquidity =
    toNumber(
      token.liquidity ??
      token.liquidityUsd ??
      token.liquidity_usd
    );

  const volume24h =
    toNumber(
      token.volume24h ??
      token.volume24hUsd ??
      token.volume_24h ??
      token.volume
    );

  let priceChange24h =
    toNumber(
      token.priceChange24h ??
      token.priceChange24hPercent ??
      token.price_change_24h
    );

  let priceUsd =
    toNumber(
      token.price ??
      token.usdPrice ??
      token.priceUsd
    );

  // If the trending response does not contain price data,
  // ask Jupiter Price API for the current price.
  if (!priceUsd) {
    const priceData = await getPrice(env, mint);

    if (priceData) {
      priceUsd = priceData.price;
    }
  }

  // Some Jupiter responses expose volume/liquidity under nested stats.
  const stats = token.stats || token.metrics || {};

  const finalLiquidity =
    liquidity ||
    toNumber(
      stats.liquidity ??
      stats.liquidityUsd
    );

  const finalVolume24h =
    volume24h ||
    toNumber(
      stats.volume24h ??
      stats.volume24hUsd
    );

  if (!priceChange24h) {
    priceChange24h =
      toNumber(
        stats.priceChange24h ??
        stats.priceChange24hPercent
      );
  }

  // Basic FOMO filters.
  if (
    finalLiquidity > 0 &&
    finalLiquidity < MIN_LIQUIDITY_USD
  ) {
    return null;
  }

  if (
    finalVolume24h > 0 &&
    finalVolume24h < MIN_VOLUME_24H_USD
  ) {
    return null;
  }

  if (
    priceChange24h > 0 &&
    priceChange24h < MIN_PRICE_CHANGE_24H
  ) {
    return null;
  }

  const score = calculateScore({
    priceChange24h,
    volume24h: finalVolume24h,
    liquidity: finalLiquidity
  });

  return {
    mint,
    symbol,
    name,
    decimals,
    price_usd: priceUsd || null,
    price_change_24h_percent: round(priceChange24h),
    volume_24h_usd: round(finalVolume24h),
    liquidity_usd: round(finalLiquidity),
    score,
    signal: score >= 70
      ? "STRONG_FOMO"
      : score >= MIN_SCORE
        ? "FOMO"
        : "WEAK"
  };
}

async function getPrice(env, mint) {
  const url =
    `${PRICE_API}?ids=${encodeURIComponent(mint)}`;

  const response = await fetch(url, {
    headers: {
      "x-api-key": env.JUPITER_API_KEY,
      "accept": "application/json"
    }
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();

  const item =
    data?.data?.[mint] ||
    data?.[mint];

  if (!item) {
    return null;
  }

  const price = toNumber(item.price);

  if (!price) {
    return null;
  }

  return {
    price
  };
}

function calculateScore({
  priceChange24h,
  volume24h,
  liquidity
}) {
  let score = 0;

  // Momentum: up to 40 points.
  if (priceChange24h >= 5) score += 10;
  if (priceChange24h >= 10) score += 10;
  if (priceChange24h >= 20) score += 10;
  if (priceChange24h >= 40) score += 10;

  // Volume: up to 30 points.
  if (volume24h >= 10000) score += 10;
  if (volume24h >= 50000) score += 10;
  if (volume24h >= 250000) score += 10;

  // Liquidity: up to 30 points.
  if (liquidity >= 25000) score += 10;
  if (liquidity >= 100000) score += 10;
  if (liquidity >= 500000) score += 10;

  return Math.min(score, 100);
}

async function getStatus(env) {
  validateEnv(env);

  const raw = await env.BOT_KV.get(SCAN_KEY);

  if (!raw) {
    return {
      ok: true,
      bot: BOT_NAME,
      mode: "SCAN_ONLY",
      live_trading: false,
      message: "No scan has completed yet."
    };
  }

  let scan;

  try {
    scan = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      bot: BOT_NAME,
      error: "Stored scan data is invalid."
    };
  }

  return scan;
}

async function appendHistory(env, result) {
  let history = [];

  const existing = await env.BOT_KV.get(HISTORY_KEY);

  if (existing) {
    try {
      history = JSON.parse(existing);

      if (!Array.isArray(history)) {
        history = [];
      }
    } catch {
      history = [];
    }
  }

  history.unshift({
    scanned_at: result.scanned_at,
    qualifying_candidates: result.qualifying_candidates,
    candidates: result.candidates
  });

  // Keep only the latest 20 scans.
  history = history.slice(0, 20);

  await env.BOT_KV.put(
    HISTORY_KEY,
    JSON.stringify(history)
  );
}

function validateEnv(env) {
  if (!env.BOT_KV) {
    throw new Error("Missing BOT_KV KV binding");
  }

  if (!env.JUPITER_API_KEY) {
    throw new Error("Missing JUPITER_API_KEY");
  }
}

function toNumber(value) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : 0;
}

function round(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Number(value.toFixed(4));
}

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type": "application/json; charset=UTF-8"
      }
    }
  );
}
