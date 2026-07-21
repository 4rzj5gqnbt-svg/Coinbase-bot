// Indicator math over an array of candles (oldest-first), each
// { time, open, high, low, close, volume }.

function sma(candles, period, field = "close") {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const sum = slice.reduce((acc, c) => acc + c[field], 0);
  return sum / period;
}

// Simple SMA of SMA values, used to gauge whether the 50MA is rising
// (a stand-in for "trend strength" since that's not a precisely defined
// term — see README for this and other documented simplifications).
function isMovingAverageRising(candles, period, lookback = 5) {
  if (candles.length < period + lookback) return false;
  const now = sma(candles, period);
  const prior = sma(candles.slice(0, candles.length - lookback), period);
  return now !== null && prior !== null && now > prior;
}

// Wilder's RSI(14) — standard formula.
function rsi(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const closes = candles.map((c) => c.close);
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Average True Range over `period` candles.
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trueRanges = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
    trueRanges.push(tr);
  }
  return trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
}

function averageVolume(candles, period = 20) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  return slice.reduce((acc, c) => acc + c.volume, 0) / period;
}

// Highest high / lowest low over the last N candles BEFORE the current one
// (excludes the most recent candle so "breakout" is measured against
// prior structure, not itself).
function recentResistance(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-(period + 1), -1);
  return Math.max(...slice.map((c) => c.high));
}

function recentSupport(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-(period + 1), -1);
  return Math.min(...slice.map((c) => c.low));
}

module.exports = {
  sma,
  isMovingAverageRising,
  rsi,
  atr,
  averageVolume,
  recentResistance,
  recentSupport,
};
